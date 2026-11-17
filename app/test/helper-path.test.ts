import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { resolveHelperPath } from "../src/helper-path.js";

describe("resolveHelperPath", () => {
  test("unpackaged: resolves relative to hereDir, two levels up into helper/build", () => {
    const hereDir = "/checkout/app/dist";
    const result = resolveHelperPath({ isPackaged: false, resourcesPath: "/unused", hereDir });
    expect(result).toBe(join(hereDir, "..", "..", "helper", "build", "stc-helper"));
  });

  test("packaged: resolves inside resourcesPath, flat", () => {
    const result = resolveHelperPath({
      isPackaged: true,
      resourcesPath: "/Applications/Capture.app/Contents/Resources",
      hereDir: "/Applications/Capture.app/Contents/Resources/app.asar/app/dist",
    });
    expect(result).toBe(join("/Applications/Capture.app/Contents/Resources", "stc-helper"));
  });

  test("unpackaged: the override wins (a checkout's stand-in or debug build)", () => {
    const result = resolveHelperPath({
      isPackaged: false, resourcesPath: "/r", hereDir: "/h", override: "/custom/stc-helper",
    });
    expect(result).toBe("/custom/stc-helper");
  });

  // STC-657: the helper runs under Capture's grants, so a packaged build must
  // not take its binary from the environment.
  test("packaged: the override is ignored", () => {
    const result = resolveHelperPath({
      isPackaged: true, resourcesPath: "/r", hereDir: "/h", override: "/custom/stc-helper",
    });
    expect(result).toBe(join("/r", "stc-helper"));
  });
});
