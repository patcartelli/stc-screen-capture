/**
 * What a recovered take records as `stop.reason` when it was finished from a `take-ended`
 * (STC-530): the supervisor's reason is the APP's vocabulary, the anchors' is the HELPER's.
 *
 * - `"stopped"` is the app's own word for a stop it asked for, which a take records as `user`.
 * - Anything anchors-11 already accepts (its enum, or `signal-N[-timeout]`) passes through
 *   unchanged, so `user-timeout` keeps its suffix and `disk-full` stays `disk-full`.
 * - Anything else (the supervisor's own `helper-idle` / `helper-stopped` fallbacks) is
 *   `error`, the reserved "ended for a reason the take cannot name" value.
 *
 * Pure and node-free. `app/test/take-stop-reason.test.ts` holds `ANCHORS_STOP_REASONS` and
 * `ANCHORS_SIGNAL_REASON` to `schema/anchors-11.schema.json`, so the two cannot drift.
 */
export const ANCHORS_STOP_REASONS: readonly string[] = [
  "user", "display-reconfigured", "stream-stopped", "stopped-during-start", "window-resized",
  "window-closed", "region-out-of-bounds", "device-lost", "error", "quit", "stdin-closed",
  "disk-full", "recorder-quit", "user-timeout", "display-reconfigured-timeout",
  "stream-stopped-timeout", "stopped-during-start-timeout", "window-resized-timeout",
  "window-closed-timeout", "region-out-of-bounds-timeout", "device-lost-timeout",
  "error-timeout", "quit-timeout", "stdin-closed-timeout", "disk-full-timeout",
];

/** anchors-11's `signal-N` alternative, verbatim. */
export const ANCHORS_SIGNAL_REASON = /^signal-[0-9]+(-timeout)?$/;

export function takeEndedStopReason(reason: unknown): string {
  if (reason === "stopped") return "user";
  if (typeof reason === "string" && (ANCHORS_STOP_REASONS.includes(reason) || ANCHORS_SIGNAL_REASON.test(reason))) {
    return reason;
  }
  return "error";
}
