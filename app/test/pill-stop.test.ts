import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { on: () => {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {} },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));

import { attachPillToSupervisor } from "../src/pill-window.js";

/**
 * The pill after a stop, against the supervisor's REAL event order (STC-550,
 * STC-579). `HelperSupervisor.endRecording` sets `state` idle, then emits
 * `take-ended`, then `recording-ended`. The pill goes away at once on the first
 * and says nothing: the take's panel carries why.
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

describe("the pill after a stop (STC-579)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a helper-decided stop puts the pill away at once, with no label and no wait", () => {
    const sup = fakeSupervisor();
    const { win, sent } = fakeWindow();
    const show = vi.fn(), hide = vi.fn();
    attachPillToSupervisor(win as never, sup as never, { show, hide }).reconcileNow();
    expect(show).toHaveBeenCalledTimes(1);

    helperEnds(sup, "window-closed");
    expect(hide).toHaveBeenCalledTimes(1);
    expect(sent.filter((s) => s.channel === "pill:stopped")).toEqual([]);
    vi.advanceTimersByTime(10_000);
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
    expect(sent.filter((s) => s.channel === "pill:stopped")).toEqual([]);
  });

  it("a new take right after a stop shows the pill again, with nothing left over", () => {
    const sup = fakeSupervisor();
    const { win } = fakeWindow();
    const show = vi.fn(), hide = vi.fn();
    const att = attachPillToSupervisor(win as never, sup as never, { show, hide });
    att.reconcileNow();
    helperEnds(sup, "disk-full");
    sup.state = "recording";
    att.reconcileNow();
    expect(show).toHaveBeenCalledTimes(2);
  });
});
