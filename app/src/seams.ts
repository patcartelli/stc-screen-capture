/**
 * Test seams are not for a packaged build (STC-657).
 *
 * The e2e suite and the grant tests drive the app through `STC_*` environment
 * variables: `STC_HELPER_BIN` swaps the helper for a stand-in,
 * `STC_ASSUME_PERMISSIONS` skips the permission gate, `STC_CAPTURE_FAULT` and
 * `STC_KEY_INJECT` reach the Swift helper through the environment it inherits.
 * The helper is Capture's child, so whatever binary runs there runs under
 * Capture's Screen Recording, Input Monitoring, Camera and Microphone grants.
 * A packaged build must therefore not read any of them.
 *
 * ONE place does it: `scrubPackagedEnv` deletes every `STC_*` from the
 * environment before anything reads it, so main's own reads AND the env the
 * helper inherits are clean. `seams-boot.ts` calls it, and `main.ts` imports
 * that file first (`seams.test.ts` pins the order).
 *
 * `PACKAGED_KEEP` is the deliberate exception list. It is empty: if a packaged
 * build ever needs one (a diagnostic a tester can switch on), name it here with
 * the reason, and the test that pins the list will say so.
 *
 * Pure and Electron-free, so it is unit-tested without an app.
 */

export const PACKAGED_KEEP: readonly string[] = [];

/**
 * Delete every `STC_*` key from `env` when `isPackaged`. Returns the NAMES
 * removed (never the values: a seam's value can be a path). Unpackaged,
 * does nothing and returns [].
 */
export function scrubPackagedEnv(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  keep: readonly string[] = PACKAGED_KEEP,
): string[] {
  if (!isPackaged) return [];
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("STC_") || keep.includes(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed.sort();
}
