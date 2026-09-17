import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";

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
             STC_FAKE_CMD_LOG: log, STC_FAKE_STOP_DELAY_MS: "1500" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // STC-391: the subject here is the stop-before-quit ORDER, not the
    // countdown — which would otherwise put three seconds between the click
    // and the take, and a `start` in the log either way.
    await withoutCountdown(win);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");

    // Playwright's close() quits the app the way Cmd-Q does: through app.quit()
    // and the before-quit listener.
    await app.close();
    app = undefined;

    // The subject is the ORDER of the lifecycle: stop before quit. Enumeration
    // commands (`devices`, which the display picker issues when the helper
    // comes up — STC-247) are not part of that order and may land anywhere
    // before the take, so they are filtered rather than pinned.
    const lifecycle = readFileSync(log, "utf8").trim().split("\n").filter((c) => c !== "devices");
    expect(lifecycle).toEqual(["start", "stop", "quit"]);
  }, 120_000);
});

/**
 * Quitting with takes nobody has decided on (STC-392 D8, Task 5c).
 *
 * `quit-guard.test.ts` proves the DECISION with no window and no OS; this
 * proves the WIRING — that a real quit really shows the dialog `main.ts`
 * builds, that the three buttons really do what the spec says, and that
 * "Quit Anyway deletes nothing" (ruling 3) holds against the teardown path
 * that actually runs rather than against a description of it.
 *
 * The dialog stub follows `crash-recovery.e2e.test.ts`'s pattern (`app
 * .evaluate` replacing `dialog.showMessageBox`, counted in the MAIN process)
 * but not its TIMING note — that file's dialog fires automatically at
 * `app.whenReady()` and has to be stubbed before `firstWindow()`. This one
 * fires only once a person (or this test) asks to quit, well after the
 * window exists, so it is stubbed right before that, the same as
 * `manage.e2e.test.ts`'s delete-confirmation stub.
 */
