import { describe, test, expect } from "vitest";
import { nextPhase } from "../src/overlay-session.js";
import type { SelectionOutcome } from "../src/selection.js";

const region: SelectionOutcome = {
  kind: "region", displayId: 1, crop: { x: 0, y: 0, width: 10, height: 10 },
  global: { x: 0, y: 0, width: 10, height: 10 },
};
const cancelled: SelectionOutcome = { kind: "cancelled" };

describe("what an outcome means, per purpose (STC-388)", () => {
  test("a shot finishes on its outcome, exactly as before", () => {
    expect(nextPhase("shot", "select", region)).toEqual({ act: "finish", outcome: region });
  });

  test("a record holds its first outcome and shows the options bar", () => {
    expect(nextPhase("record", "select", region)).toEqual({ act: "options", outcome: region });
  });

  test("re-confirming in the options phase REPLACES the held outcome", () => {
    // The marquee stays live through the options phase, so Enter after an
    // adjustment must update what would be recorded — not start a take with
    // the rect the user has just moved away from.
    expect(nextPhase("record", "options", region)).toEqual({ act: "options", outcome: region });
  });

  test("cancelled always finishes, in either purpose and either phase", () => {
    for (const p of ["shot", "record"] as const) {
      for (const ph of ["select", "options"] as const) {
        expect(nextPhase(p, ph, cancelled)).toEqual({ act: "finish", outcome: cancelled });
      }
    }
  });
});
