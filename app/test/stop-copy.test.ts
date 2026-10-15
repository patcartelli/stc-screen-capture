import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  panelReason, panelAction, pillLabel, libraryNote, formatTakeTime, isStopActionId, HELPER_STOP_REASONS,
  STOP_ANNOUNCING_WARNINGS, TRACK_LOSS_WARNINGS, trackLossPillLabel, trackLossLine,
} from "../src/stop-copy.js";
import { recordingItem, type TakeInfo } from "../src/library-items.js";

const root = join(__dirname, "..", "..");
/** Every reason anchors-12 can carry, read from the schema so a new one is covered without an edit. */
const reasons: string[] = JSON.parse(readFileSync(join(root, "schema/anchors-12.schema.json"), "utf8"))
  .properties.stop.properties.reason.anyOf.flatMap((b: { enum?: string[] }) => b.enum ?? []);

/**
 * Every stop the helper decides on BY ITSELF, read from the Swift: the decision files'
 * `.stop("…")`, the window watcher's `onWindowChanged?("…")` and the refit's
 * `failRefit("…")`. These used to fall back to the toast's generic text; since STC-531 there
 * is no toast for them, so one without a row would be a stop that says nothing.
 */
function helperDecidedReasons(): string[] {
  const read = (f: string) => readFileSync(join(root, "helper/src", f), "utf8");
  const found = new Set<string>();
  for (const f of ["DisplayChangeDecisions.swift", "DiskDecisions.swift"]) {
    for (const m of read(f).matchAll(/\.stop\("([a-z-]+)"\)/g)) found.add(m[1]!);
  }
  for (const m of read("main.swift").matchAll(/self\.stop\(reason: "([a-z-]+)"\)/g)) found.add(m[1]!);
  const capture = read("Capture.swift");
  for (const m of capture.matchAll(/onWindowChanged\?\("([a-z-]+)"\)/g)) found.add(m[1]!);
  for (const m of capture.matchAll(/failRefit\("([a-z-]+)"\)/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("stop copy (STC-530, STC-531)", () => {
  test("recorder-quit has the spec's panel reason and library note", () => {
    const stop = { t: 1, reason: "recorder-quit" };
    expect(panelReason(stop)).toBe("Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.");
    expect(libraryNote(stop)).toBe("Recovered after the recorder quit. No cursor data.");
    expect(pillLabel("recorder-quit")).toBeUndefined();
    expect(panelAction(stop)).toBeUndefined();
  });

  test("the Swift search finds what it is looking for (a guard on the guard)", () => {
    expect(helperDecidedReasons()).toEqual(expect.arrayContaining([
      "disk-full", "error", "display-reconfigured", "region-out-of-bounds",
      "stream-stopped", "window-closed", "window-resized",
    ]));
  });

  test("ACCEPTANCE: every stop the helper decides on has a pill label, a panel line and is in the schema", () => {
    for (const r of helperDecidedReasons()) {
      expect(HELPER_STOP_REASONS, r).toContain(r);
      expect(reasons, r).toContain(r);
      for (const reason of [r, `${r}-timeout`]) {
        expect(pillLabel(reason), reason).toBeTruthy();
        expect(panelReason({ t: 90_000_000_000, reason }), reason).toMatch(/^Stopped at 1:30\. .+ Everything up to then is saved\.$/);
      }
    }
  });

  test("every warning the helper sends right before stopping a take is silenced (seen on hardware)", () => {
    // Read from the Swift: a warning sent and then, two lines on, a stop. The pairs the
    // window watcher and the writer use are named here; a new one must join the set.
    const capture = readFileSync(join(root, "helper/src/Capture.swift"), "utf8");
    for (const code of STOP_ANNOUNCING_WARNINGS) {
      expect(capture.includes(`"${code}"`), `${code} is not sent by Capture.swift any more`).toBe(true);
    }
    // The window watcher's warning-then-stop pairs, found rather than listed.
    const pairs = [...capture.matchAll(/IO\.send\("warning", \["code": "([a-z-]+)"[\s\S]{0,200}?onWindowChanged\?\("([a-z-]+)"\)/g)];
    expect(pairs.length, "the warning-then-stop pattern matches nothing").toBeGreaterThanOrEqual(2);
    for (const [, code, reason] of pairs) {
      expect(STOP_ANNOUNCING_WARNINGS.has(code!), code).toBe(true);
      expect(HELPER_STOP_REASONS, reason).toContain(reason);
    }
    // And it is not "silence everything": a warning about a take that keeps going still toasts
    // (a LOST track is the exception, and goes on the pill instead: TRACK_LOSS_WARNINGS, STC-237).
    for (const code of ["av-runtime-error", "camera-no-frames", "sidecar-write-failed"]) {
      expect(STOP_ANNOUNCING_WARNINGS.has(code), code).toBe(false);
    }
  });

  test("pill labels are 14 characters or fewer (the spec's English ceiling)", () => {
    for (const r of HELPER_STOP_REASONS) expect(pillLabel(r)!.length, r).toBeLessThanOrEqual(14);
  });

  test.each([
    ["disk-full", "Disk full", "Stopped at 4:12. Your disk is full. Everything up to then is saved."],
    ["window-closed", "Window closed", "Stopped at 4:12. The window you were recording was closed. Everything up to then is saved."],
    ["window-resized", "Window resized", "Stopped at 4:12. The window you were recording was resized. Everything up to then is saved."],
    ["display-reconfigured", "Display lost", "Stopped at 4:12. The display you were recording was disconnected. Everything up to then is saved."],
    // The spec's "Display changed" is over its own 14-character ceiling; see stop-copy.ts.
    ["region-out-of-bounds", "Area lost", "Stopped at 4:12. The display settings changed and the area you were recording no longer fits. Everything up to then is saved."],
  ])("%s: the spec's pill label and panel line", (reason, pill, line) => {
    expect(pillLabel(reason)).toBe(pill);
    expect(panelReason({ t: 252_400_000_000, reason })).toBe(line);
  });

  test("the two actions, and no others", () => {
    expect(panelAction({ t: 1, reason: "disk-full" })).toEqual({ id: "reclaim-space", label: "Reclaim space" });
    expect(panelAction({ t: 1, reason: "disk-full-timeout" })?.id).toBe("reclaim-space");
    const withAction = reasons.filter((r) => panelAction({ t: 1, reason: r }));
    expect(withAction.sort()).toEqual(
      ["disk-full", "disk-full-timeout"]);
    expect(isStopActionId("reclaim-space")).toBe(true);
    expect(isStopActionId("open-screen-recording-settings")).toBe(false);
    expect(isStopActionId("open-input-monitoring-settings")).toBe(false);
  });

  test("a stop the user asked for says nothing", () => {
    for (const reason of ["user", "quit", "stdin-closed", "user-timeout", "signal-15", "stopped-during-start"]) {
      expect(pillLabel(reason), reason).toBeUndefined();
      expect(panelReason({ t: 1, reason }), reason).toBeUndefined();
      expect(panelAction({ t: 1, reason }), reason).toBeUndefined();
    }
    expect(panelReason(undefined)).toBeUndefined();
    expect(pillLabel(undefined)).toBeUndefined();
    // Not an own key: a reason that happens to name an Object.prototype member.
    expect(pillLabel("constructor")).toBeUndefined();
  });

  test("a stop with no time still says what happened", () => {
    expect(panelReason({ reason: "window-closed" }))
      .toBe("Stopped early. The window you were recording was closed. Everything up to then is saved.");
  });

  test.each([
    [0, "0:00"], [999_999_999, "0:00"], [59_999_999_999, "0:59"], [60_000_000_000, "1:00"],
    [3_599_000_000_000, "59:59"], [3_600_000_000_000, "1:00:00"], [3_725_000_000_000, "1:02:05"], [-5, "0:00"],
  ])("formatTakeTime(%d) = %s", (ns, want) => {
    expect(formatTakeTime(ns)).toBe(want);
  });

  test("library notes are still only recorder-quit's (STC-529 adds the rest)", () => {
    for (const reason of reasons.filter((r) => r !== "recorder-quit")) {
      expect(libraryNote({ t: 1, reason }), reason).toBeUndefined();
    }
    expect(libraryNote({})).toBeUndefined();
  });

  const aTake = (): TakeInfo => ({
    dir: "/x/take", name: "take", recordedAt: 0, durationMs: 1000,
    width: 10, height: 10, events: 0, bytes: 1,
  });

  test("a recovered recording carries the library note", () => {
    const item = recordingItem({ ...aTake(), stop: { t: 4_000_000_000, reason: "recorder-quit" } });
    expect(item.notes).toContain("Recovered after the recorder quit. No cursor data.");
    expect(recordingItem(aTake()).notes ?? []).not.toContain("Recovered after the recorder quit. No cursor data.");
  });
});

describe("a track lost while the take keeps recording (STC-237)", () => {
  test("every track-loss warning the helper sends has a pill label, and none is also a stop", () => {
    const swift = ["Capture.swift", "MicCapture.swift"]
      .map((f) => readFileSync(join(root, "helper/src", f), "utf8")).join("\n");
    for (const code of TRACK_LOSS_WARNINGS) {
      expect(swift, `the helper no longer sends ${code}; drop it here`).toContain(`"code": "${code}"`);
      expect(trackLossPillLabel(code)).toBeTruthy();
      expect(trackLossPillLabel(code)!.length).toBeLessThanOrEqual(14);
      expect(STOP_ANNOUNCING_WARNINGS.has(code), `${code} does not stop the take`).toBe(false);
    }
    expect(trackLossPillLabel("mic-disconnected")).toBe("Mic lost");
    expect(trackLossPillLabel("camera-disconnected")).toBe("Camera lost");
    expect(trackLossPillLabel("camera-no-frames"), "a camera that never started is not a lost one").toBeUndefined();
  });

  test("the panel line names each lost track and when", () => {
    expect(trackLossLine({ mic: { present: true, endedBy: "disconnected", lastFramePtsNs: 70_400_000_000 } }))
      .toBe("The mic disconnected at 1:10, so the rest of the take has no mic audio.");
    expect(trackLossLine({ mic: { present: true, endedBy: "format-mismatch", lastFramePtsNs: 5_000_000_000 } }))
      .toBe("The mic stopped sending usable audio at 0:05, so the rest of the take has no mic audio.");
    expect(trackLossLine({
      mic: { present: true, endedBy: "disconnected", lastFramePtsNs: 70_000_000_000 },
      camera: { present: true, endedBy: "disconnected", lastFramePtsNs: 90_000_000_000 },
    })).toBe("The mic disconnected at 1:10, so the rest of the take has no mic audio. " +
             "The camera disconnected at 1:30, so the rest of the take has no camera.");
  });

  test("no line for a track that ran to the end, or that is not there", () => {
    expect(trackLossLine(undefined)).toBeUndefined();
    expect(trackLossLine({ mic: { present: true, lastFramePtsNs: 1 } })).toBeUndefined();
    expect(trackLossLine({ camera: { present: false, endedBy: "disconnected" } })).toBeUndefined();
  });
});
