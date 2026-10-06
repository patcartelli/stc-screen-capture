/**
 * STC-510: what a recording is tagged and what colour it holds, on a wide-gamut
 * display and on a narrow one. Requires a Screen Recording grant, so it runs under
 * `npm run test:capture`, never `npm test` (a separate file, not a skip — see
 * capture.grant.test.ts).
 *
 * Each case REFUSES, rather than skips, when the machine has no display of its
 * kind: a skip reads as covered. The wide case needs the built-in panel; the
 * narrow case needs an sRGB monitor (the second half of "an sRGB display's take is
 * unchanged"). On a machine with only one kind, run the other case elsewhere.
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

/** Records ~3 s of the swatch on a display of `kind` and returns the probe's report. */
async function recordSwatch(kind: "wide" | "narrow"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "stc-colour-"));

  // The swatch is its own process: the helper must not record a window of
  // ours drawn by vitest's worker, and AppKit does not belong in that worker.
  const swatchBin = join(dir, "colour-swatch");
  execFileSync("swiftc", ["-O", join(root, "helper/test/colour-swatch/main.swift"), "-o", swatchBin],
    { timeout: 60_000 });
  const swatch = spawn(swatchBin, ["10", kind], { stdio: ["ignore", "pipe", "ignore"] });
  let displayId = 0;
  try {
    displayId = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error("swatch window never reported ready")), 10_000);
      let seen = "";
      swatch.stdout!.on("data", (c: Buffer) => {
        seen += c.toString();
        if (/NO_(WIDE|NARROW)_GAMUT_DISPLAY/.test(seen)) {
          clearTimeout(t);
          rej(new Error(`no ${kind}-gamut display is connected, so the ${kind} case cannot run on this machine`));
        }
        const m = /SWATCH_DISPLAY=(\d+)/.exec(seen);
        if (m && seen.includes("SWATCH_READY")) { clearTimeout(t); res(Number(m[1])); }
      });
    });
    process.stderr.write(`[colour] recording ${kind}-gamut display ${displayId}\n`);
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
  process.stderr.write(`[colour] capture ${w}x${h}\n${out}`);
  return out;
}

const nums = (out: string, k: string) => {
  const m = new RegExp(`^${k}=(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+)$`, "m").exec(out);
  expect(m, `${k} missing from:\n${out}`).not.toBeNull();
  return m!.slice(1).map(Number);
};
const near = (got: number[], want: number[], what: string) =>
  want.forEach((w, i) => expect(Math.abs(got[i]! - w), `${what}: ${got} vs ${want}`).toBeLessThan(0.03));

describe("recording colour (STC-510)", () => {
  // The fix, held. The left swatch is `color(display-p3 0 1 0)`, the right sRGB
  // #00ff00 expressed in P3. RAW is the stored value with no colour management;
  // RECT is a colour-managed decode, which only agrees with it when the tags tell
  // the truth about the pixels.
  test("a wide-gamut display's take is tagged P3 and holds P3 pixels", async () => {
    const out = await recordSwatch("wide");
    expect(out).toMatch(/TAG_PRIMARIES=P3_D65/);
    expect(out).toMatch(/TAG_TRANSFER=IEC_sRGB/);
    near(nums(out, "RAW1"), [0, 1, 0], "P3 swatch, stored");
    near(nums(out, "RAW2"), [0.458, 0.985, 0.299], "sRGB swatch, stored");
    near(nums(out, "RECT1_P3"), [0, 1, 0], "P3 swatch, colour-managed decode");
    near(nums(out, "RECT2_P3"), [0.458, 0.985, 0.299], "sRGB swatch, colour-managed decode");
  }, 180_000);

  // "Unchanged": what an sRGB take has always been. BT.709 on all three tags (what
  // the unfixed helper wrote on this monitor), and an sRGB display cannot show P3
  // green, so BOTH swatches are sRGB green: stored (0,1,0), the same on each side.
  test("a narrow-gamut display's take keeps its BT.709 tags and holds clipped sRGB pixels", async () => {
    const out = await recordSwatch("narrow");
    expect(out).toMatch(/TAG_PRIMARIES=ITU_R_709_2/);
    expect(out).toMatch(/TAG_TRANSFER=ITU_R_709_2/);
    expect(out).toMatch(/TAG_MATRIX=ITU_R_709_2/);
    near(nums(out, "RAW1"), [0, 1, 0], "left swatch, stored");
    near(nums(out, "RAW2"), [0, 1, 0], "right swatch, stored");
  }, 180_000);
});
