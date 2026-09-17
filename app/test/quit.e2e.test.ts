import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";

/**
 * Quitting the app mid-take ends the take before the helper goes.
 *
 * Through the real app rather than the supervisor alone, because the defect
 * had two halves and the second lived in main.ts: `before-quit`'s listener was
 * async and Electron does not await one, so even a supervisor that stopped the
 * recording correctly would have been killed by the quit proceeding underneath
 * it. The stand-in logs every command it receives; the assertion is the ORDER.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("quitting while recording", () => {
  test("stops the recording, waits for the stop, then quits the helper", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "stc-cmdlog-")), "cmds.txt");
    const { dir: recordings } = makeTakeFolder();
    app = await electron.launch({
      args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
      cwd: root,
      env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER,
             // Slow enough that a quit which does not wait for the stop leaves
             // the process before the quit command is ever written.
             STC_FAKE_CMD_LOG: log, STC_FAKE_STOP_DELAY_MS: "1500",
             // Record now opens the real overlay (STC-388) — same reason
             // `still-overlay.e2e.test.ts` sets this: without it the
             // overlay's real DOM listeners install and race the flow
             // helper's own synthetic input.
             STC_OVERLAY_SYNTHETIC_INPUT: "1" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // STC-391: the subject here is the stop-before-quit ORDER, not the
    // countdown — which would otherwise put three seconds between the click
    // and the take, and a `start` in the log either way.
    await withoutCountdown(win);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await startRecordFlow(app!, win);
    await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");

    // Playwright's close() quits the app the way Cmd-Q does: through app.quit()
    // and the before-quit listener.
    await app.close();
    app = undefined;

    // The subject is the ORDER of the lifecycle: stop before quit. Enumeration
    // commands (`devices`, which the display picker issues when the helper
    // comes up — STC-247; `windows`, which `runRecordFlow` issues to list the
    // overlay's window-mode targets before it ever opens — STC-388) are not
    // part of that order and may land anywhere before the take, so they are
    // filtered rather than pinned.
    const lifecycle = readFileSync(log, "utf8").trim().split("\n")
      .filter((c) => c !== "devices" && c !== "windows");
    expect(lifecycle).toEqual(["start", "stop", "quit"]);
  }, 120_000);
});
