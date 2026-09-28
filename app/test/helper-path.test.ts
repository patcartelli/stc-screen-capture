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

  test("override wins regardless of isPackaged", () => {
    const withOverride = (isPackaged: boolean) =>
      resolveHelperPath({
        isPackaged, resourcesPath: "/r", hereDir: "/h", override: "/custom/stc-helper",
      });
    expect(withOverride(true)).toBe("/custom/stc-helper");
    expect(withOverride(false)).toBe("/custom/stc-helper");
  });
});
