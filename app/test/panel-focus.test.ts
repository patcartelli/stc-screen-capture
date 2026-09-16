import { describe, test, expect } from "vitest";
import {
  focusPanel, needsActivation, PANEL_FOCUS_ESCALATE_MS, PANEL_WINDOW_TYPE,
  type FocusableWindow,
} from "../src/panel-focus.js";

/**
 * The race this covers needs a real window server to decide whether an NSPanel
 * became key without its app activating, which is the one thing this sandbox
 * (and CI's headless runner) cannot answer. So the WINDOW is stubbed and the
 * rule is tested for real — the same position `thumbnail-discard-race.test.ts`
 * and `close-editor-window.test.ts` already occupy.
 */
function stubWindow(over: Partial<FocusableWindow> & { focused?: boolean } = {}) {
  const calls: string[] = [];
  let focused = over.focused ?? true;
  const win: FocusableWindow = {
    isDestroyed: over.isDestroyed ?? (() => false),
    isFocused: over.isFocused ?? (() => focused),
    focus: over.focus ?? (() => { calls.push("focus"); }),
  };
  return { win, calls, setFocused: (v: boolean) => { focused = v; } };
}

const noSleep = async () => {};

describe("the rule, apart from its timer", () => {
  test("a window that took the keyboard needs no activation", () => {
    expect(needsActivation(false, true)).toBe(false);
  });

  test("a window that did not needs activation — that is the whole fallback", () => {
    expect(needsActivation(false, false)).toBe(true);
  });

  test("a DESTROYED window is never activated for", () => {
    // Stealing activation on behalf of a window that has gone would raise the
    // main window for nothing, which is the exact symptom being fixed.
    expect(needsActivation(true, false)).toBe(false);
  });
});

describe("focusPanel", () => {
  test("the polite path: focus is asked for, taken, and the app is never activated", async () => {
    const { win, calls } = stubWindow({ focused: true });
    let activated = 0;
    const took = await focusPanel(win, () => { activated++; }, { sleep: noSleep });
    expect(took).toBe("panel");
    expect(activated).toBe(0);
    expect(calls).toEqual(["focus"]);
  });

  test("escalates when the window did NOT end up with the keyboard", async () => {
    const { win, calls } = stubWindow({ focused: false });
    let activated = 0;
    const took = await focusPanel(win, () => { activated++; }, { sleep: noSleep });
    expect(took).toBe("escalated");
    expect(activated).toBe(1);
    // Focused again AFTER activating: activation alone raises the app's
    // windows without deciding which of them is key.
    expect(calls).toEqual(["focus", "focus"]);
  });

  test("a window destroyed during the wait is neither focused again nor activated for", async () => {
    let destroyed = false;
    const calls: string[] = [];
    const win: FocusableWindow = {
      isDestroyed: () => destroyed,
      isFocused: () => false,
      focus: () => { calls.push("focus"); },
    };
    let activated = 0;
    const took = await focusPanel(win, () => { activated++; }, {
      sleep: async () => { destroyed = true; },
    });
    expect(took).toBe("gone");
    expect(activated).toBe(0);
    expect(calls).toEqual(["focus"]);
  });

  test("a window already destroyed is not touched at all", async () => {
    const calls: string[] = [];
    const win: FocusableWindow = {
      isDestroyed: () => true,
      isFocused: () => false,
      focus: () => { calls.push("focus"); },
    };
    let activated = 0;
    expect(await focusPanel(win, () => { activated++; }, { sleep: noSleep })).toBe("gone");
    expect(activated).toBe(0);
    expect(calls).toEqual([]);
  });

  test("it WAITS before judging — a window that takes the keyboard late is not escalated for", async () => {
    // Without the wait the check would read the state from before the window
    // server answered, and every panel would escalate: the fallback would fire
    // always and the fix would silently do nothing.
    const s = stubWindow({ focused: false });
    let activated = 0;
    const took = await focusPanel(s.win, () => { activated++; }, {
      sleep: async () => { s.setFocused(true); },
    });
    expect(took).toBe("panel");
    expect(activated).toBe(0);
  });
});

describe("the constants both windows share", () => {
  test("one owner for the window type, so the overlay and the countdown cannot drift", () => {
    expect(PANEL_WINDOW_TYPE).toBe("panel");
  });

  test("the escalation wait is long enough for a window-server round trip and short enough to press Escape after", () => {
    expect(PANEL_FOCUS_ESCALATE_MS).toBeGreaterThanOrEqual(100);
    expect(PANEL_FOCUS_ESCALATE_MS).toBeLessThanOrEqual(500);
  });
});
