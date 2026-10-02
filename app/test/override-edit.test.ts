import { describe, test, expect } from "vitest";
import { committedOverrides, type OverrideEdit } from "../src/override-edit.js";
import type { SessionEvent, ZoomOverride } from "@transform/types";
import { zoomWindows } from "@transform/zoom";
import { windowId } from "@transform/zoom-override";

// STC-500: the ONE rule for what an open zoom-override edit commits to. The
// editor's Done (commitDraft / commitManualDraft) and every save made WHILE
// the edit is open (persistProject) both go through it, so "what is written
// mid-edit" and "what Done writes" cannot drift apart.

const MS = 1_000_000;
const down = (ms: number): SessionEvent => ({ t: ms * MS, kind: "down", x: 0, y: 0, button: 0 });
const up = (ms: number): SessionEvent => ({ t: ms * MS, kind: "up", x: 0, y: 0, button: 0 });

// Two well-separated clicks → two derived windows.
const events: SessionEvent[] = [down(1000), up(1050), down(20000), up(20050)];
const [w1, w2] = zoomWindows(events);
const id1 = windowId(w1!);
const id2 = windowId(w2!);

const R = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
const R2 = { x: 0.3, y: 0.3, width: 0.6, height: 0.6 };

/** Entries belonging to some OTHER window — must survive every commit untouched. */
const others: ZoomOverride[] = [
  { kind: "geometry", windowId: id2, rect: R2, easing: "snappy" },
  { kind: "retime", windowId: id2, endNs: w2!.endNs + 500 * MS },
  { kind: "manual", id: "m-other", startNs: 40000 * MS, endNs: 43000 * MS, rect: R2, easing: "calm" },
];

const derived = (o: Partial<Extract<OverrideEdit, { kind: "derived" }>> = {}): OverrideEdit => ({
  kind: "derived", windowId: id1, rect: null, easing: "", startNs: w1!.startNs, endNs: w1!.endNs, ...o,
});
const manual = (o: Partial<Extract<OverrideEdit, { kind: "manual" }>> = {}): OverrideEdit => ({
  kind: "manual", id: "m1", rect: R, easing: "", startNs: 5000 * MS, endNs: 8000 * MS, ...o,
});

const forWindow = (list: ZoomOverride[], id: string) =>
  list.filter((o) => (o.kind === "geometry" || o.kind === "retime") && o.windowId === id);

