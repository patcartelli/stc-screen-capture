import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import baseSetup from "./vitest.global-setup";

/**
 * STC-679: a grant run rebuilds a STALE STCTestHost, not only a missing one.
 *
 * `main.swift` grows commands (`--camera-preview`, STC-638), and a host built
 * before that answers the new flag with `bad-args`, which reads as a bug in the
 * helper. Measured 2026-11-16: camera-preview and crash-camera failed that way
 * against an old bundle and passed on a rebuilt one.
 *
 * Stale = the host's executable is older than `main.swift` or `build.sh`.
 * Grant-only on purpose: the shared `vitest.global-setup.ts` also runs on CI,
 * which has no signing identity, and `build.sh` refuses without one.
 *
 * Rebuilding with the same identity keeps the grants (build.sh's header). If
 * one is lost anyway, run the host's `--camera-request` once.
 */
export const HOST_DIR = fileURLToPath(new URL("./tools/test-host/", import.meta.url));

export function hostIsStale(dir: string = HOST_DIR): boolean {
  const exe = join(dir, "STCTestHost.app/Contents/MacOS/STCTestHost");
  if (!existsSync(exe)) return true;
  const built = statSync(exe).mtimeMs;
  return ["main.swift", "build.sh"].some((f) => statSync(join(dir, f)).mtimeMs > built);
}

export default function setup() {
  baseSetup();
  if (hostIsStale()) {
    console.log("STCTestHost is missing or older than its source: rebuilding (tools/test-host/build.sh)");
    execFileSync(join(HOST_DIR, "build.sh"), { stdio: "inherit" });
  }
}
