import { describe, test, expect } from "vitest";
import { deviceRows, decidePopoverToggle, type DeviceLike } from "../src/device-picker.js";

const mics: DeviceLike[] = [
  { name: "MacBook Pro Microphone", uid: "builtin-mic" },
  { name: "AirPods Pro", uid: "airpods" },
];

describe("deviceRows — the mic shape (no automatic row)", () => {
  test("off, then every device, none selected but off when nothing is chosen", () => {
    const rows = deviceRows({
      devices: mics, current: { kind: "off" }, offLabel: "Off", staleLabel: "Mic (not connected)",
    });
    expect(rows.map((r) => r.label)).toEqual(["Off", "MacBook Pro Microphone", "AirPods Pro"]);
    expect(rows.map((r) => r.selected)).toEqual([true, false, false]);
  });

  test("a connected device is marked selected, off is not", () => {
    const rows = deviceRows({
      devices: mics, current: { kind: "device", uid: "airpods" },
      offLabel: "Off", staleLabel: "Mic (not connected)",
    });
    expect(rows.find((r) => r.label === "AirPods Pro")?.selected).toBe(true);
    expect(rows.find((r) => r.label === "Off")?.selected).toBe(false);
  });

  test("a stale uid gets its own row, selected, appended after the real devices", () => {
    const rows = deviceRows({
      devices: mics, current: { kind: "device", uid: "gone" },
      offLabel: "Off", staleLabel: "Mic (not connected)",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "Off", "MacBook Pro Microphone", "AirPods Pro", "Mic (not connected)",
    ]);
    expect(rows[3]?.selected).toBe(true);
    expect(rows[3]?.choice).toEqual({ kind: "device", uid: "gone" });
  });

  test("no automatic row exists at all when autoLabel is omitted", () => {
    const rows = deviceRows({
      devices: mics, current: { kind: "off" }, offLabel: "Off", staleLabel: "Mic (not connected)",
    });
    expect(rows.some((r) => r.choice.kind === "auto")).toBe(false);
  });

  test("no devices at all is just the off row", () => {
    const rows = deviceRows({
      devices: [], current: { kind: "off" }, offLabel: "Off", staleLabel: "Mic (not connected)",
    });
    expect(rows).toEqual([{ choice: { kind: "off" }, label: "Off", selected: true }]);
  });
});

const cameras: DeviceLike[] = [
  { name: "FaceTime HD Camera", uid: "facetime" },
  { name: "Elgato Virtual Camera", uid: "elgato-virtual" },
];

describe("deviceRows — the camera shape (off, automatic, then devices)", () => {
  test("automatic sits between off and the device list", () => {
    const rows = deviceRows({
      devices: cameras, current: { kind: "auto" },
      offLabel: "Off", autoLabel: "Automatic", staleLabel: "Camera (not connected)",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "Off", "Automatic", "FaceTime HD Camera", "Elgato Virtual Camera",
    ]);
    expect(rows.map((r) => r.selected)).toEqual([false, true, false, false]);
  });

  test("picking a named device is distinguishable from automatic", () => {
    const rows = deviceRows({
      devices: cameras, current: { kind: "device", uid: "facetime" },
      offLabel: "Off", autoLabel: "Automatic", staleLabel: "Camera (not connected)",
    });
    expect(rows.find((r) => r.choice.kind === "auto")?.selected).toBe(false);
    expect(rows.find((r) => r.label === "FaceTime HD Camera")?.selected).toBe(true);
  });

  test("off beats everything else when the camera is off, even with a device uid stored", () => {
    // Mirrors Settings: `camera: false` with a leftover `cameraDeviceUid` — the
    // uid is still there for next time, but the picker must show Off, not the
    // device, while the camera itself is switched off.
    const rows = deviceRows({
      devices: cameras, current: { kind: "off" },
      offLabel: "Off", autoLabel: "Automatic", staleLabel: "Camera (not connected)",
    });
    expect(rows.find((r) => r.label === "Off")?.selected).toBe(true);
    expect(rows.every((r) => r.label !== "FaceTime HD Camera" || !r.selected)).toBe(true);
  });
});

describe("decidePopoverToggle", () => {
  test("clicking a trigger with nothing open, opens it", () => {
    expect(decidePopoverToggle(null, "mic")).toBe("mic");
  });

  test("clicking the open one again closes it", () => {
    expect(decidePopoverToggle("mic", "mic")).toBeNull();
  });

  test("clicking the other one switches — never two open at once", () => {
    expect(decidePopoverToggle("mic", "camera")).toBe("camera");
  });
});

import { micMenuRows, cameraMenuRows, applyMenuPick, MENU_LABELS, type DeviceSelection } from "../src/device-picker.js";

const sel = (over: Partial<DeviceSelection> = {}): DeviceSelection =>
  ({ micDeviceUid: null, systemAudio: false, camera: false, cameraDeviceUid: null, ...over });
const micsTest = [{ name: "Elgato Wave:3", uid: "wave" }, { name: "iPhone Microphone", uid: "iphone" }];
const camsTest = [{ name: "Elgato Facecam 4k", uid: "facecam" }, { name: "Camera 2", uid: "cam2" }];

