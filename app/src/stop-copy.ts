/**
 * What a take's stop says to a person, on the pill, the panel and in the library
 * (STC-505's copy table). ONE mapping from `anchors.stop` to words, so no two surfaces
 * describe the same stop two ways.
 *
 * STC-530 filled in `recorder-quit`. STC-531 adds every stop the HELPER decides on by
 * itself — the source went away, the disk filled — as a pill label, a panel line and, for
 * a full disk, one action.
 *
 * Screen Recording turned off mid-take is NOT a stop and has no row: measured on the
 * packaged app (Patrick, 2026-10-14), macOS keeps delivering frames to a running stream
 * after the grant is revoked (57 fps, no gap, to the user's own Stop) and only offers
 * "Quit & Reopen / Later". Quit ends the take through the ordinary quit path. Those stops no longer get a
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
export type StopActionId = "reclaim-space";

export interface StopAction { id: StopActionId; label: string }

interface StopRow {
  /** On the pill for `PILL_STOPPED_DWELL_MS`. 14 characters or fewer (spec: German runs ~30% longer). */
  pill: string;
  /** The panel line's middle sentence, between "Stopped at m:ss." and the saved-claim. */
  cause: string;
  /** The library note's `<cause>`: "Stopped early: <lib> at m:ss" (STC-529). Lower-case, no full stop. */
  lib: string;
  action?: StopAction;
}

/**
 * Every stop the helper decides on by itself (a dead stream in `main.swift`,
 * `DisplayChangeDecisions.swift`, `DiskDecisions.swift`, the window watcher). A stop the
 * user asked for (`user`, `quit`, `stdin-closed`, `signal-N`) has no row: nothing went
 * wrong, so there is nothing to say.
 *
 * `stream-stopped` and `error` are not in the spec's table; they are the two helper stops
 * it does not name, and without the toast they would otherwise say nothing.
 */
const ROWS: Record<string, StopRow> = {
  "disk-full": {
    pill: "Disk full", cause: "Your disk is full.", lib: "disk full",
    action: { id: "reclaim-space", label: "Reclaim space" },
  },
  "window-closed": { pill: "Window closed", cause: "The window you were recording was closed.", lib: "window closed" },
  "window-resized": { pill: "Window resized", cause: "The window you were recording was resized.", lib: "window resized" },
  // Since STC-235 a display mode change refits; this is reached only when the captured
  // display is gone (`decideDisplayChange`), so it reads as the spec's "Display lost".
  "display-reconfigured": { pill: "Display lost", cause: "The display you were recording was disconnected.", lib: "display disconnected" },
  // The spec's "Display changed" is 15 characters, over its own 14-character ceiling. This
  // reason only ever ends an AREA take whose area no longer fits the changed display
  // (STC-235), so the label names that instead.
  "region-out-of-bounds": {
    pill: "Area lost", cause: "The display settings changed and the area you were recording no longer fits.",
    lib: "display changed",
  },
  "stream-stopped": { pill: "Source lost", cause: "The screen capture stopped unexpectedly.", lib: "capture source lost" },
  "error": { pill: "Write failed", cause: "The recording could not be written to disk.", lib: "write failed" },
};

/** Every reason with a row — what the test walks against the helper's own list. */
export const HELPER_STOP_REASONS: readonly string[] = Object.keys(ROWS);

/**
 * The helper's `warning` codes that only ANNOUNCE one of the stops above: it sends one
 * of these and then stops the take itself, with the reason in the comment. The renderer
 * shows every other warning as a toast; these it must not, or the stop is said three
 * times (warning toast, pill, panel). Seen on hardware 2026-10-14: a resized window got
 * "The recorder reported a problem: window-resized-during-recording" on top of the panel.
 *
 * `stream-stopped` is also sent when the stream dies while a take is STARTING; that take
 * is refused through the start reply (`refusals.ts`), so silencing the warning loses nothing.
 */
export const STOP_ANNOUNCING_WARNINGS: ReadonlySet<string> = new Set([
  "window-resized-during-recording", // -> window-resized
  "window-closed-during-recording", // -> window-closed
  "stream-stopped", // -> stream-stopped
  "disk-full", // -> disk-full
  "writer-failed", // -> error
]);

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
  return x === "reclaim-space";
}

/**
 * STC-237: a mic or camera (STC-542: or system audio) that went away while the take KEPT recording. Not a stop, so
 * not in `ROWS`. The helper's warning for it is no longer a toast (Patrick, 2026-10-14,
 * the same ruling as `STOP_ANNOUNCING_WARNINGS`): the pill shows `pill` for
 * `PILL_STOPPED_DWELL_MS` while the take goes on, and the panel says it afterwards from the
 * take's own `endedBy` (`trackLossLine`). Labels obey the same 14-character ceiling.
 */
