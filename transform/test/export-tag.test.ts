import { describe, test, expect } from "vitest";
import { tagMp4, readMp4CaptureId } from "../src/media-tag.js";
import { mintCaptureId } from "../src/capture-id.js";

describe("export tagging", () => {
  test("a tagged buffer still begins with the muxer's own bytes", () => {
    // Stands in for the muxer's output: the contract is that tagging appends.
    const muxed = new Uint8Array([0, 0, 0, 16, ...[..."ftyp"].map((c) => c.charCodeAt(0)),
                                  ...new Array(8).fill(0)]);
    const id = mintCaptureId();
    const out = tagMp4(muxed, id);
    expect(out.subarray(0, muxed.length)).toEqual(muxed);
    expect(readMp4CaptureId(out)).toBe(id);
  });

  test("no id means the buffer is returned untouched", () => {
    const muxed = new Uint8Array([0, 0, 0, 8, ...[..."ftyp"].map((c) => c.charCodeAt(0))]);
    expect(tagMp4(muxed, "not-an-id")).toEqual(muxed);
  });
});
