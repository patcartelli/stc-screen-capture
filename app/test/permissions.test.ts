import { describe, test, expect } from "vitest";
import {
  blocksCapture, deviceGrantsPending, isGrant, isRowAction, parsePermissions, permissionsState, remember,
  shouldPrimeCapture,
  type PermissionsMemory, type PermissionsReport,
} from "../src/permissions.js";

const fresh: PermissionsMemory = { screenAtLaunch: null, requested: new Set() };
const report = (o: Partial<PermissionsReport> = {}): PermissionsReport =>
  ({ screenRecording: false, inputMonitoring: "unknown", ...o });
const at = (r: PermissionsReport, requested: string[] = []) =>
  permissionsState(r, { ...remember(fresh, r), requested: new Set(requested as any) });
const row = (s: ReturnType<typeof permissionsState>, g: string) => s.rows.find((r) => r.grant === g)!;

describe("parsePermissions", () => {
  test("accepts exactly the helper's reply", () => {
    expect(parsePermissions({ ev: "permissions", seq: 1, screenRecording: true, inputMonitoring: "denied" }))
      .toEqual({ screenRecording: true, inputMonitoring: "denied" });
  });
  test("refuses an error, a wrong event and a wrong field", () => {
    expect(parsePermissions({ ev: "error", code: "unknown-command" })).toBeNull();
    expect(parsePermissions({ ev: "status", screenRecording: true, inputMonitoring: "granted" })).toBeNull();
    expect(parsePermissions({ ev: "permissions", screenRecording: "yes", inputMonitoring: "granted" })).toBeNull();
    expect(parsePermissions({ ev: "permissions", screenRecording: true, inputMonitoring: "maybe" })).toBeNull();
    expect(parsePermissions(undefined)).toBeNull();
  });
});

describe("permissionsState", () => {
  test("everything granted at launch: no panel, nothing blocked", () => {
    const s = at(report({ screenRecording: true, inputMonitoring: "granted" }));
    expect(s.needed).toBe(false);
    expect(blocksCapture(s, "record")).toBe(false);
  });

  test("a clean install: both rows ask, Record and shots both blocked", () => {
    const s = at(report());
    expect(s.needed).toBe(true);
    expect(row(s, "screen-recording")).toMatchObject({ status: "not-yet", actions: ["request"] });
    expect(row(s, "input-monitoring")).toMatchObject({ status: "not-yet", actions: ["request"] });
    expect(blocksCapture(s, "record")).toBe(true);
    expect(blocksCapture(s, "still")).toBe(true);
  });

  test("a shot needs Screen Recording only", () => {
    const s = at(report({ screenRecording: true, inputMonitoring: "denied" }));
    expect(blocksCapture(s, "still")).toBe(false);
    expect(blocksCapture(s, "record")).toBe(true);
  });

  test("Screen Recording granted mid-run is RELAUNCH, never granted", () => {
    const m = remember(fresh, report());
    const s = permissionsState(report({ screenRecording: true, inputMonitoring: "granted" }), m);
    expect(row(s, "screen-recording")).toMatchObject({ status: "relaunch", actions: ["relaunch"] });
    expect(s.needed).toBe(true);
    expect(blocksCapture(s, "still")).toBe(true);
  });

  test("Screen Recording asked this run and still off: Settings and Relaunch both offered", () => {
    const s = at(report(), ["screen-recording"]);
    expect(row(s, "screen-recording")).toMatchObject({ status: "denied", actions: ["open-settings", "relaunch"] });
  });

  test("Input Monitoring 'denied' still offers Grant: a never-asked Mac reports denied (STC-518)", () => {
    const s = at(report({ inputMonitoring: "denied" }));
    expect(row(s, "input-monitoring")).toMatchObject({ status: "not-yet", actions: ["request"] });
  });

  test("Input Monitoring asked this run and still off: Settings first, Grant kept", () => {
    const s = at(report({ inputMonitoring: "denied" }), ["input-monitoring"]);
    expect(row(s, "input-monitoring")).toMatchObject({ status: "denied", actions: ["open-settings", "request"] });
  });

  test("an unreadable report is not a panel (an old helper fails open)", () => {
    const s = permissionsState(null, fresh);
    expect(s).toEqual({ needed: false, intro: "", rows: [] });
    expect(blocksCapture(s, "record")).toBe(false);
  });
});

describe("remember", () => {
  test("only the first readable report sets the launch state", () => {
    const m1 = remember(fresh, null);
    expect(m1.screenAtLaunch).toBeNull();
    const m2 = remember(m1, report({ screenRecording: false }));
    expect(m2.screenAtLaunch).toBe(false);
    expect(remember(m2, report({ screenRecording: true })).screenAtLaunch).toBe(false);
  });
});

