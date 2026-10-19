// STC-559: a capture device the take isn't using (headphones) must raise nothing.
// The helper sends the generic `device-disconnected` as `info`, never `warning`, and the
// renderer has no toast for it. A grep, like stop-copy.test.ts: the fault needs a cable.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("Watchers sends device-disconnected as info, not warning", () => {
  expect(read("helper/src/Watchers.swift")).toMatch(/IO\.send\("info", \["code": "device-disconnected"/);
  expect(read("helper/src/Watchers.swift")).not.toMatch(/"warning", \["code": "device-disconnected"/);
});

test("renderer has no toast text for device-disconnected", () => {
  expect(read("app/src/renderer.ts")).not.toMatch(/"device-disconnected":/);
});

test("CONTROL: a take's own mic and camera keep their specific warnings", () => {
  const cap = read("helper/src/Capture.swift");
  expect(cap).toMatch(/"code": "mic-disconnected"/);
  expect(cap).toMatch(/"code": "camera-disconnected"/);
});
