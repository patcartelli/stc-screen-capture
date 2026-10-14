/**
 * What a take's stop says to a person, on the pill, the panel and in the library
 * (STC-505's copy table). ONE mapping from `anchors.stop` to words, so no two surfaces
 * describe the same stop two ways.
 *
 * STC-530 filled in `recorder-quit`. STC-531 adds every stop the HELPER decides on by
 * itself — the source went away, the disk filled, Screen Recording was turned off — as a
 * pill label, a panel line and, for two of them, one action. Those stops no longer get a
 * toast (Patrick, 2026-10-14): the pill and the panel say it, and a third copy of the same
 * sentence was noise. So a helper stop with no row here would say NOTHING, which is why
 * `app/test/stop-copy.test.ts` walks every reason the helper can write and fails on a
 * missing one.
 *
 * STC-529 (library notes for an early stop) adds its rows to `libraryNote` rather than a
 * second path.
 *
 * `-timeout` (the writer did not finalise in time, sidecars written anyway) changes
 * nothing a person needs to know, so every function reads the reason through `baseReason`.
 *
 * Pure and node-free: `library-items.ts` (which the renderer typecheck pass follows) and
 * `renderer.ts` import it.
 */
export type StopBlock = { t?: number; reason?: string } | undefined;

/** The one action a stopped take's panel may offer. Main decides what each does. */
export type StopActionId = "reclaim-space" | "open-screen-recording-settings";

export interface StopAction { id: StopActionId; label: string }

interface StopRow {
  /** On the pill for `PILL_STOPPED_DWELL_MS`. 14 characters or fewer (spec: German runs ~30% longer). */
  pill: string;
  /** The panel line's middle sentence, between "Stopped at m:ss." and the saved-claim. */
  cause: string;
  action?: StopAction;
}

/**
 * Every stop the helper decides on by itself (`StreamStopDecisions.swift`,
 * `DisplayChangeDecisions.swift`, `DiskDecisions.swift`, the window watcher). A stop the
 * user asked for (`user`, `quit`, `stdin-closed`, `signal-N`) has no row: nothing went
 * wrong, so there is nothing to say.
 *
 * `stream-stopped` and `error` are not in the spec's table; they are the two helper stops
 * it does not name, and without the toast they would otherwise say nothing.
 */
const ROWS: Record<string, StopRow> = {
  "disk-full": {
    pill: "Disk full", cause: "Your disk is full.",
    action: { id: "reclaim-space", label: "Reclaim space" },
  },
  "window-closed": { pill: "Window closed", cause: "The window you were recording was closed." },
  "window-resized": { pill: "Window resized", cause: "The window you were recording was resized." },
  // Since STC-235 a display mode change refits; this is reached only when the captured
  // display is gone (`decideDisplayChange`), so it reads as the spec's "Display lost".
  "display-reconfigured": { pill: "Display lost", cause: "The display you were recording was disconnected." },
  // The spec's "Display changed" is 15 characters, over its own 14-character ceiling. This
  // reason only ever ends an AREA take whose area no longer fits the changed display
  // (STC-235), so the label names that instead.
  "region-out-of-bounds": {
    pill: "Area lost", cause: "The display settings changed and the area you were recording no longer fits.",
  },
  "screen-recording-revoked": {
    pill: "Access revoked", cause: "Screen Recording was turned off for Capture.",
    action: { id: "open-screen-recording-settings", label: "Open System Settings" },
  },
  "stream-stopped": { pill: "Source lost", cause: "The screen capture stopped unexpectedly." },
  "error": { pill: "Write failed", cause: "The recording could not be written to disk." },
};

/** Every reason with a row — what the test walks against the helper's own list. */
export const HELPER_STOP_REASONS: readonly string[] = Object.keys(ROWS);

const TIMEOUT = "-timeout";
function baseReason(reason: string | undefined): string | undefined {
  return reason?.endsWith(TIMEOUT) ? reason.slice(0, -TIMEOUT.length) : reason;
}

function rowFor(stop: StopBlock): StopRow | undefined {
  const r = baseReason(stop?.reason);
  return r !== undefined && Object.hasOwn(ROWS, r) ? ROWS[r] : undefined;
}

/**
 * The take clock as the spec writes it: `m:ss`, `h:mm:ss` from an hour. Unlike the pill's
 * running timer (`formatElapsedTimer`, `mm:ss`), a time inside a sentence has no leading
 * zero. Truncates, so "Stopped at 1:29" never names a second that was not recorded.
 */
export function formatTakeTime(ns: number): string {
  const total = Math.max(0, Math.floor(ns / 1_000_000_000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The pill's stopped label, or undefined for a stop that gets none (user, quit, a signal, recorder-quit). */
export function pillLabel(reason: string | undefined): string | undefined {
  return rowFor({ reason })?.pill;
}

export function panelReason(stop: StopBlock): string | undefined {
  if (stop?.reason === "recorder-quit") {
    return "Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.";
  }
  const row = rowFor(stop);
  if (!row) return undefined;
  // "Everything up to then is saved" wherever the take is kept (the spec's wording rule):
  // after a failure the fear is losing the take.
  const at = typeof stop?.t === "number" ? `Stopped at ${formatTakeTime(stop.t)}. ` : "Stopped early. ";
  return `${at}${row.cause} Everything up to then is saved.`;
}

export function panelAction(stop: StopBlock): StopAction | undefined {
  return rowFor(stop)?.action;
}

export function isStopActionId(x: unknown): x is StopActionId {
  return x === "reclaim-space" || x === "open-screen-recording-settings";
}

export function libraryNote(stop: StopBlock): string | undefined {
  switch (stop?.reason) {
    case "recorder-quit":
      return "Recovered after the recorder quit. No cursor data.";
    default:
      return undefined;
  }
}
