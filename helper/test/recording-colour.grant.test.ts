/**
 * STC-510, step 1: FIND OUT what a recording on this display is tagged and holds.
 * Requires a Screen Recording grant, so it runs under `npm run test:capture`,
 * never `npm test` (a separate file, not a skip — see capture.grant.test.ts).
 *
 * It asserts the MECHANISM, not the colour. Whether a P3 take is "correct" is
 * the ticket's open question; asserting an answer before anyone has seen one is
 * how a test comes to certify the bug. The result is printed instead, for the
 * ticket, and the assertion that will hold the fix goes in once it is known.
 * Run it on a P3 display (the built-in one): on an sRGB display the two halves
 * are the same green and the numbers say nothing about the fault.
 */
import { describe, test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";
import { explainFailedStart } from "./_start-outcome.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("recording colour (STC-510)", () => {
  test("reports the colour tags and the swatch colours of a real take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-colour-"));

    // The swatch is its own process: the helper must not record a window of
    // ours drawn by vitest's worker, and AppKit does not belong in that worker.
    const swatchBin = join(dir, "colour-swatch");
    execFileSync("swiftc", ["-O", join(root, "helper/test/colour-swatch/main.swift"), "-o", swatchBin],
      { timeout: 60_000 });
    const swatch = spawn(swatchBin, ["10"], { stdio: ["ignore", "pipe", "ignore"] });
    let displayId = 0;
    try {
      displayId = await new Promise<number>((res, rej) => {
        const t = setTimeout(() => rej(new Error("swatch window never reported ready")), 10_000);
        let seen = "";
        swatch.stdout!.on("data", (c: Buffer) => {
          seen += c.toString();
          if (seen.includes("NO_WIDE_GAMUT_DISPLAY")) {
            clearTimeout(t);
            rej(new Error("no wide-gamut display is connected: on an sRGB display the two swatches are the same green and this test says nothing"));
          }
          const m = /SWATCH_DISPLAY=(\d+)/.exec(seen);
          if (m && seen.includes("SWATCH_READY")) { clearTimeout(t); res(Number(m[1])); }
        });
      });
      process.stderr.write(`[colour] recording wide-gamut display ${displayId}\n`);
      await sleep(1000); // let the window reach the display before the first frame

      const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
      const fd3: any[] = [];
      let buf = "";
      (proc.stdio[3] as NodeJS.ReadableStream).on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          try { fd3.push(JSON.parse(l)); } catch { /* not JSON */ }
        }
      });
      proc.stdout!.resume(); proc.stderr!.resume();
      const waitFor = async (fn: () => any, ms: number, what: string) => {
        const t0 = Date.now();
        for (;;) {
          const v = fn();
          if (v) return v;
          if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
          await sleep(20);
        }
      };
      try {
        await waitFor(() => fd3.find((l) => l.ev === "ready"), 10_000, "ready");
        proc.stdin!.write(JSON.stringify({ cmd: "start", dir, displayId, seq: 1 }) + "\n");
        const started = await waitFor(() => fd3.find((l) => l.seq === 1), 20_000, "start outcome");
        if (started.ev !== "started") throw explainFailedStart(started, "the colour recording");
        await sleep(3000);
        proc.stdin!.write(JSON.stringify({ cmd: "stop", seq: 2 }) + "\n");
        const stopped = await waitFor(() => fd3.find((l) => l.seq === 2), 30_000, "stopped");
        expect(stopped.ev).toBe("stopped");
        process.stderr.write(`[colour] stopped: ${JSON.stringify(stopped)}\n`);
      } finally { proc.kill("SIGKILL"); }
    } finally { swatch.kill("SIGKILL"); }

    const { capture } = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    const w = capture.width as number, h = capture.height as number;
    // Well inside each half, away from the seam and the edges.
    const rect = (fx: number) => [Math.round(w * fx), Math.round(h * 0.4), Math.round(w * 0.3), Math.round(h * 0.2)];
    process.stderr.write(`[colour] take: ${dir}\n`); // before the probe, so a probe failure still names the take
    const out = await runSwiftHarness({
      label: "colour-probe",
      sources: ["helper/test/colour-probe/main.swift"],
      args: [join(dir, "display.mp4"), "0", ...rect(0.1), ...rect(0.6)].map(String),
    });

    process.stderr.write(`[colour] take: ${dir}\n[colour] capture ${w}x${h}\n${out}`);
    expect(out).toMatch(/TAG_PRIMARIES=/);
    expect(out).toMatch(/RECT1_P3=[\d.]+,[\d.]+,[\d.]+/);
    expect(out).toMatch(/RECT2_P3=[\d.]+,[\d.]+,[\d.]+/);
  }, 180_000);
});
