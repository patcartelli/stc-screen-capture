import { describe, test, expect } from "vitest";
import { PRIMARY_DISPLAY_ENV, fakeDisplayIds, defaultFakeDisplays } from "./_fake-displays.mjs";

/**
 * The stand-in's display ids (STC-464). The e2e suite hung on every Mac whose
 * primary display id was not 1, behind a dialog no test answers — see
 * `_fake-displays.mjs`.
 */
describe("the stand-in's default displays", () => {
  test("the built-in display carries the measured primary id", () => {
    expect(fakeDisplayIds({ [PRIMARY_DISPLAY_ENV]: "4" })).toEqual({ builtIn: 4, external: 2 });
    expect(defaultFakeDisplays({ [PRIMARY_DISPLAY_ENV]: "69733382" }).map((d) => d.id))
      .toEqual([69733382, 2]);
  });

  test("the external display moves off the primary id rather than sharing it", () => {
    expect(fakeDisplayIds({ [PRIMARY_DISPLAY_ENV]: "2" })).toEqual({ builtIn: 2, external: 1 });
  });

  test("absent or unreadable, the old fixed ids stand", () => {
    expect(fakeDisplayIds({})).toEqual({ builtIn: 1, external: 2 });
    expect(fakeDisplayIds({ [PRIMARY_DISPLAY_ENV]: "nope" })).toEqual({ builtIn: 1, external: 2 });
  });

  // The fallback above is what hid this bug on CI, so the run itself must
  // never be on it: vitest.global-setup.ts measures the id and this worker
  // (and every app and stand-in it launches) inherits it.
  test("this run measured a real primary display id", () => {
    expect(process.env[PRIMARY_DISPLAY_ENV]).toMatch(/^\d+$/);
  });
});