describe("microphone and camera rows (STC-520 rule 9)", () => {
  const granted = report({ screenRecording: true, inputMonitoring: "granted" });
  const withAv = (o: Partial<PermissionsReport>, wanted: { microphone: boolean; camera: boolean }, requested: string[] = []) => {
    const r = { ...granted, ...o };
    return permissionsState(r, { ...remember(fresh, r), requested: new Set(requested as any) }, wanted);
  };
  const none = { microphone: false, camera: false };

  test("no device chosen: no row, however the status reads", () => {
    const s = withAv({ microphone: "denied", camera: "notDetermined" }, none);
    expect(s.rows.map((r) => r.grant)).toEqual(["screen-recording", "input-monitoring"]);
    expect(s.needed).toBe(false);
  });

  test("a chosen mic never asked about: Grant, and Don't use; Record waits, a shot does not", () => {
    const s = withAv({ microphone: "notDetermined" }, { microphone: true, camera: false });
    expect(row(s, "microphone")).toMatchObject({ status: "not-yet", actions: ["request", "turn-off"] });
    expect(s.needed).toBe(true);
    expect(blocksCapture(s, "record")).toBe(true);
    expect(blocksCapture(s, "still")).toBe(false);
    expect(deviceGrantsPending(s)).toEqual(["microphone"]);
  });

  test("a chosen camera that is denied: Settings and Don't use, never a second Grant", () => {
    const s = withAv({ camera: "denied" }, { microphone: false, camera: true });
    expect(row(s, "camera")).toMatchObject({ status: "denied", actions: ["open-settings", "turn-off"] });
  });

  test("asked this run and refused: the same as denied", () => {
    const s = withAv({ microphone: "notDetermined" }, { microphone: true, camera: false }, ["microphone"]);
    expect(row(s, "microphone").actions).toEqual(["open-settings", "turn-off"]);
  });

  test("restricted can only be turned off", () => {
    const s = withAv({ camera: "restricted" }, { microphone: false, camera: true });
    expect(row(s, "camera").actions).toEqual(["turn-off"]);
  });

  test("authorized devices add granted rows and no panel", () => {
    const s = withAv({ microphone: "authorized", camera: "authorized" }, { microphone: true, camera: true });
    expect(s.needed).toBe(false);
    expect(blocksCapture(s, "record")).toBe(false);
    expect(deviceGrantsPending(s)).toEqual([]);
  });

  test("an old helper that reports neither: a chosen device shows no row (fails open)", () => {
    const s = withAv({}, { microphone: true, camera: true });
    expect(s.rows).toHaveLength(2);
    expect(s.needed).toBe(false);
  });

  test("the intro counts what is asked", () => {
    expect(withAv({}, none).intro).toMatch(/two macOS permissions/);
    expect(withAv({ microphone: "notDetermined" }, { microphone: true, camera: false }).intro).toMatch(/microphone or camera/);
    const both = permissionsState(report({ microphone: "notDetermined" }), fresh, { microphone: true, camera: false });
    expect(both.intro).toMatch(/these macOS permissions/);
  });

  test("the report parser takes the new fields and refuses a bad one", () => {
    expect(parsePermissions({ ev: "permissions", screenRecording: true, inputMonitoring: "granted",
      microphone: "authorized", camera: "notDetermined" }))
      .toEqual({ screenRecording: true, inputMonitoring: "granted", microphone: "authorized", camera: "notDetermined" });
    expect(parsePermissions({ ev: "permissions", screenRecording: true, inputMonitoring: "granted", camera: "maybe" })).toBeNull();
  });

  test("the new grant and action names pass the IPC guards; junk does not", () => {
    expect(isGrant("microphone") && isGrant("camera")).toBe(true);
    expect(isRowAction("turn-off")).toBe(true);
    expect(isGrant("location")).toBe(false);
  });
});

describe("shouldPrimeCapture (rule 8, STC-522)", () => {
  const granted = report({ screenRecording: true });
  const launchedGranted = remember(fresh, granted);

  test("granted at launch and never primed: prime", () => {
    expect(shouldPrimeCapture(granted, launchedGranted, false)).toBe(true);
  });

  test("already primed on this Mac: never again", () => {
    expect(shouldPrimeCapture(granted, launchedGranted, true)).toBe(false);
  });

  test("a grant that arrived during this run waits for the relaunch", () => {
    const launchedDenied = remember(fresh, report({ screenRecording: false }));
    expect(shouldPrimeCapture(granted, launchedDenied, false)).toBe(false);
  });

  test("no Screen Recording, or no readable report: nothing to prime", () => {
    expect(shouldPrimeCapture(report(), remember(fresh, report()), false)).toBe(false);
    expect(shouldPrimeCapture(null, fresh, false)).toBe(false);
  });

  test("Input Monitoring does not matter: the consent is Screen Recording's", () => {
    const r = report({ screenRecording: true, inputMonitoring: "denied" });
    expect(shouldPrimeCapture(r, remember(fresh, r), false)).toBe(true);
  });
});
