import { afterEach, describe, expect, it, vi } from "vitest";
import type { Shot } from "@transform/shot";
import { loadShotBackground } from "../src/still-compose";

const shotWith = (background: unknown) =>
  ({ decoration: { background } }) as unknown as Shot;

afterEach(() => vi.unstubAllGlobals());

describe("loadShotBackground", () => {
  it("is undefined for a rejected read", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("unreachable")));
    const getFrame = vi.fn().mockRejectedValue(new Error("gone"));
    expect(await loadShotBackground(shotWith({ kind: "wallpaper", file: "wallpaper.jpg", colors: ["#000000"] }), getFrame))
      .toBeUndefined();
    expect(getFrame).toHaveBeenCalledWith("wallpaper.jpg");
  });

  it("is undefined, without reading, for a kind that has no file", async () => {
    const getFrame = vi.fn();
    expect(await loadShotBackground(shotWith({ kind: "solid", colors: ["#000000"] }), getFrame)).toBeUndefined();
    expect(await loadShotBackground(shotWith(undefined), getFrame)).toBeUndefined();
    expect(await loadShotBackground(shotWith({ kind: "mesh" }), getFrame)).toBeUndefined();
    expect(getFrame).not.toHaveBeenCalled();
  });

  it("is undefined, not a throw, when the bytes do not decode", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("bad image")));
    const getFrame = vi.fn().mockResolvedValue(new ArrayBuffer(4));
    expect(await loadShotBackground(shotWith({ kind: "image", file: "x.png", colors: ["#000000"] }), getFrame))
      .toBeUndefined();
  });

  it("decodes the bytes it read", async () => {
    const bitmap = { width: 1, height: 1 };
    vi.stubGlobal("createImageBitmap", () => Promise.resolve(bitmap));
    const getFrame = vi.fn().mockResolvedValue(new ArrayBuffer(4));
    expect(await loadShotBackground(shotWith({ kind: "wallpaper", file: "wallpaper.jpg", colors: ["#000000"] }), getFrame))
      .toBe(bitmap);
  });
});
