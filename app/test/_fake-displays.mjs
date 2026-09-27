/**
 * The helper stand-in's default display list, and the ONE place its ids are
 * decided (STC-464).
 *
 * ## Why the ids cannot be constants
 *
 * The overlay takes its displays from Electron's `screen`, whose ids on macOS
 * are the machine's real `CGDirectDisplayID`s. `recordFlowBody` (main.ts,
 * STC-433) then checks the overlay's pick against the helper's `devices`
 * reply before the countdown, and a pick that is not listed opens a native
 * "The selected display is no longer connected" dialog that no test can
 * answer. The stand-in used to answer with fixed ids 1 and 2, which matched
 * CI's VM by luck and matched nothing on a real Mac (id 4 on the one this was
 * found on): every test that records hung behind that dialog, 44 of them.
 *
 * So the built-in display takes the id of Electron's PRIMARY display — the
 * one `_record-flow.ts` drags on — measured once per run by
 * `vitest.global-setup.ts` and handed down in `PRIMARY_DISPLAY_ENV`. The
 * external one keeps 2 unless that would collide, in which case it takes 1:
 * two displays with one id would be a different bug.
 *
 * Absent the variable (a runner that skipped the global setup), the old
 * fixed id 1 stands, which is exactly the behaviour CI already had.
 *
 * `STC_FAKE_DISPLAYS` still overrides all of this, in `_fake-helper.mjs`.
 */
export const PRIMARY_DISPLAY_ENV = "STC_TEST_PRIMARY_DISPLAY_ID";

/** The built-in and external display ids the stand-in reports by default. */
export function fakeDisplayIds(env = process.env) {
  const measured = Number(env[PRIMARY_DISPLAY_ENV]);
  const builtIn = Number.isSafeInteger(measured) && measured > 0 ? measured : 1;
  return { builtIn, external: builtIn === 2 ? 1 : 2 };
}

/** The stand-in's `devices` reply's `displays`, when `STC_FAKE_DISPLAYS` is unset. */
export function defaultFakeDisplays(env = process.env) {
  const { builtIn, external } = fakeDisplayIds(env);
  return [
    { id: builtIn, main: true, name: "Built-in Display", pointW: 1800, pointH: 1169,
      pixelW: 3600, pixelH: 2338, originX: 0, originY: 0 },
    { id: external, main: false, name: "External Display", pointW: 2560, pointH: 1440,
      pixelW: 2560, pixelH: 1440, originX: 1800, originY: 0 },
  ];
}
