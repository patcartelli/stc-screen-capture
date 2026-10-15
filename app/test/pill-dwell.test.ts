import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { on: () => {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {} },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));

import { attachPillToSupervisor } from "../src/pill-window.js";
import { PILL_STOPPED_DWELL_MS } from "../src/pill.js";

/**
 * The pill's STC-531 dwell against the supervisor's REAL event order
 * (STC-550). `HelperSupervisor.endRecording` sets `state` idle, then emits
 * `take-ended`, then `recording-ended`. Reacting to `take-ended` as a plain
 * reconcile put the pill away before the helper's reason could hold it up, so
 * on hardware a closed window went straight to the panel with no "Window
 * closed" on the pill. These drive that exact order.
 */
function fakeSupervisor() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const sup = {
    state: "recording" as string,
    on(ev: string, h: (p: unknown) => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(h);
      return () => handlers.get(ev)?.delete(h);
    },
    emit(ev: string, p?: unknown) { for (const h of handlers.get(ev) ?? []) h(p); },
  };
  return sup;
}

function fakeWindow() {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    win: { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
  };
}

/** What `endRecording` does, in its order. */
function helperEnds(sup: ReturnType<typeof fakeSupervisor>, reason: string): void {
  sup.state = "idle";
  sup.emit("take-ended", { dir: "/tmp/take", reason });
  sup.emit("recording-ended", { reason, dir: "/tmp/take" });
}

describe("the pill's dwell survives the supervisor's event order (STC-550)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a helper-decided stop shows its label for the dwell, THEN the pill goes", () => {
    const sup = fakeSupervisor();
    const { win, sent } = fakeWindow();
    const show = vi.fn(), hide = vi.fn();
    attachPillToSupervisor(win as never, sup as never, { show, hide }).reconcileNow();
    expect(show).toHaveBeenCalledTimes(1);

    helperEnds(sup, "window-closed");
    expect(hide, "put away before the label could show").not.toHaveBeenCalled();
    expect(sent).toContainEqual({ channel: "pill:stopped", payload: { label: "Window closed" } });

    vi.advanceTimersByTime(PILL_STOPPED_DWELL_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("a stop the user asked for goes at once, with no label", () => {
    const sup = fakeSupervisor();
    const { win, sent } = fakeWindow();
    const show = vi.fn(), hide = vi.fn();
    attachPillToSupervisor(win as never, sup as never, { show, hide }).reconcileNow();

    // A user stop emits only `take-ended`, reason "stopped".
    sup.state = "idle";
    sup.emit("take-ended", { dir: "/tmp/take", reason: "stopped" });
    expect(hide).toHaveBeenCalledTimes(1);
    expect(sent.some((s) => s.channel === "pill:stopped" && (s.payload as { label: unknown }).label !== null)).toBe(false);
  });
});
