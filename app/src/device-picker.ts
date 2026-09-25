/**
 * The mic and camera device popovers' pure decisions (STC-414) — no DOM.
 *
 * Both pickers show the same three kinds of row (off / automatic / a named
 * device) over the same kind of list (`Watchers.enumerateDevices`'s "mics"
 * or "cameras" shape), and both need the same "the app already showed this
 * uid to the user and it is gone now" placeholder `refreshMics` (STC-233)
 * used to build inline in `renderer.ts`. One implementation here, called
 * from both, rather than the mic's own copy plus a second one for camera —
 * this codebase's own "one place to get it" rule (`spaces.ts`, STC-314).
 *
 * `autoLabel` is what tells the two apart: the mic popover omits it (STC-233
 * forbids an automatic mic — there is no safe default), the camera popover
 * supplies one (`Settings.cameraDeviceUid`'s null IS automatic, unlike the
 * mic's). Passing or omitting `autoLabel` is a type-level fork, not a
 * runtime flag, so a call site cannot forget which kind of picker it is
 * building.
 */

export interface DeviceLike {
  name: string;
  uid: string;
}

export type DeviceChoice =
  | { kind: "off" }
  | { kind: "auto" }
  | { kind: "device"; uid: string };

export interface DeviceRow {
  choice: DeviceChoice;
  label: string;
  selected: boolean;
}

function sameChoice(a: DeviceChoice, b: DeviceChoice): boolean {
  if (a.kind !== "device" || b.kind !== "device") return a.kind === b.kind;
  return a.uid === b.uid;
}

export interface DeviceRowsOptions {
  devices: DeviceLike[];
  current: DeviceChoice;
  offLabel: string;
  /** Omit for a picker with no automatic fallback (mic — see this file's header). */
  autoLabel?: string;
  /** Shown for a `current` device uid no longer present in `devices`. */
  staleLabel: string;
}

/**
 * The rows a popover shows, in a fixed order: off, then automatic (if this
 * picker has one), then every currently connected device, then — only when
 * `current` names a device none of those are — one more row for it, marked
 * selected, so a stale choice is shown as itself rather than silently
 * falling back to "off" or vanishing from the list (`refreshMics`'s own
 * "(not connected)" behaviour, generalised).
 */
export function deviceRows(opts: DeviceRowsOptions): DeviceRow[] {
  const { devices, current, offLabel, autoLabel, staleLabel } = opts;
  const rows: DeviceRow[] = [
    { choice: { kind: "off" }, label: offLabel, selected: sameChoice(current, { kind: "off" }) },
  ];
  if (autoLabel != null) {
    rows.push({ choice: { kind: "auto" }, label: autoLabel, selected: sameChoice(current, { kind: "auto" }) });
  }
  for (const d of devices) {
    const choice: DeviceChoice = { kind: "device", uid: d.uid };
    rows.push({ choice, label: d.name, selected: sameChoice(current, choice) });
  }
  if (current.kind === "device" && !devices.some((d) => d.uid === current.uid)) {
    rows.push({ choice: current, label: staleLabel, selected: true });
  }
  return rows;
}

export type PopoverId = "mic" | "camera";

/**
 * Which popover (if any) should be open after a trigger is clicked. Clicking
 * the one already open closes it; clicking the other switches — never two
 * open at once, since both anchor into the same `#devicestate` row and a
 * second popover would either overlap the first or have to move it.
 *
 * Closing on a selection, Escape, or an outside click is not decided here:
 * each of those is unconditionally "close", which needs no function to get
 * right — this only exists for the one case with more than one possible
 * answer.
 */
export function decidePopoverToggle(current: PopoverId | null, clicked: PopoverId): PopoverId | null {
  return current === clicked ? null : clicked;
}