describe("micMenuRows (STC-456)", () => {
  test("system audio, then Mute External, then every device — the design's order", () => {
    expect(micMenuRows(micsTest, sel()).map((r) => r.label)).toEqual(
      [MENU_LABELS.systemAudio, MENU_LABELS.muteExternal, "Elgato Wave:3", "iPhone Microphone"]);
  });
  test("system audio and the mic are checked INDEPENDENTLY — two checks can show at once", () => {
    const rows = micMenuRows(micsTest, sel({ systemAudio: true, micDeviceUid: "wave" }));
    expect(rows.filter((r) => r.checked).map((r) => r.label)).toEqual([MENU_LABELS.systemAudio, "Elgato Wave:3"]);
  });
  test("no mic chosen checks Mute External", () => {
    expect(micMenuRows(micsTest, sel()).find((r) => r.checked)?.label).toBe(MENU_LABELS.muteExternal);
  });
  test("toggling system audio keeps the menu open; picking a mic closes it", () => {
    const rows = micMenuRows(micsTest, sel());
    expect(rows[0]!.closesMenu).toBe(false);
    expect(rows.slice(1).every((r) => r.closesMenu)).toBe(true);
  });
  test("icons: laptop for system audio, mic-off for mute, mic for devices", () => {
    expect(micMenuRows(micsTest, sel()).map((r) => r.icon)).toEqual(["system-audio", "mic-off", "mic", "mic"]);
  });
  test("a stale mic uid shows as itself, checked", () => {
    const rows = micMenuRows(micsTest, sel({ micDeviceUid: "gone" }));
    expect(rows.at(-1)).toMatchObject({ label: MENU_LABELS.stale, checked: true });
  });
  test("keys are unique, so the DOM can find a row by key", () => {
    const keys = micMenuRows(micsTest, sel({ micDeviceUid: "gone" })).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  // STC-456 fix round, Finding 1: a Mac mini/Studio with no mic attached (or
  // a stalled enumeration — `devicesForBar` returning `mics: []`) must still
  // be able to reach Include System Audio and Mute External. The mic trigger
  // is ALWAYS enabled (`controlEnabled` no longer even takes a mic list) and
  // this is the menu it opens: exactly the toggle plus the one "off" row,
  // no device rows and no crash on an empty list.
  test("with zero mics, the menu is still exactly System Audio + Mute External", () => {
    const rows = micMenuRows([], sel());
    expect(rows.map((r) => r.label)).toEqual([MENU_LABELS.systemAudio, MENU_LABELS.muteExternal]);
    expect(rows).toHaveLength(2);
  });
});

describe("cameraMenuRows (STC-456)", () => {
  test("No Camera, Automatic, then every device", () => {
    expect(cameraMenuRows(camsTest, sel()).map((r) => r.label)).toEqual(
      [MENU_LABELS.noCamera, MENU_LABELS.autoCamera, "Elgato Facecam 4k", "Camera 2"]);
  });
  test("camera off checks No Camera even with a device uid stored", () => {
    const rows = cameraMenuRows(camsTest, sel({ camera: false, cameraDeviceUid: "facecam" }));
    expect(rows.filter((r) => r.checked).map((r) => r.label)).toEqual([MENU_LABELS.noCamera]);
  });
  test("camera on with a uid checks that device", () => {
    const rows = cameraMenuRows(camsTest, sel({ camera: true, cameraDeviceUid: "facecam" }));
    expect(rows.find((r) => r.checked)?.label).toBe("Elgato Facecam 4k");
  });
  test("a stored camera that is gone shows as itself, checked (Review Focus 5)", () => {
    const rows = cameraMenuRows(camsTest, sel({ camera: true, cameraDeviceUid: "gone" }));
    expect(rows.at(-1)).toMatchObject({ label: MENU_LABELS.stale, checked: true });
  });
  test("every camera row closes the menu", () => {
    expect(cameraMenuRows(camsTest, sel()).every((r) => r.closesMenu)).toBe(true);
  });
});

describe("applyMenuPick (STC-456)", () => {
  test("toggle-system-audio flips ONLY systemAudio (Review Focus 4)", () => {
    expect(applyMenuPick(sel({ micDeviceUid: "wave" }), { kind: "toggle-system-audio" }))
      .toEqual(sel({ micDeviceUid: "wave", systemAudio: true }));
  });
  test("a mic pick sets the uid and leaves system audio alone", () => {
    const s = applyMenuPick(sel({ systemAudio: true }), { kind: "choice", menu: "mic", choice: { kind: "device", uid: "wave" } });
    expect(s).toEqual(sel({ systemAudio: true, micDeviceUid: "wave" }));
  });
  test("off from the MIC menu clears the mic; it does not turn the camera off", () => {
    const s = applyMenuPick(sel({ camera: true, micDeviceUid: "wave" }), { kind: "choice", menu: "mic", choice: { kind: "off" } });
    expect(s).toEqual(sel({ camera: true }));
  });
  test("off from the CAMERA menu turns the camera off and keeps the uid", () => {
    const s = applyMenuPick(sel({ camera: true, cameraDeviceUid: "facecam" }),
      { kind: "choice", menu: "camera", choice: { kind: "off" } });
    expect(s).toEqual(sel({ camera: false, cameraDeviceUid: "facecam" }));
  });
  test("a camera device pick turns the camera ON and sets the uid", () => {
    expect(applyMenuPick(sel(), { kind: "choice", menu: "camera", choice: { kind: "device", uid: "cam2" } }))
      .toEqual(sel({ camera: true, cameraDeviceUid: "cam2" }));
  });
  test("Automatic turns the camera on with a null uid (the helper's pickCamera ranking)", () => {
    expect(applyMenuPick(sel({ cameraDeviceUid: "cam2" }), { kind: "choice", menu: "camera", choice: { kind: "auto" } }))
      .toEqual(sel({ camera: true, cameraDeviceUid: null }));
  });
});
