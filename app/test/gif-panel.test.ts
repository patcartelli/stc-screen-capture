import { describe, test, expect } from "vitest";
import {
  INITIAL_GIF_STATE, reduceGif, effectOfPick, formatOf, gifLabel, copySaveEnabled,
  formatBytes, GIF_LARGE_BYTES, type GifState,
} from "../src/gif-panel.js";

const converting = (permille = 0): GifState => ({ kind: "converting", permille });

describe("the switch's states (spec §2's table)", () => {
  test("every panel starts on Video", () => {
    expect(INITIAL_GIF_STATE).toEqual({ kind: "video" });
    expect(formatOf(INITIAL_GIF_STATE)).toBe("video");
  });
  test("Video → GIF starts converting at 0", () => {
    expect(reduceGif(INITIAL_GIF_STATE, { kind: "pick", format: "gif" })).toEqual(converting(0));
    expect(effectOfPick(INITIAL_GIF_STATE, "gif")).toBe("start");
  });
  test("progress moves the bar, in permille, clamped", () => {
    expect(reduceGif(converting(), { kind: "progress", done: 420, total: 1000 })).toEqual(converting(420));
    expect(reduceGif(converting(), { kind: "progress", done: 5, total: 0 })).toEqual(converting(0));
    expect(reduceGif(converting(), { kind: "progress", done: 2000, total: 1000 })).toEqual(converting(1000));
  });
  test("done → ready with the real size", () => {
    expect(reduceGif(converting(900), { kind: "done", bytes: 3_400_000 })).toEqual({ kind: "ready", bytes: 3_400_000 });
  });
  test("a failure is shown, and Video is still one pick away", () => {
    const f = reduceGif(converting(), { kind: "failed", detail: "boom" });
    expect(f).toEqual({ kind: "failed", detail: "boom" });
    expect(reduceGif(f, { kind: "pick", format: "video" })).toEqual({ kind: "video" });
  });
  test("GIF → Video while converting cancels; while ready or failed there is nothing to cancel", () => {
    expect(effectOfPick(converting(300), "video")).toBe("cancel");
    expect(effectOfPick({ kind: "ready", bytes: 1 }, "video")).toBe("none");
    expect(effectOfPick({ kind: "failed", detail: "x" }, "video")).toBe("none");
  });
  test("picking the format already showing does nothing", () => {
    expect(effectOfPick(INITIAL_GIF_STATE, "video")).toBe("none");
    expect(effectOfPick(converting(), "gif")).toBe("none");
    expect(reduceGif(converting(10), { kind: "pick", format: "gif" })).toEqual(converting(10));
  });
  test("a failed GIF picked again retries", () => {
    expect(effectOfPick({ kind: "failed", detail: "x" }, "gif")).toBe("start");
  });
  test("late events after switching back to Video are ignored (Review Focus 4)", () => {
    const v: GifState = { kind: "video" };
    expect(reduceGif(v, { kind: "progress", done: 1, total: 2 })).toEqual(v);
    expect(reduceGif(v, { kind: "done", bytes: 9 })).toEqual(v);
    expect(reduceGif(v, { kind: "failed", detail: "late" })).toEqual(v);
  });
  test("cancelled while converting returns to Video", () => {
    expect(reduceGif(converting(5), { kind: "cancelled" })).toEqual({ kind: "video" });
  });
});

describe("what the panel shows", () => {
  test("Video shows nothing extra", () => { expect(gifLabel({ kind: "video" })).toBe(null); });
  test("converting shows a percentage", () => {
    expect(gifLabel(converting(423))).toEqual({ text: "GIF 42%", warn: false });
  });
  test("ready shows the size; the warning starts strictly above 10 MB", () => {
    expect(gifLabel({ kind: "ready", bytes: 3_400_000 })).toEqual({ text: "GIF · 3.4 MB", warn: false });
    expect(gifLabel({ kind: "ready", bytes: GIF_LARGE_BYTES })).toEqual({ text: "GIF · 10 MB", warn: false });
    expect(gifLabel({ kind: "ready", bytes: GIF_LARGE_BYTES + 1 }))
      .toEqual({ text: "GIF · 10 MB — large for a GIF; Video is smaller", warn: true });
  });
  test("failed names the reason", () => {
    expect(gifLabel({ kind: "failed", detail: "no frames" })).toEqual({ text: "GIF failed — no frames", warn: true });
  });
  test("Copy/Save: enabled for video, converting (they wait) and ready; disabled when failed", () => {
    expect(copySaveEnabled({ kind: "video" })).toBe(true);
    expect(copySaveEnabled(converting())).toBe(true);
    expect(copySaveEnabled({ kind: "ready", bytes: 1 })).toBe(true);
    expect(copySaveEnabled({ kind: "failed", detail: "x" })).toBe(false);
  });
  test("sizes read the way Finder reads them (decimal)", () => {
    expect(formatBytes(820_000)).toBe("820 KB");
    expect(formatBytes(3_400_000)).toBe("3.4 MB");
    expect(formatBytes(14_049_000)).toBe("14 MB");
  });
});
