/**
 * Who touched the tray last (STC-624).
 *
 * CI's Electron 43.4.1 has crashed twice during an e2e quit in
 *
 *     uv__run_timers -> (JS) -> electron::api::Tray::SetContextMenu
 *       -> TrayIconCocoa::SetContextMenu   [statusItemView_ setMenuController:]
 *          SIGSEGV at 0x10: the status-item view is already freed
 *
 * i.e. a JS timer rebuilt the menu of a `Tray` that still reported alive. By
 * reading the code nothing should be able to: `runQuitTeardown` destroys the
 * tray before any await, `reconcileIcons` returns once `quitting`, and
 * `TrayHandle.update` checks `isDestroyed()`. The crash stack cannot name the
 * JS caller, so every create, menu rebuild and destroy is logged with its
 * wall-clock time (comparable to the `.ips` report's `captureTime`) and the
 * functions that called it. The last `[tray]` line before a crash says which
 * path it was and whether the quit had committed yet.
 *
 * Lines go to stderr with a `[tray]` prefix. `closeApp` and `watchWindowLog`
 * (app/test/_quit-fixture.ts) collect them with the `[window]` lines and print
 * them only for a crash, so a clean e2e run stays quiet. Logging only.
 *
 * Written with `fs.writeSync(2, …)`, not `console.error` (STC-624 triage,
 * docs/STC-624-TRIAGE.md). On macOS Node writes to a pipe ASYNCHRONOUSLY, and
 * the crash this log exists for happens in the same synchronous call as the
 * line that names it (`logTray("set-menu")` then `tray.setContextMenu`), so a
 * queued line can die with the process. Four class-B crashes showed no
 * `[tray]` line after the destroy, while the native stack proves a live Tray
 * had just been given a menu: that line, and probably a `create` before it,
 * were lost. A synchronous write is in the pipe before the next statement.
 */

import { writeSync } from "node:fs";

export type TrayEvent = "create" | "set-menu" | "destroy" | "skip-destroyed";

/** Bundled names that are this file's own plumbing, not a caller worth naming. */
const OWN_FRAMES = new Set(["trayLogLine", "logTray", "callersOf", "Error"]);

/**
 * The nearest `count` function names on a V8 stack, below the logger. An
 * anonymous frame is `<anon>`; a frame V8 prints without a name at all (a
 * bare `at file:line:col`) is skipped, since it says nothing a reader can use.
 */
export function callersOf(stack: string | undefined, count = 4): string[] {
  if (!stack) return [];
  const names: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s*at (?:async )?(.+?) \(/.exec(line);
    if (!m) continue;
    const name = m[1]!.replace(/^Object\./, "");
    if (OWN_FRAMES.has(name)) continue;
    names.push(name === "<anonymous>" ? "<anon>" : name);
    if (names.length >= count) break;
  }
  return names;
}

/** `[tray] 16:45:15.123 set-menu recording via update <- reconcileTrayRecording`. */
export function trayLogLine(event: TrayEvent, at: Date, callers: string[], detail = ""): string {
  const time = at.toISOString().slice(11, 23);
  return `[tray] ${time} ${event}${detail ? ` ${detail}` : ""}`
    + (callers.length ? ` via ${callers.join(" <- ")}` : "");
}

/**
 * One line to fd 2, synchronously. A full non-blocking pipe makes `writeSync`
 * throw `EAGAIN`; the line then goes through `console.error` instead, which
 * queues it — late beats lost, and a logger must never throw into the tray code.
 */
export function writeStderrSync(line: string): void {
  try { writeSync(2, `${line}\n`); } catch { console.error(line); }
}

export function logTray(event: TrayEvent, detail = "", write: (line: string) => void = writeStderrSync): void {
  write(trayLogLine(event, new Date(), callersOf(new Error().stack), detail));
}
