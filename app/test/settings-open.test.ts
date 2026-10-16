import { test, expect } from "vitest";
import { settingsMode } from "../src/settings-open.js";

test("no library window: Settings gets a window of its own", () => {
  expect(settingsMode(false)).toBe("standalone");
});
test("a library window already open: the sheet slides over it", () => {
  expect(settingsMode(true)).toBe("over-library");
});
