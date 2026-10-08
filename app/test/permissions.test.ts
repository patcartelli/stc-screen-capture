import { describe, test, expect } from "vitest";
import {
  blocksCapture, parsePermissions, permissionsState, remember,
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
    expect(s).toEqual({ needed: false, rows: [] });
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
