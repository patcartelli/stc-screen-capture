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
 *
 * STC-456 made this the ONE row model for the bar's menus AND the main
 * window's popover: `MenuRow`, `micMenuRows`, `cameraMenuRows` and
 * `applyMenuPick` handle both surfaces, so UI changes land in one place.
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

export const MENU_LABELS = {
  systemAudio: "Include System Audio",
  muteExternal: "Mute External",
  noCamera: "No Camera",
  autoCamera: "Automatic",
  stale: "(not connected)",
} as const;

export type MenuIcon = "system-audio" | "mic" | "mic-off" | "camera" | "camera-off";
export type MenuPick =
  | { kind: "toggle-system-audio" }
  | { kind: "choice"; menu: "mic" | "camera"; choice: DeviceChoice };
export interface MenuRow {
  /** Stable and unique within one menu: what the DOM row carries as data-key. */
  key: string;
  pick: MenuPick;
  label: string;
  icon: MenuIcon;
  checked: boolean;
  /** A toggle keeps the menu open; a choice closes it. */
  closesMenu: boolean;
}
export interface DeviceSelection {
  micDeviceUid: string | null;
  systemAudio: boolean;
  camera: boolean;
  cameraDeviceUid: string | null;
}

const keyOf = (c: DeviceChoice): string => (c.kind === "device" ? `device:${c.uid}` : c.kind);

export function micMenuRows(mics: DeviceLike[], s: DeviceSelection): MenuRow[] {
  const current: DeviceChoice = s.micDeviceUid == null ? { kind: "off" } : { kind: "device", uid: s.micDeviceUid };
  const choices = deviceRows({ devices: mics, current, offLabel: MENU_LABELS.muteExternal, staleLabel: MENU_LABELS.stale });
  return [
    { key: "system-audio", pick: { kind: "toggle-system-audio" }, label: MENU_LABELS.systemAudio,
      icon: "system-audio", checked: s.systemAudio, closesMenu: false },
    ...choices.map((r): MenuRow => ({
      key: keyOf(r.choice), pick: { kind: "choice", menu: "mic", choice: r.choice }, label: r.label,
      icon: r.choice.kind === "off" ? "mic-off" : "mic", checked: r.selected, closesMenu: true,
    })),
  ];
}

export function cameraMenuRows(cameras: DeviceLike[], s: DeviceSelection): MenuRow[] {
  const current: DeviceChoice = !s.camera ? { kind: "off" }
    : s.cameraDeviceUid == null ? { kind: "auto" } : { kind: "device", uid: s.cameraDeviceUid };
  return deviceRows({ devices: cameras, current, offLabel: MENU_LABELS.noCamera,
                      autoLabel: MENU_LABELS.autoCamera, staleLabel: MENU_LABELS.stale })
    .map((r): MenuRow => ({
      key: keyOf(r.choice), pick: { kind: "choice", menu: "camera", choice: r.choice }, label: r.label,
      icon: r.choice.kind === "off" ? "camera-off" : "camera", checked: r.selected, closesMenu: true,
    }));
}

/** What a row press does to the selection: the ONE place, for both surfaces. */
export function applyMenuPick(s: DeviceSelection, pick: MenuPick): DeviceSelection {
  if (pick.kind === "toggle-system-audio") return { ...s, systemAudio: !s.systemAudio };
  const c = pick.choice;
  if (pick.menu === "mic") return { ...s, micDeviceUid: c.kind === "device" ? c.uid : null };
  if (c.kind === "off") return { ...s, camera: false };
  return { ...s, camera: true, cameraDeviceUid: c.kind === "device" ? c.uid : null };
}
