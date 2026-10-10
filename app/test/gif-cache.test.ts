import { describe, test, expect } from "vitest";
import { GifCache } from "../src/gif-cache.js";

const s15 = { fps: 15, maxWidth: 960 } as const;
const s30 = { fps: 30, maxWidth: 960 } as const;

describe("GifCache (STC-395)", () => {
  test("a finished GIF is reused only for the settings it was made with", () => {
    const c = new GifCache();
    const g = c.begin("/t/a");
    expect(c.settle("/t/a", g, { path: "/c/a.gif", settings: s15, bytes: 10 })).toBe(true);
    expect(c.lookup("/t/a", s15)?.path).toBe("/c/a.gif");
    expect(c.lookup("/t/a", s30)).toBeUndefined();
  });
  test("a job begun before a newer one cannot settle over it (Review Focus 4)", () => {
    const c = new GifCache();
    const old = c.begin("/t/a");
    const neu = c.begin("/t/a");
    expect(c.settle("/t/a", old, { path: "/c/a.gif", settings: s15, bytes: 1 })).toBe(false);
    expect(c.lookup("/t/a", s15)).toBeUndefined();
    expect(c.settle("/t/a", neu, { path: "/c/a.gif", settings: s30, bytes: 2 })).toBe(true);
    expect(c.lookup("/t/a", s30)?.bytes).toBe(2);
  });
  test("forget drops the record (Trash, dismiss)", () => {
    const c = new GifCache();
    c.settle("/t/a", c.begin("/t/a"), { path: "/c/a.gif", settings: s15, bytes: 1 });
    c.forget("/t/a");
    expect(c.lookup("/t/a", s15)).toBeUndefined();
  });
  test("beginning a job invalidates the old record (the file is about to be overwritten)", () => {
    const c = new GifCache();
    c.settle("/t/a", c.begin("/t/a"), { path: "/c/a.gif", settings: s15, bytes: 1 });
    c.begin("/t/a");
    expect(c.lookup("/t/a", s15)).toBeUndefined();
  });
  test("forget also stops a job in flight from settling (a cancel's late completion)", () => {
    const c = new GifCache();
    const g = c.begin("/t/a");
    c.forget("/t/a");
    expect(c.settle("/t/a", g, { path: "/c/a.gif", settings: s15, bytes: 1 })).toBe(false);
    expect(c.lookup("/t/a", s15)).toBeUndefined();
  });
  test("\"any\" finds the ready GIF whatever it was made with (Copy/Save, spec §3)", () => {
    const c = new GifCache();
    c.settle("/t/a", c.begin("/t/a"), { path: "/c/a.gif", settings: s15, bytes: 7 });
    // The person changed the frame rate since: a pick misses, a Copy does not.
    expect(c.lookup("/t/a", s30)).toBeUndefined();
    expect(c.lookup("/t/a", "any")?.bytes).toBe(7);
    expect(c.lookup("/t/b", "any")).toBeUndefined();
  });
  test("isCurrent: a forget (cancel) or a newer begin retires a job's generation", () => {
    const c = new GifCache();
    const g = c.begin("/t/a");
    expect(c.isCurrent("/t/a", g)).toBe(true);
    c.forget("/t/a");
    expect(c.isCurrent("/t/a", g)).toBe(false);
    const h = c.begin("/t/a");
    expect(c.isCurrent("/t/a", h)).toBe(true);
    c.begin("/t/a");
    expect(c.isCurrent("/t/a", h)).toBe(false);
  });
});
