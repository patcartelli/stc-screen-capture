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
    // Starts through `recordAndAnnounce` since the STC-465 data-loss fixes,
    // which reads the RecordResult and both logs and toasts a refusal.
    expect(body).toMatch(/recordAndAnnounce\("hotkey"\)/);
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

  // STC-466/467/468 review follow-up: runRecordFlow's own catch-all above
  // means a bare `void` tray call no longer risks an unhandled rejection, but
  // it ALSO means a failure there is only visible if the returned RecordResult
  // is inspected — the original fix dropped it on the floor with no logging
  // anywhere. Since the STC-465 data-loss fixes the tray goes through
  // `recordAndAnnounce`, which reads the result, logs it, and toasts the
  // refusal; the tray call itself keeps a `.catch` for anything thrown on the
  // way. Structural for the same reason as the others: reaching this from a
  // real tray click needs the click-driven fixtures this suite doesn't have.
  test("the tray's menu-bar record action logs a failed RecordResult, not just a bare void call", () => {
    const trayIdx = src.indexOf('recordAndAnnounce("menu-bar")');
    expect(trayIdx).toBeGreaterThan(-1);
    const surrounding = src.slice(trayIdx, trayIdx + 160);
    expect(surrounding).toMatch(/\.catch\(/);
    // ...and the function it calls actually reads and logs the answer.
    const body = functionBody("recordAndAnnounce");
    expect(body).toMatch(/await runRecordFlow\(source\)/);
    expect(body).toMatch(/console\.error/);
    // Control: the pre-fix shape — a bare `void` call with no `.then`, so a
    // failed RecordResult was returned and never read.
    const preFix = `
    if (action === "record") {
      if (sup?.state === "recording") { void onRecordHotkey(); return; }
      void runRecordFlow("menu-bar");
      return;
    }`;
    expect(preFix).not.toContain('recordAndAnnounce("menu-bar")');
    const preFixSlice = preFix.slice(preFix.indexOf('runRecordFlow("menu-bar")') - 40);
    expect(preFixSlice).not.toMatch(/\.then\(/);
  });
});
