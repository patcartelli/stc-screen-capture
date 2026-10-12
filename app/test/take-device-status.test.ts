import { describe, test, expect } from "vitest";
import { TakeDeviceReports, OPENING_LABEL, OFF_LABEL } from "../src/take-device-status.js";

describe("TakeDeviceReports (STC-526)", () => {
  test("nothing heard yet: a requested device opens, an unrequested one is off", () => {
    const r = new TakeDeviceReports();
    expect(r.placeholder("camera", true)).toBe(OPENING_LABEL);
    expect(r.placeholder("mic", false)).toBe(OFF_LABEL);
  });

  test("a report that lands before the reset keeps its row", () => {
    // The order that stuck the row at "opening…": failure first, reset second.
    const r = new TakeDeviceReports();
    r.report("camera");
    expect(r.placeholder("camera", true)).toBeUndefined();
  });

  test("one device's report does not protect the other's row", () => {
    const r = new TakeDeviceReports();
    r.report("camera");
    expect(r.placeholder("mic", true)).toBe(OPENING_LABEL);
  });

  test("the idle label cannot replace a report either, but may once the take is over", () => {
    // Record broadcasts settings:changed, whose idle redraw can land after an
    // early failure and before this window knows the take has started.
    const r = new TakeDeviceReports();
    expect(r.mayShowIdle("camera")).toBe(true);
    r.report("camera");
    expect(r.mayShowIdle("camera")).toBe(false);
    expect(r.mayShowIdle("mic")).toBe(true);
    r.newTake();
    expect(r.mayShowIdle("camera")).toBe(true);
  });

  test("a new take forgets the last one's reports", () => {
    const r = new TakeDeviceReports();
    r.report("camera");
    r.report("mic");
    r.newTake();
    expect(r.placeholder("camera", true)).toBe(OPENING_LABEL);
    expect(r.placeholder("mic", true)).toBe(OPENING_LABEL);
  });
});
