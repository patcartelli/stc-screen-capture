import { describe, expect, test } from "vitest";
import { homeRelative } from "../src/path-label.js";

describe("homeRelative (STC-604)", () => {
  test("the home folder reads as ~, the rest of the path is untouched", () => {
    expect(homeRelative("/Users/pat/Desktop/stc/take-1")).toBe("~/Desktop/stc/take-1");
    expect(homeRelative("/Users/pat")).toBe("~");
  });
  test("only a leading /Users/<name> is replaced", () => {
    expect(homeRelative("/Volumes/Work/Users/pat/x")).toBe("/Volumes/Work/Users/pat/x");
    expect(homeRelative("/Users")).toBe("/Users");
    expect(homeRelative("/Users/patrick-two/a")).toBe("~/a");
  });
  test("a path with no home prefix, and an empty one, come back as given", () => {
    expect(homeRelative("/tmp/stc-take")).toBe("/tmp/stc-take");
    expect(homeRelative("")).toBe("");
  });
});
