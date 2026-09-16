import { describe, test, expect } from "vitest";
import { MODEL_CODE, productStamp } from "../src/product.js";

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
