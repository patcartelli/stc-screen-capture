/**
 * Pins a take to sRGB for the grant tests that are not about colour (STC-512).
 *
 * A wide-gamut main display makes a take anchors-9 for `capture.colorSpace`
 * alone (STC-510). These tests pin an older anchors schema on purpose, to catch
 * the helper drifting to a version the feature under test did not earn
 * (STC-262, STC-311), so the colour space must not be what moves the version.
 * `STC_CAPTURE_COLOUR=srgb` (see `applyColourOverride`) removes the display from
 * the question. The colour tests (`recording-colour`, `colour-sck`) do NOT use
 * this: they exist to see the display's real gamut.
 */
export const SRGB_ENV: Record<string, string> = { STC_CAPTURE_COLOUR: "srgb" };

/**
 * The same pin for a helper launched through `open -W` (camera, mic and system
 * audio), where the caller's environment does not reach the app. Goes before the
 * app path; STCTestHost's helper child inherits the app's environment.
 */
export const SRGB_OPEN_ARGS: string[] = ["--env", "STC_CAPTURE_COLOUR=srgb"];