const TRACK_LOSS: Record<string, { pill: string }> = {
  "mic-disconnected": { pill: "Mic lost" },
  "mic-format-mismatch": { pill: "Mic lost" },
  "camera-disconnected": { pill: "Camera lost" },
  // STC-562: camera.mp4's writer failed mid-take; the take kept recording without the
  // camera. Not `camera-writer-failed`, which is the writer failing to START (no track at
  // all, a toast like the camera's other open failures).
  "camera-track-failed": { pill: "Camera lost" },
  // STC-542: the system-audio stream died; the take kept recording without it.
  "system-audio-stopped": { pill: "System lost" },
};

/** The helper warnings that announce a lost track. The renderer must not toast these. */
export const TRACK_LOSS_WARNINGS: ReadonlySet<string> = new Set(Object.keys(TRACK_LOSS));

/** The pill's label for a track lost mid-take, or undefined for any other warning. */
export function trackLossPillLabel(code: string): string | undefined {
  return Object.hasOwn(TRACK_LOSS, code) ? TRACK_LOSS[code]!.pill : undefined;
}

/** The part of an anchors document `trackLossLine` reads. */
export interface TrackBlocks {
  mic?: { present?: boolean; endedBy?: string; lastFramePtsNs?: number };
  camera?: { present?: boolean; endedBy?: string; lastFramePtsNs?: number };
  system?: { present?: boolean; endedBy?: string; lastFramePtsNs?: number };
}

/**
 * The panel's sentence for every track that ended before the take did (anchors-12's
 * `endedBy`, at the track's own `lastFramePtsNs`), or undefined when none did. Says what
 * the rest of the take lacks, because that is what the person will notice on playback.
 */
export function trackLossLine(anchors: TrackBlocks | undefined): string | undefined {
  const lines: string[] = [];
  const at = (b: { lastFramePtsNs?: number }) =>
    typeof b.lastFramePtsNs === "number" ? ` at ${formatTakeTime(b.lastFramePtsNs)}` : "";
  const mic = anchors?.mic;
  if (mic?.present === true && mic.endedBy !== undefined) {
    const what = mic.endedBy === "format-mismatch" ? "The mic stopped sending usable audio" : "The mic disconnected";
    lines.push(`${what}${at(mic)}, so the rest of the take has no mic audio.`);
  }
  const cam = anchors?.camera;
  if (cam?.present === true && cam.endedBy !== undefined) {
    const what = cam.endedBy === "writer-failed" ? "The camera could not be recorded" : "The camera disconnected";
    lines.push(`${what}${at(cam)}, so the rest of the take has no camera.`);
  }
  const sys = anchors?.system;
  if (sys?.present === true && sys.endedBy !== undefined) {
    lines.push(`System audio stopped${at(sys)}, so the rest of the take has no system audio.`);
  }
  return lines.length > 0 ? lines.join(" ") : undefined;
}

/** The part of an anchors document `libraryNotes` reads for silence (anchors-13). */
export type SilentSpans = readonly { startNs: number; endNs: number }[] | undefined;

/** The two spans a note lists before "and N more" (spec: "first two, then and N more"). */
const SILENT_SPANS_LISTED = 2;

/**
 * The library's note for how a take stopped, or undefined when nothing needs saying: a
 * user-initiated stop has no row. `Stopped early: <cause> at m:ss` so a scan down the grid
 * reads the same way every time; without a time, `Stopped early: <cause>`.
 */
export function libraryNote(stop: StopBlock): string | undefined {
  if (stop?.reason === "recorder-quit") return "Recovered after the recorder quit. No cursor data.";
  const row = rowFor(stop);
  if (!row) return undefined;
  const at = typeof stop?.t === "number" ? ` at ${formatTakeTime(stop.t)}` : "";
  return `Stopped early: ${row.lib}${at}`;
}

/**
 * "No mic signal from 1:10 to 4:30", several spans listing the first two, then "and N more".
 * Spans arrive in order (anchors-13), so "first" is the earliest.
 */
export function silenceNote(spans: SilentSpans): string | undefined {
  if (!spans || spans.length === 0) return undefined;
  const listed = spans.slice(0, SILENT_SPANS_LISTED)
    .map((s) => `${formatTakeTime(s.startNs)} to ${formatTakeTime(s.endNs)}`);
  const more = spans.length - listed.length;
  const tail = more > 0 ? `, and ${more} more` : "";
  return `No mic signal from ${listed.join(more > 0 ? ", " : " and ")}${tail}`;
}
