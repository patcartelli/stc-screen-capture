import type { Anchors, SessionEvent } from "./types.js";
import { frameIndexAt } from "./time.js";
import { geometryAt } from "./display-geometry.js";
import { onDisplay } from "./spaces.js";
import { ZOOM_LEAD_NS } from "./zoom.js";

/**
 * Which presses are clicks ON THE RECORDING (STC-654, STC-674).
 *
 * The event tap records every click on the machine, wherever it lands. Two
 * kinds are not part of what the take shows, and both used to open an
 * auto-zoom and draw a click highlight:
 *
 * 1. **A press that began outside the capture** (STC-654): on another
 *    display, or beside a recorded area or window. Stage 2 mapped it to
 *    capture UV outside 0..1 and slid the crop to the nearest corner.
 * 2. **A press that began within `ZOOM_LEAD_NS` of `stop.t`** (STC-674): the
 *    click that stopped the take, on the pill or the menu bar. A window opens
 *    `ZOOM_LEAD_NS` before its trigger, so this one could only ever start a
 *    zoom the take ends inside. ⇧⌘5 stops with no click, so in practice the
 *    only press that late IS the stop.
 *
 * `loadSession` is the ONE caller, so `session.events` never carries either
 * and every reader agrees: `zoomWindows`, the cursor's `pressed`, the editor's
 * lanes. Nothing downstream asks where a click landed.
 *
 * ## What "dropped" means
 *
 * A dropped `down` and the `up` that closes it become `move`s at the same
 * time and place. The pointer's path is therefore exactly what it was (a
 * button event is also a position sample for the spring); only the press is
 * gone, and with it the trigger and the highlight. The moves between them are
 * no longer held, so `zoomWindows` reads them as plain motion.
 *
 * A press is judged ONCE, where its `down` landed: a drag that starts on the
 * recording and leaves it is kept whole, one that starts off it is dropped
 * whole. Judging each event alone would keep a `down` and lose its `up`, and
 * the cursor would stay pressed for the rest of the take.
 *
 * "Outside" is asked of the display the take captured at that moment:
 * `geometryAt`'s `shown` (the scope's region or window on the display of the
 * frame on screen, STC-471/STC-235), after `stabiliseEvents` has taken a
 * moved window's displacement out (STC-482). No rect is built here.
 *
 * ## What this does not catch
 *
 * A click on Capture's own pill that is NOT the stop (a missed press, a drag
 * to move it) while the pill sits over the recorded area. The transform cannot
 * know where the pill was; that needs the helper to drop the click at capture
 * (STC-674's other half).
 *
 * Returns the very array it was given when nothing is dropped, so a take with
 * no such press renders exactly what it did before.
 */
export function clicksOnTheRecording(
  anchors: Anchors, events: readonly SessionEvent[], frames: readonly number[],
): readonly SessionEvent[] {
  const stopT = anchors.stop?.t;
  const lateAfter = typeof stopT === "number" ? stopT - ZOOM_LEAD_NS : Infinity;

  const order = events.map((_, i) => i).sort((a, b) => events[a]!.t - events[b]!.t);
  /** Dropped presses still held, per button. */
  const droppedOpen = new Map<number, number>();
  let out: SessionEvent[] | undefined;

  for (const i of order) {
    const e = events[i]!;
    if (e.kind !== "down" && e.kind !== "up") continue;
    const held = droppedOpen.get(e.button) ?? 0;
    let drop: boolean;
    if (e.kind === "down") {
      drop = e.t > lateAfter || !onRecording(anchors, frames, e);
      if (drop) droppedOpen.set(e.button, held + 1);
    } else {
      drop = held > 0;
      if (drop) droppedOpen.set(e.button, held - 1);
    }
    if (drop) {
      out ??= [...events];
      out[i] = { t: e.t, kind: "move", x: e.x, y: e.y };
    }
  }
  return out ?? events;
}

function onRecording(anchors: Anchors, frames: readonly number[], e: { t: number; x: number; y: number }): boolean {
  const fi = frameIndexAt(frames, e.t);
  return onDisplay(e, geometryAt(anchors, fi === null ? null : frames[fi]!).shown);
}
