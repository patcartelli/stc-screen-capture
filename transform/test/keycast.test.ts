import { describe, test, expect } from "vitest";
import {
  NAMED_KEYS, KEYCAST_HOLD_TICKS as HOLD, KEYCAST_FADE_TICKS as FADE,
  keyLabel, checkKeyEvent, buildKeycastPresses, keycastAt, keycastText, keycastLayout, keycastFontPx,
} from "../src/keycast.js";
import { SessionLoadError } from "../src/session-error.js";
import { tickTimeNs } from "../src/time.js";
import type { KeyEvent, KeyMod } from "../src/types.js";

const k = (tick: number, key: string, mods: KeyMod[] = []): KeyEvent => ({ t: tickTimeNs(tick), kind: "key", key, mods });

describe("labels", () => {
  test("mods in ⌃⌥⇧⌘ order whatever order they arrive in", () => {
    expect(keyLabel("K", ["cmd", "shift", "ctrl", "opt"])).toBe("⌃⌥⇧⌘K");
  });
  test("arrows are glyphs, other named keys are words", () => {
    expect(keyLabel("ArrowDown", [])).toBe("↓");
    expect(keyLabel("Escape", [])).toBe("Esc");
    expect(keyLabel("PageDown", [])).toBe("Page Down");
    expect(keyLabel("ForwardDelete", [])).toBe("Fwd Delete");
    expect(keyLabel("Tab", ["shift"])).toBe("⇧Tab");
  });
  test("every named key has a label that is not its raw name for the renamed ones", () => {
    for (const n of NAMED_KEYS) expect(keyLabel(n, []).length).toBeGreaterThan(0);
    expect(keyLabel("Escape", [])).toBe("Esc");
    expect(keyLabel("ForwardDelete", [])).toBe("Fwd Delete");
    expect(keyLabel("PageUp", [])).toBe("Page Up");
    expect(keyLabel("PageDown", [])).toBe("Page Down");
    expect(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].map((n) => keyLabel(n, [])).join("")).toBe("↑↓←→");
  });
  test("count text", () => {
    expect(keycastText({ label: "↓", count: 1, opacity: 1 })).toBe("↓");
    expect(keycastText({ label: "↓", count: 3, opacity: 1 })).toBe("↓ ×3");
  });
});

describe("checkKeyEvent refuses what the schema refuses", () => {
  test("accepts a named key and a chord", () => {
    expect(checkKeyEvent({ t: 1, kind: "key", key: "Tab", mods: ["shift"] }, 0).key).toBe("Tab");
    expect(checkKeyEvent({ t: 1, kind: "key", key: "K", mods: ["cmd"] }, 0).key).toBe("K");
  });
  test.each([
    [{ t: 1, kind: "key", key: "A", mods: [] }],
    [{ t: 1, kind: "key", key: "A", mods: ["shift"] }],
    [{ t: 1, kind: "key", key: "E", mods: ["opt"] }],
    [{ t: 1, kind: "key", key: "k", mods: ["cmd"] }],
    [{ t: 1, kind: "key", key: "CapsLock", mods: [] }],
    [{ t: 1, kind: "key", key: "K", mods: ["cmd", "cmd"] }],
    [{ t: 1, kind: "key", key: "K", mods: ["hyper"] }],
    [{ t: -1, kind: "key", key: "Tab", mods: [] }],
    [{ t: 1, kind: "key", key: "Tab" }],
  ])("refuses %j with the event index", (e) => {
    expect(() => checkKeyEvent(e, 7)).toThrow(SessionLoadError);
    expect(() => checkKeyEvent(e, 7)).toThrow(/key event 7/);
  });
});

describe("presses and the visible state", () => {
  test("repeats of the same key inside the hold count up; the count shows per press, not the run's final total", () => {
    const p = buildKeycastPresses([k(0, "ArrowDown"), k(10, "ArrowDown"), k(20, "ArrowDown")]);
    expect(keycastAt(p, 5)).toEqual({ label: "↓", count: 1, opacity: 1 });
    expect(keycastAt(p, 15)).toEqual({ label: "↓", count: 2, opacity: 1 });
    expect(keycastAt(p, 25)).toEqual({ label: "↓", count: 3, opacity: 1 });
  });
  test("a different key starts over and replaces at once", () => {
    const p = buildKeycastPresses([k(0, "ArrowDown"), k(10, "ArrowRight"), k(20, "ArrowDown")]);
    expect(keycastAt(p, 12)?.label).toBe("→");
    expect(keycastAt(p, 22)).toEqual({ label: "↓", count: 1, opacity: 1 });
  });
  test("a repeat after the hold has ended starts a new count", () => {
    const p = buildKeycastPresses([k(0, "Tab"), k(HOLD, "Tab")]);
    expect(keycastAt(p, HOLD)?.count).toBe(1);
  });
  test("hold/fade boundaries are exact (Review Focus 5)", () => {
    const p = buildKeycastPresses([k(100, "Return")]);
    expect(keycastAt(p, 99)).toBeNull();
    expect(keycastAt(p, 100)?.opacity).toBe(1);
    expect(keycastAt(p, 100 + HOLD)?.opacity).toBe(1);
    expect(keycastAt(p, 100 + HOLD + FADE / 2)?.opacity).toBeCloseTo(0.5, 10);
    expect(keycastAt(p, 100 + HOLD + FADE)).toBeNull();
  });
  test("two presses on the same tick: the later one wins (Review Focus 5)", () => {
    const p = buildKeycastPresses([k(50, "ArrowUp"), k(50, "Escape")]);
    expect(keycastAt(p, 50)?.label).toBe("Esc");
  });
  test("no keys, no state", () => {
    expect(keycastAt([], 0)).toBeNull();
  });
  test("stepping and seeking agree at every tick", () => {
    const p = buildKeycastPresses([k(3, "ArrowDown"), k(9, "ArrowDown"), k(400, "K", ["cmd"]), k(401, "F5")]);
    const stepped = Array.from({ length: 700 }, (_, t) => keycastAt(p, t));
    const order = Array.from({ length: 700 }, (_, i) => (i * 389) % 700);   // a jumbled visit
    for (const t of order) expect(keycastAt(p, t)).toEqual(stepped[t]);
  });
});

describe("layout", () => {
  test("bottom-centre on a 1920x1080 output", () => {
    const b = keycastLayout(1920, 1080, 100);
    expect(b.x + b.width / 2).toBeCloseTo(960, 0);
    expect(b.y + b.height).toBeLessThan(1080);
    expect(b.fontPx).toBe(keycastFontPx(1920));
  });
  test("never narrower than its minimum font", () => {
    expect(keycastFontPx(100)).toBe(14);
  });
  test("an unclamped pill never hands fillText a maxWidth below the text's own width", () => {
    expect(keycastLayout(1920, 1080, 100.4).maxTextWidth).toBeGreaterThanOrEqual(100.4);
  });
  test("a long label on a tiny output stays inside the canvas (Review Focus 2)", () => {
    const b = keycastLayout(320, 180, 2000);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(320);
  });
});