describe("committedOverrides — a derived window (STC-330 geometry, STC-329 retime)", () => {
  test("geometry only: a rect, no retime", () => {
    const out = committedOverrides(others, derived({ rect: R }), events, undefined);
    expect(forWindow(out, id1)).toEqual([{ kind: "geometry", windowId: id1, rect: R }]);
    expect(out.slice(0, 3)).toEqual(others);
  });

  test("geometry with an explicit easing carries it; an empty picker writes no easing key", () => {
    const withEasing = committedOverrides([], derived({ rect: R, easing: "snappy" }), events, "calm");
    expect(withEasing).toEqual([{ kind: "geometry", windowId: id1, rect: R, easing: "snappy" }]);
    const without = committedOverrides([], derived({ rect: R }), events, "calm");
    expect("easing" in without[0]!).toBe(false);
  });

  test("retime only: start moved", () => {
    const out = committedOverrides(others, derived({ startNs: w1!.startNs + 100 * MS }), events, undefined);
    expect(forWindow(out, id1)).toEqual([{ kind: "retime", windowId: id1, startNs: w1!.startNs + 100 * MS }]);
    expect(out.filter((o) => !forWindow([o], id1).length)).toEqual(others);
  });

  test("retime only: end moved", () => {
    const out = committedOverrides(others, derived({ endNs: w1!.endNs - 200 * MS }), events, undefined);
    expect(forWindow(out, id1)).toEqual([{ kind: "retime", windowId: id1, endNs: w1!.endNs - 200 * MS }]);
  });

  test("retime only: both moved", () => {
    const out = committedOverrides([], derived({ startNs: 1 * MS, endNs: w1!.endNs + 1 * MS }), events, undefined);
    expect(out).toEqual([{ kind: "retime", windowId: id1, startNs: 1 * MS, endNs: w1!.endNs + 1 * MS }]);
  });

  test("geometry + retime, geometry first", () => {
    const out = committedOverrides(others, derived({ rect: R, endNs: w1!.endNs + 1 * MS }), events, undefined);
    expect(out).toEqual([
      ...others,
      { kind: "geometry", windowId: id1, rect: R },
      { kind: "retime", windowId: id1, endNs: w1!.endNs + 1 * MS },
    ]);
  });

  test("neither: removes any prior geometry/retime for that window, keeps everything else", () => {
    const prior: ZoomOverride[] = [
      ...others,
      { kind: "geometry", windowId: id1, rect: R, easing: "calm" },
      { kind: "retime", windowId: id1, startNs: 5 * MS },
    ];
    expect(committedOverrides(prior, derived(), events, undefined)).toEqual(others);
  });

  test("a retime that exactly undoes a previous one is decided against the TRUE derived bounds, so it is cleared", () => {
    const prior: ZoomOverride[] = [{ kind: "retime", windowId: id1, startNs: 5 * MS }];
    // the draft is back at the window's original, un-retimed bounds
    expect(committedOverrides(prior, derived(), events, undefined)).toEqual([]);
  });

  test("a draft equal to the existing override yields an array deep-equal to the input", () => {
    const input: ZoomOverride[] = [
      ...others,
      { kind: "geometry", windowId: id1, rect: R, easing: "snappy" },
      { kind: "retime", windowId: id1, startNs: w1!.startNs + 10 * MS, endNs: w1!.endNs + 10 * MS },
    ];
    const out = committedOverrides(
      input,
      derived({ rect: R, easing: "snappy", startNs: w1!.startNs + 10 * MS, endNs: w1!.endNs + 10 * MS }),
      events, undefined,
    );
    expect(out).toEqual(input);
  });

  test("idempotent: committing an already-committed array again changes nothing (persistProject runs while Done's commit is still open)", () => {
    const edit = derived({ rect: R, startNs: w1!.startNs + 10 * MS });
    const once = committedOverrides(others, edit, events, "calm");
    expect(committedOverrides(once, edit, events, "calm")).toEqual(once);
  });

  test("a window the events no longer produce gets no retime (nothing to compare against)", () => {
    const out = committedOverrides([], derived({ windowId: "999", rect: R, startNs: 1, endNs: 2 }), events, undefined);
    expect(out).toEqual([{ kind: "geometry", windowId: "999", rect: R }]);
  });

  test("never mutates its input", () => {
    const input: ZoomOverride[] = structuredClone(others);
    committedOverrides(input, derived({ rect: R, startNs: 0 }), events, undefined);
    expect(input).toEqual(others);
  });
});

describe("committedOverrides — a manual window (STC-331)", () => {
  test("written with the draft's own easing", () => {
    const out = committedOverrides(others, manual({ easing: "snappy" }), events, "calm");
    expect(out).toEqual([
      ...others,
      { kind: "manual", id: "m1", startNs: 5000 * MS, endNs: 8000 * MS, rect: R, easing: "snappy" },
    ]);
  });

  test("an unresolved picker resolves to the project's preset", () => {
    const out = committedOverrides([], manual(), events, "calm");
    expect(out).toEqual([{ kind: "manual", id: "m1", startNs: 5000 * MS, endNs: 8000 * MS, rect: R, easing: "calm" }]);
  });

  test("…and to \"standard\" when the project has no preset", () => {
    const out = committedOverrides([], manual(), events, undefined);
    expect(out[0]).toMatchObject({ kind: "manual", easing: "standard" });
  });

  test("replaces a prior entry with the same id rather than adding a second", () => {
    const prior: ZoomOverride[] = [
      ...others,
      { kind: "manual", id: "m1", startNs: 1, endNs: 2, rect: R2, easing: "calm" },
    ];
    const out = committedOverrides(prior, manual({ easing: "snappy" }), events, undefined);
    expect(out.filter((o) => o.kind === "manual" && o.id === "m1")).toHaveLength(1);
    expect(out.slice(0, 3)).toEqual(others);
  });

  test("an empty draft deletes it", () => {
    const prior: ZoomOverride[] = [
      ...others,
      { kind: "manual", id: "m1", startNs: 1, endNs: 2, rect: R2, easing: "calm" },
    ];
    expect(committedOverrides(prior, manual({ rect: null }), events, undefined)).toEqual(others);
  });

  test("leaves derived entries alone even if a derived windowId happened to equal the manual id", () => {
    const prior: ZoomOverride[] = [{ kind: "geometry", windowId: "m1", rect: R2 }];
    expect(committedOverrides(prior, manual({ rect: null }), events, undefined)).toEqual(prior);
  });
});

describe("committedOverrides — absent overrides", () => {
  test("undefined input is an empty list", () => {
    expect(committedOverrides(undefined, derived(), events, undefined)).toEqual([]);
    expect(committedOverrides(undefined, manual({ rect: null }), events, undefined)).toEqual([]);
  });
});
