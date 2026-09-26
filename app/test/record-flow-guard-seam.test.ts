import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-465 review, items adjacent to STC-468: `runRecordFlow`, `onRecordHotkey`
 * and `recoverUnsavedTakes` are all reached `void`, fire-and-forget, from the
 * tray, a global hotkey, or `app.whenReady()` itself — none of those callers
 * has anything to catch a rejection, which is precisely an unhandled
 * rejection in the main process. `captureStill` already wraps its whole body
 * in a catch-all for exactly this reason; this is that same claim, checked
 * the way this repo checks a claim about SHAPE rather than about output —
 * `library-seam.test.ts`'s own idiom, with a CONTROL proving the pattern can
 * fail, not just a pattern that happens to match today.
 *
 * A behavioural test would need to force a rejection from deep inside
 * `openOverlay`/`micsForBar`/the dialog machinery with no fault-injection hook
 * that exists for this path today; adding one would be new product surface
 * for a hardening fix that is supposed to be small. The structural check is
 * what CLAUDE.md's own "no view branches on kind" precedent already uses for
 * exactly this situation.
 */

const repo = join(__dirname, "..", "..");
const src = readFileSync(join(repo, "app/src/main.ts"), "utf8");

/** Slice from a named function's declaration up to the next top-level one. */
function functionBody(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in app/src/main.ts`);
  const rest = src.slice(start + 1);
  const nextIdx = rest.search(/\n(?:async function |function |ipcMain\.handle\()/);
  const end = nextIdx === -1 ? src.length : start + 1 + nextIdx;
  return src.slice(start, end);
}

const CATCH_ALL = /}\s*catch\s*\(e[^)]*\)\s*\{/;

describe("record-flow guard seam (STC-468, adjacent to STC-466/467/468 bundle)", () => {
  test("runRecordFlow has its own catch-all, matching captureStill's", () => {
    const body = functionBody("runRecordFlow");
    expect(body).toMatch(CATCH_ALL);
    // Reports through the same RecordResult shape every other exit of this
    // function already uses, rather than letting the raw error escape.
    expect(body).toMatch(/record-flow-failed/);
    // Control: the shape this function had before this fix — a `try` with
    // only a `finally`, no `catch` at all. Recorded verbatim (git blame,
    // pre-STC-465-review) to prove the pattern above actually discriminates.
    const preFix = `
  recordFlowActive = true;
  try {
    let windows: WindowInfo[] = [];
    try {
      windows = windowsFromReply(await sup.listWindows());
    } catch {
    }
    const stored = readSettings(app.getPath("userData"));
    const mics = await micsForBar();
    return await recordFlowBody(source, stored, mics, windows);
  } finally {
    recordFlowActive = false;
  }
}`;
    expect(preFix).not.toMatch(CATCH_ALL);
  });

  test("onRecordHotkey has its own catch-all", () => {
    const body = functionBody("onRecordHotkey");
    expect(body).toMatch(CATCH_ALL);
    // The three things it can do (stop, cancel, start) are all still reachable
    // inside the guarded body — the fix must not have swallowed the function's
    // own behaviour along with its errors.
    expect(body).toMatch(/sup\.stopRecording\(\)/);
    expect(body).toMatch(/cancelCountdown\(\)/);
    expect(body).toMatch(/runRecordFlow\("hotkey"\)/);
    // Control: the pre-fix shape had no try/catch around the body at all.
    const preFix = `
async function onRecordHotkey(): Promise<void> {
  if (sup?.state === "recording") {
    await sup.stopRecording().catch((e) => console.error("[record] stop failed:", e));
    return;
  }
  if (recordFlowActive) {
    cancelCountdown();
    await closeOverlay().catch(() => {});
    return;
  }
  const r = await runRecordFlow("hotkey");
  if (!r.ok && !("cancelled" in r)) console.error(\`[record] \${r.code}\`, r.detail ?? "");
}`;
    expect(preFix).not.toMatch(CATCH_ALL);
  });

  test("recoverUnsavedTakes has its own catch-all around the dialog and the recovery loop", () => {
    const body = functionBody("recoverUnsavedTakes");
    expect(body).toMatch(CATCH_ALL);
    expect(body).toMatch(/dialog\.showMessageBox/);
    // Control: the pre-fix shape guarded only the purge/list calls with their
    // own `.catch`, and nothing wrapped the dialog or the recovery loop.
    const preFix = `
async function recoverUnsavedTakes(): Promise<void> {
  await purgeStaleTempTakes(process.env).catch((e) => {
    console.error("[temp-takes] purge failed:", e);
    return [];
  });
  const orphaned = await listTempTakes(process.env).catch((e) => {
    console.error("[temp-takes] could not list temp storage:", e);
    return [];
  });
  if (orphaned.length === 0) return;
  const { response } = await dialog.showMessageBox({
    type: "info",
  });
}`;
    expect(preFix).not.toMatch(CATCH_ALL);
  });
});
