import { describe, test, expect } from "vitest";
import { buildRecordingProfileMenu } from "../src/recording-profile-menu.js";
import { RECORDING_PROFILES } from "@transform/recording-profile.js";

/**
 * The recording-profile picker's menu (STC-447), without a window. Same
 * position `thumbnail-menu.test.ts`/`tray-menu.test.ts` are in: nothing in
 * Electron reads a `Menu` back once popped up, so this is the only place its
 * contents can be checked.
 */

describe("buildRecordingProfileMenu", () => {
  test("'No profile' is always first", () => {
    const items = buildRecordingProfileMenu(null);
    expect(items[0]?.id).toBe("none");
    expect(items[0]?.label).toBe("No profile");
  });

  test("every built-in profile appears, in RECORDING_PROFILES order", () => {
    const ids = buildRecordingProfileMenu(null).map((i) => i.id);
    expect(ids).toEqual(["none", ...RECORDING_PROFILES.map((p) => p.id)]);
  });

  test("no selection checks 'No profile' and nothing else", () => {
    const items = buildRecordingProfileMenu(null);
    expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual(["none"]);
  });

  test("a selected profile checks exactly that item, and not 'No profile'", () => {
    for (const p of RECORDING_PROFILES) {
      const items = buildRecordingProfileMenu(p.id);
      expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual([p.id]);
    }
  });

  test("an unknown stored id checks nothing — same 'unknown falls to default' rule as everywhere else", () => {
    const items = buildRecordingProfileMenu("not-a-real-id");
    expect(items.some((i) => i.checked)).toBe(false);
  });

  test("every item has a non-empty label", () => {
    for (const item of buildRecordingProfileMenu(null)) expect(item.label).toBeTruthy();
  });
});
