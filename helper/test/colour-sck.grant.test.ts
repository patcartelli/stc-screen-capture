/**
 * STC-510: what ScreenCaptureKit delivers for the swatch under each colour
 * configuration, side by side. Requires a Screen Recording grant (`npm run
 * test:capture`). Prints a table and asserts only that every variant produced a
 * frame — the table is the finding, and a verdict written before anyone has read
 * it is how a test comes to certify the bug.
 */
import { describe, test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

describe("SCK colour variants (STC-510)", () => {
  test("prints the swatch as delivered under each configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-sck-"));
    const build = (name: string) => {
      const bin = join(dir, name);
      execFileSync("swiftc", ["-O", join(root, `helper/test/${name}/main.swift`), "-o", bin], { timeout: 90_000 });
      return bin;
    };
    const swatch = spawn(build("colour-swatch"), ["30"], { stdio: ["ignore", "pipe", "ignore"] });
    const tool = build("colour-sck");
    try {
      const displayId = await new Promise<number>((res, rej) => {
        const t = setTimeout(() => rej(new Error("swatch window never reported ready")), 10_000);
        let seen = "";
        swatch.stdout!.on("data", (c: Buffer) => {
          seen += c.toString();
          if (seen.includes("NO_WIDE_GAMUT_DISPLAY")) { clearTimeout(t); rej(new Error("no wide-gamut display connected")); }
          const m = /SWATCH_DISPLAY=(\d+)/.exec(seen);
          if (m && seen.includes("SWATCH_READY")) { clearTimeout(t); res(Number(m[1])); }
        });
      });
      await new Promise((r) => setTimeout(r, 1000));
      const out = execFileSync(tool, [String(displayId)], { timeout: 90_000 }).toString();
      process.stderr.write(`[sck] display ${displayId}\n${out}`);
      expect(out.split("\n").filter((l) => /left=/.test(l)).length, out).toBe(6);
    } finally { swatch.kill("SIGKILL"); }
  }, 240_000);
});