describe("quitting with unhandled takes (STC-392 D8)", () => {
  // electron.launch and waitForSelector are Playwright's own 30 s defaults;
  // POLL_MS is every explicit `{ timeout: ... }` below. A declared timeout
  // that does not exceed the sum of its own internal bounds is the trap
  // `bc9faaf` exists to prevent (CLAUDE.md's "Reading CI, and the machine").
  const PLAYWRIGHT_LAUNCH_OVERHEAD_MS = 60_000;
  const POLL_MS = 15_000;

  async function launchWithHelper(): Promise<{ win: Page; recordings: string; temp: string }> {
    const { dir: recordings } = makeTakeFolder();
    const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
    app = await electron.launch({
      args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
      cwd: root,
      env: {
        ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
        STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
      },
    });
    const win = await app.firstWindow();
    await win.waitForSelector("#capturestill");
    return { win, recordings, temp };
  }

  /** The same door STC-392's own thumbnail e2e suite uses — no overlay to drive. */
  async function captureDisplay(win: Page): Promise<{ ok: boolean }> {
    return win.evaluate(() => (window as any).recorder.captureStill("display"));
  }

  async function panelCount(): Promise<number> {
    return app!.windows().filter((p) => p.url().includes("thumbnail.html")).length;
  }

  /** Take directory names actually kept in the library, excluding the fixture `makeTakeFolder` seeds. */
  const libraryTakes = (recordings: string): string[] =>
    readdirSync(recordings).filter((n) => n !== "2026-08-24_10-00-00");

  const tempTakes = (temp: string): string[] => (existsSync(temp) ? readdirSync(temp) : []);

  /**
   * Stub the quit dialog, counting calls AND recording the last call's
   * arguments — both read back from the MAIN process (STC-393's own
   * pattern for a dialog stub).
   */
  async function stubQuitDialog(
    response: 0 | 1 | 2,
  ): Promise<{ calls: () => Promise<number>; lastArgs: () => Promise<any> }> {
    await app!.evaluate(({ dialog }, resp) => {
      (globalThis as any).__quitDialogCalls = 0;
      (globalThis as any).__quitDialogArgs = undefined;
      dialog.showMessageBox = (async (opts: unknown) => {
        (globalThis as any).__quitDialogCalls++;
        (globalThis as any).__quitDialogArgs = opts;
        return { response: resp, checkboxChecked: false };
      }) as any;
    }, response);
    return {
      calls: () => app!.evaluate(() => (globalThis as any).__quitDialogCalls ?? 0),
      lastArgs: () => app!.evaluate(() => (globalThis as any).__quitDialogArgs),
    };
  }

  test("Cancel is the default AND the escape route — nothing moves and the app keeps running", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const { calls, lastArgs } = await stubQuitDialog(2); // Cancel is buttons[2].

    // The same trigger `app.close()` uses (see this file's own header note),
    // driven directly rather than through `.close()`: a cancelled quit never
    // makes the process exit, and `.close()` waits for exactly that.
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    try {
      await expect.poll(() => calls(), { timeout: POLL_MS }).toBe(1);

      // Ruling 1, checked structurally rather than by driving a real Escape
      // keypress against a stubbed (so non-native) dialog: Cancel is BOTH
      // `defaultId` and `cancelId`, at the same index the buttons array
      // actually names "Cancel" — the three cannot quietly drift apart.
      const args = await lastArgs();
      expect(args.buttons).toEqual(["Save All", "Quit Anyway", "Cancel"]);
      expect(args.defaultId).toBe(2);
      expect(args.cancelId).toBe(2);

      // Nothing moved: the panel is still up, the take is still the one and
      // only thing in temp storage, and the library has gained nothing.
      expect(await panelCount()).toBe(1);
      expect(tempTakes(temp).length).toBe(1);
      expect(libraryTakes(recordings)).toEqual([]);
    } finally {
      // Leave the app somewhere `afterEach`'s own `app.close()` can finish
      // from, whether this test's own assertions passed or not — an
      // assertion thrown above must not leak the process into every OTHER
      // test in this file.
      await stubQuitDialog(1);
    }
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + 60_000);

  test("a reopened LIBRARY take does not count as unhandled — no dialog, a plain quit", async () => {
    // `unsavedTakeDirs` (thumbnail-window.ts) filters to `origin: "fresh"`
    // on purpose: a panel from `still:reopen` (STC-294) is already on disk
    // with nothing to promote, so a panel being open is not by itself
    // "something to lose". This is the one test in the file that opens a
    // panel WITHOUT going through `captureDisplay` — a fresh capture can
    // only ever be `origin: "fresh"`, so a reopen is the only door to the
    // other case.
    const { win, recordings } = await launchWithHelper();
    const { takeDir } = makeStillFolder("2026-09-08_12-00-00", { into: recordings });
    await win.evaluate((dir) => (window as any).recorder.reopenStill(dir), takeDir);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);

    // A file-based log, not `stubQuitDialog`'s `globalThis` counter: the
    // whole point of this test is that the app quits WITHOUT ever pausing
    // at a dialog, so there is no reliable moment before the process exits
    // to read an in-process counter back out through `app.evaluate`.
    const dialogLog = join(mkdtempSync(join(tmpdir(), "stc-quitdialog-")), "calls.txt");
    await app!.evaluate(({ dialog }, logPath) => {
      // `process.getBuiltinModule`, not `require` or `import()`: this repo's
      // own trap (CLAUDE.md) — vitest's SSR transform rewrites a dynamic
      // import inside `evaluate()` into something that does not exist in
      // the process this code actually ships to, and Playwright's own
      // evaluate context has no `require` at all.
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
      // Answers Quit Anyway if it is ever somehow reached, so a wrongly
      // shown dialog does not also hang the test waiting on Cancel/Save.
      dialog.showMessageBox = (async () => {
        fs.appendFileSync(logPath, "called\n");
        return { response: 1, checkboxChecked: false };
      }) as any;
    }, dialogLog);

    await app!.close();
    app = undefined;

    expect(existsSync(dialogLog) ? readFileSync(dialogLog, "utf8") : "").toBe("");
    // Untouched either way — Copy/Trash are this panel's only actions
    // (`panel-actions.ts`), and neither was pressed.
    expect(existsSync(takeDir)).toBe(true);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + POLL_MS + 60_000);

  test("Quit Anyway deletes nothing — the take stays in temp storage and the app quits", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const before = tempTakes(temp);
    expect(before.length).toBe(1);
    const { calls } = await stubQuitDialog(1); // Quit Anyway is buttons[1].

    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => calls(), { timeout: POLL_MS }).toBe(1);
    // `.close()` now just waits for the exit that response already set in
    // motion — `quitting` is true by the time it runs, so its own
    // `before-quit` is a same-tick no-op, never a second dialog.
    await app!.close();
    app = undefined;

    // Exactly where `capture-still` wrote it. Ruling 3, checked against the
    // teardown that actually ran rather than against `dismissNow`'s doc
    // comment: `closeThumbnail`/`closeOverlay`/`sup.shutdown` never call
    // `rm`, `unlink` or the Trash on this path.
    expect(existsSync(join(temp, before[0]!))).toBe(true);
    expect(libraryTakes(recordings)).toEqual([]);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + 60_000);

  test("Save All promotes every unsaved take into the library, then quits", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const r2 = await captureDisplay(win);
    expect(r2.ok).toBe(true);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(2);
    expect(tempTakes(temp).length).toBe(2);

    const { calls } = await stubQuitDialog(0); // Save All is buttons[0].
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => calls(), { timeout: POLL_MS }).toBe(1);
    await app!.close();
    app = undefined;

    // Both promoted — temp storage empty, the library gained exactly two.
    expect(tempTakes(temp)).toEqual([]);
    expect(libraryTakes(recordings).length).toBe(2);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 3 * POLL_MS + 60_000);

  test("Save All must not trap the user: a promote failure is reported and the quit still completes (ruling 2)", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const before = tempTakes(temp);
    expect(before.length).toBe(1);

    // Read-only AFTER the app has already started — startup only needs to
    // READ the library root, so this does not stop the app coming up, only
    // `promoteTake`'s `rename` once Save All reaches it. `rename` needs
    // write permission on the DESTINATION directory, so `r-x` reproduces
    // the shape of a real failure (a full disk, a permissions problem) more
    // faithfully than skipping the call ever could.
    chmodSync(recordings, 0o500);
    const { calls } = await stubQuitDialog(0); // Save All is buttons[0].
    try {
      await app!.evaluate(({ app: electronApp }) => electronApp.quit());
      await expect.poll(() => calls(), { timeout: POLL_MS }).toBe(1);
      // The point of this test: a trap would leave `quitting` never set and
      // `app.quit()` never called a second time, so `.close()` would wait
      // out its own timeout rather than resolve. This awaiting successfully
      // at all, inside the test's own declared bound, IS the assertion.
      await app!.close();
      app = undefined;
    } finally {
      // However the test ends, leave the fixture writable — it is a fresh
      // mkdtemp per test, but a future cleanup pass over the OS temp
      // directory should not have to fight a read-only leftover.
      chmodSync(recordings, 0o700);
    }

    // The failed promote left the take exactly where it started — the same
    // backstop Quit Anyway relies on, reached from the other direction.
    expect(existsSync(join(temp, before[0]!))).toBe(true);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + 60_000);

  /**
   * STC-392 Task 6's two quit-path interactions, both against the real quit
   * flow rather than reasoned about: a promised deletion must not inflate
   * the warning or be resurrected by Save All (ruling 2), and quitting must
   * KEEP the promise rather than abandon it in temp storage (ruling 1).
   */
  test("a promised deletion (Task 6) is not counted as unhandled, and Save All does not resurrect it", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    const r1: any = await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const r2: any = await captureDisplay(win);
    expect(r2.ok).toBe(true);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(2);
    expect(tempTakes(temp).length).toBe(2);

    // Trash the FIRST capture — promised, not committed. The panel it was
    // pressed from is matched by its own `dir` query param
    // (`crash-recovery.e2e.test.ts`'s own pattern for telling panels apart).
    const dir1 = r1.dir as string;
    const panel1 = app!.windows().find((p) =>
      p.url().includes("thumbnail.html") && new URL(p.url()).searchParams.get("dir") === dir1)!;
    await panel1.click("#trash");
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    // Still in temp — only promised, well inside the 8s undo window.
    expect(tempTakes(temp).length).toBe(2);

    const { calls, lastArgs } = await stubQuitDialog(0); // Save All is buttons[0].
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => calls(), { timeout: POLL_MS }).toBe(1);
    // ONE take counted, not two — ruling 2's whole point. Counting the
    // promised one would have read "2 takes aren't saved" here.
    expect((await lastArgs()).message).toBe("1 take isn't saved");

    await app!.close();
    app = undefined;

    // Save All promoted the ONE real unsaved take. The promised deletion was
    // never in its list, so it was never resurrected into the library —
    // exactly the failure ruling 2 exists to prevent.
    expect(libraryTakes(recordings).length).toBe(1);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 3 * POLL_MS + 60_000);

  test("quitting commits every outstanding promised deletion before it exits (Task 6 ruling 1)", async () => {
    const { win, recordings, temp } = await launchWithHelper();
    await captureDisplay(win);
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(1);
    const before = tempTakes(temp);
    expect(before.length).toBe(1);

    const panel = app!.windows().find((p) => p.url().includes("thumbnail.html"))!;
    await panel.click("#trash");
    await expect.poll(() => panelCount(), { timeout: POLL_MS }).toBe(0);
    // Still there — only promised, well inside the 8s undo window. If the
    // quit below relied on the periodic sweep alone (rather than committing
    // `pendingTrash.all()` itself), this take would still be here when the
    // process exits.
    expect(tempTakes(temp)).toEqual(before);

    // No unhandled takes left (ruling 2 excludes the promised one) — a plain
    // quit, no dialog. Same file-log pattern as "a reopened LIBRARY take does
    // not count as unhandled" above: the whole point of this test is that
    // the app quits with nothing left to read an in-process counter back out
    // of, so a stubbed dialog's calls are logged to a file instead.
    const dialogLog = join(mkdtempSync(join(tmpdir(), "stc-quitdialog-")), "calls.txt");
    await app!.evaluate(({ dialog }, logPath) => {
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
      // Answers Quit Anyway if it is ever somehow reached, so a wrongly
      // shown dialog does not also hang the test.
      dialog.showMessageBox = (async () => {
        fs.appendFileSync(logPath, "called\n");
        return { response: 1, checkboxChecked: false };
      }) as any;
    }, dialogLog);

    await app!.close();
    app = undefined;

    expect(existsSync(dialogLog) ? readFileSync(dialogLog, "utf8") : "").toBe("");
    // Ruling 1: the promise was KEPT before the process went, not abandoned
    // — the take is gone from temp storage even though the 8s window never
    // naturally elapsed.
    expect(existsSync(join(temp, before[0]!))).toBe(false);
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + 60_000);
});
