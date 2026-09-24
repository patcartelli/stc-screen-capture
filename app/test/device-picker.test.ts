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
