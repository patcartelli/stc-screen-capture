/**
 * Whether the camera and mic rows may still be reset for a take (STC-526).
 * Pure: no DOM, no Electron, no clock.
 *
 * Each row shows "opening…" from the moment a take starts until the device
 * reports, then its name or its fault (STC-287, STC-233). The reset used to be
 * written unconditionally, after the start's reply and a settings round trip.
 * A device that reports quickly, a failure especially, can arrive BEFORE
 * either: the helper sends it right after `started`, and the start's reply
 * still has main's own work and two IPC hops ahead of it. The reset then wrote
 * "opening…" over the failure, and nothing after it corrected the row, so a
 * camera that never opened read as still opening for the whole take.
 *
 * So the rule is about what has happened, not about timing:
 *
 * 1. A device that has reported during this take keeps its row. The reset is a
 *    placeholder for "nothing heard yet", and once something is heard it is
 *    false.
 * 2. A take begins with nothing reported. `newTake()` is called when a take
 *    ends, and again just before this window asks for one, so a report can
 *    never be carried across into the next take by a window that started it.
 * 3. A take started elsewhere (hotkey, menu bar) is only learned of after the
 *    fact, so the only reset it gets is the end of the previous take. A report
 *    from the previous take that lands after its own end would be kept for
 *    that next take. Its row then shows the stale report instead of
 *    "opening…" until the new take's device reports, which overwrites it.
 *    That is accepted: the alternative, ignoring reports while idle, would
 *    throw away exactly the early report this module exists to keep.
 * 4. The idle label (what is CONFIGURED: "automatic", a device name, "off")
 *    obeys rule 1 too. It is guarded by `recording`, but this window sets
 *    `recording` only when the start's reply arrives, and Record itself
 *    writes the bar's options and broadcasts `settings:changed`, which ends in
 *    an idle redraw. That redraw can land after an early failure and before
 *    the reply, and used to replace "failed" with the device's name.
 */
export type TakeDevice = "camera" | "mic";

export const OPENING_LABEL = "opening…";
export const OFF_LABEL = "off";

export class TakeDeviceReports {
  private readonly reported = new Set<TakeDevice>();

  /** A take ended, or this window is about to start one (rule 2). */
  newTake(): void { this.reported.clear(); }

  /** The device said something about this take: started, or a fault. */
  report(device: TakeDevice): void { this.reported.add(device); }

  /**
   * The row's per-take placeholder, or `undefined` when the row must be left
   * alone because the device already reported (rule 1).
   */
  placeholder(device: TakeDevice, requested: boolean): string | undefined {
    if (this.reported.has(device)) return undefined;
    return requested ? OPENING_LABEL : OFF_LABEL;
  }

  /** Whether the idle label may replace the row (rule 4). */
  mayShowIdle(device: TakeDevice): boolean {
    return !this.reported.has(device);
  }
}
