import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_CODE, PRODUCT_NAME, LEGACY_APP_DIR_NAME, productStamp } from "../src/product.js";

/**
 * The product's identity (STC-399) — small on purpose. The ticket's own
 * rule 2 is "one constant for the code... never typed twice", and the thing
 * worth pinning is that `productStamp` is the ONE place the "STC {code}
 * v{version}" wording exists, so the About panel and the export stamp
 * cannot quietly drift apart.
 */
describe("the product's identity", () => {
  test("MODEL_CODE is SK-016, from the Naming Spec", () => {
    expect(MODEL_CODE).toBe("SK-016");
  });

  test("productStamp reads \"STC {code} v{version}\"", () => {
    expect(productStamp("0.1.0")).toBe("STC SK-016 v0.1.0");
  });

  test("the version is never assumed — whatever is passed in comes back out verbatim", () => {
    expect(productStamp("1.2.3")).toBe("STC SK-016 v1.2.3");
    expect(productStamp("0.0.0-dev")).toBe("STC SK-016 v0.0.0-dev");
  });
});

/**
 * The product's NAME (STC-397), and the one thing about it that cannot be
 * checked by reading this module alone: Electron derives `app.getName()` —
 * and therefore `app.getPath("userData")`, where settings live — from
 * `package.json`'s `productName`, not from this constant. If the two ever
 * disagree, every display string says one thing while settings quietly live
 * in a folder named the other, which is precisely the failure this ticket's
 * migration exists to clean up after.
 */
describe("the product's name", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));

  test("is Capture", () => {
    expect(PRODUCT_NAME).toBe("Capture");
  });

  test("matches package.json's productName, which is what actually moves userData", () => {
    expect(pkg.productName).toBe(PRODUCT_NAME);
  });

  test("the legacy folder name is the one userData used BEFORE the rename", () => {
    expect(LEGACY_APP_DIR_NAME).toBe("stc-screen-recorder");
    // package.json's `name` is what `app.getName()` fell back to before
    // `productName` existed — so it is the folder the migration rescues.
    expect(pkg.name).toBe(LEGACY_APP_DIR_NAME);
    // And a migration between two identical paths would be a no-op that
    // looked like it worked.
    expect(PRODUCT_NAME).not.toBe(LEGACY_APP_DIR_NAME);
  });
});
