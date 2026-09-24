import { RECORDING_PROFILES } from "@transform/recording-profile.js";

/**
 * The recording-profile picker's menu (STC-447) — pure, same reasoning as
 * `thumbnail-menu.ts`/`tray-menu.ts`: nothing in Electron reads a `Menu`
 * back once it has been popped up, so a template built and checked here,
 * then handed to `Menu.buildFromTemplate` verbatim, is the only version of
 * this that can be tested at all.
 *
 * "No profile" is always first and always present — it is how a profile,
 * once picked, gets cleared, and the id `main.ts` maps back to `null` rather
 * than a fourth built-in `RecordingProfile`.
 */
export type RecordingProfileMenuId = "none" | (typeof RECORDING_PROFILES)[number]["id"];

export interface RecordingProfileMenuItem {
  id: RecordingProfileMenuId;
  label: string;
  checked: boolean;
}

export function buildRecordingProfileMenu(selectedId: string | null): RecordingProfileMenuItem[] {
  const items: RecordingProfileMenuItem[] = [
    { id: "none", label: "No profile", checked: selectedId == null },
  ];
  for (const p of RECORDING_PROFILES) {
    items.push({ id: p.id, label: p.label, checked: p.id === selectedId });
  }
  return items;
}
