/**
 * Where the Swift helper binary lives (STC-401).
 *
 * Unpackaged (`electron .`), the helper sits in the checkout at
 * `helper/build/stc-helper`, two directories up from this file's compiled
 * output (`app/dist/`). Packaged, `app/dist/main.mjs` ships inside the
 * bundle's `app.asar` and that relative path resolves to nothing outside
 * it — the helper instead ships flat under `Resources/` via
 * electron-builder's `extraResources`, reached through `process.resourcesPath`
 * rather than a path relative to this file.
 */
import { join } from "node:path";

export function resolveHelperPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  hereDir: string;
  override?: string;
}): string {
  if (opts.override) return opts.override;
  return opts.isPackaged
    ? join(opts.resourcesPath, "stc-helper")
    : join(opts.hereDir, "..", "..", "helper", "build", "stc-helper");
}
