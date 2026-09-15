import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { parseShot } from "../../transform/src/shot.js";

/**
 * STC-301 gates 3 and 6, which CANNOT be CI gates — and that is a finding
 * about the ticket rather than a shortcut.
 *
 * The ticket opens with "each is enforced in CI on macOS runners, not checked
 * by eye". Gates 3 and 6 both call `capture-still`, which needs a Screen
 * Recording grant for whatever process runs the tests. GitHub's runners do not
 * have one and cannot be given one — which is exactly why this repo already
 * separates `*.grant.test.ts` out of `npm test` rather than letting them skip
 * inside it, since "skips read as covered and rot".
 *
 * So they are real, runnable checks that a person runs on a Mac with
 * `npm run test:capture`, and `docs/STC-301-GATES.md` says plainly which of
 * the six are CI-enforced and which are not. Building them as CI gates that
 * silently skip on every push would be the worse outcome: a green tick that
 * means nothing, which is the failure mode CLAUDE.md calls "success by finding
 * nothing to do".
 *
 * ## Gate 3 — capture latency
 *
 * > "`capture-still` from verb to buffer, measured on the runner, under the
 * > STC-289 budget. Recorded as a number in the run output like the 11.0
 * > ms/frame export figure, so drift is visible rather than binary."
 *
 * The number is PRINTED on success as well as failure, because the ticket asks
 * for drift to be visible rather than binary — a check that only speaks when it
 * fails cannot show a trend.
 *
 * STC-383 split that into TWO numbers with two budgets, because one assertion
 * was covering two quantities and could only ever be right about one of them.
 * The ticket's own words are "from verb to buffer", and the wall clock of the
 * whole request is verb to ANSWER — the PNG encode and shot.json come after the
 * buffer. On a 6016x3384 display the encode alone is ~140 ms of a ~250 ms
 * request, so the wall failed a 200 ms budget consistently on hardware while
 * the buffer sat at 92-101 ms. Raising the one number would have made it stop
 * meaning what STC-289 wrote; dropping it would have lost the only latency
 * check this slice has. So: 200 ms stays, on `captureMs`, and what the user
 * waits gets its own stated budget beside it.
 *
 * It also carries STC-341's finding, which was filed against this same gate
 * six days earlier from different hardware and diagnosed the other half: the
 * old `max(timings.slice(1))` assumed exactly one warming call and judged the
 * run on the least settled sample after it. Both budgets now use the median of
 * the settled half (`steadyMedian`) over ten samples. The two tickets are the
 * same failure seen twice — the quantity was wrong AND the statistic was —
 * and neither fix alone gets this gate green on both machines.
 *
 * ## Gate 6 — capture during recording
 *
 * > "A still taken mid-recording produces a valid shot and leaves the
 * > recording's frame timing undisturbed — asserted against the recording's own
 * > frame log, not just 'it didn't crash'."
 */

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/**
 * The STC-289 budget, from its runbook: "well under 200 ms from verb to
 * buffer". Taken as 200 ms rather than a tighter number invented here — the
 * point of a budget is that it was agreed before the measurement, and a
 * threshold chosen after seeing the result measures nothing.
 *
 * STC-383 did NOT change this number. What changed is WHICH number it is
 * asserted against. It used to be checked against the wall clock of the whole
 * request, and the budget's own words are "verb to BUFFER" — the wall also
 * carries the PNG encode and the shot.json write, which happen after the
 * buffer is in hand. So the gate was holding a 200 ms budget to a quantity the
 * budget never named, and on a 6016x3384 display it failed consistently on
 * hardware while `captureMs` — verb to buffer, literally — sat at 92-101 ms,
 * comfortably inside. `docs/STC-289-RUNBOOK.md` §latency had already drawn
 * exactly this distinction for the neighbouring phase, calling `contentMs`
 * "not the ticket's number but IS what the user waits".
 *
 * This is now asserted against `timing.captureMs` from the reply, which is the
 * quantity STC-289 wrote down.
 */
const STILL_BUDGET_MS = 200;

/**
 * What the USER waits: verb to answer, PNG encode and shot.json included.
 *
 * A SEPARATE budget rather than a loosened one (STC-383). The 200 ms above is
 * STC-289's, agreed before any measurement, and it still means what it said.
 * This one is new, and being new it can only be calibrated from measurement —
 * so the derivation is stated here rather than left as a round number someone
 * later has to reverse-engineer.
 *
 * Measured on the one machine gate 3 has ever run on (2026-09-15, 6016x3384
 * display, ~20.4 MP): steady-state wall of 250.9, 250.8, 252.4, 251.0 ms on
 * the STC-317 build and 252.4, 252.0, 250.2, 252.5 ms on a master control
 * build — a spread under 1% across two builds and two sessions. 400 ms is that
 * worst case plus ~60%: headroom for a loaded machine and a somewhat larger
 * display, and still inside the range where a shutter feels immediate.
 *
 * It is deliberately NOT tight, and the reason is worth keeping. The tight
 * instrument here is the 200 ms on `captureMs`; drift in the ENCODE is watched
 * by the per-phase numbers this gate prints on success, not by this bound. A
 * doubling of the PNG encode alone would land near 392 ms and would NOT fail
 * this assertion — which is precisely why the breakdown is printed every run
 * rather than only on failure. A single end-to-end number cannot be both a
 * gross-regression backstop and a precision instrument, and pretending
 * otherwise is how a bound gets tightened until it flakes and is then deleted.
 *
 * KNOWN LIMITATION, stated rather than buried: the PNG encode scales with the
 * frame's AREA, so this number is about a ~20 MP display. The gate prints the
 * frame's dimensions and megapixels so a reader can see at a glance whether
 * the budget is still about their hardware. On a materially larger display,
 * revisit this constant rather than assuming it transferred.
 */
const STILL_END_TO_END_MS = 400;

/**
 * How many samples gate 3 takes, and which of them the budgets are applied to.
 *
 * Five was not enough, and the evidence is STC-341's own hardware run: it saw
 * THREE phases where the code assumed two — 334.3 cold, then 232.3/232.1,
 * then 209.8/209.9. Something is still warming after the first call, so
 * `slice(1)` was measuring warm-up and calling it steady; and because the old
 * assertion took the MAX, the whole run was judged on sample 2, the least
 * settled of the four. That file also printed a median and asserted on a max,
 * so a reader chasing the printed number was chasing a different one from the
 * one that failed.
 *
 * STC-383's own run does NOT show that second phase — its samples 1-4 are flat
 * within 1% on both series — and the two runs are on different displays. That
 * disagreement is the actual argument for this statistic: it must be right
 * whether or not a second warm-up phase exists on the machine in front of you.
 * The median of the SETTLED HALF is robust to a warm-up tail that may or may
 * not be there, and to a single stalled sample, without being so tolerant that
 * a real regression passes — a majority of the settled samples must be over
 * budget before it fails.
 *
 * The worst and the overall median are still PRINTED, so nothing is hidden by
 * the statistic the budget happens to use.
 */
const GATE_3_SAMPLES = 10;

/**
 * The steady-state statistic, in ONE place because both budgets use it — a
 * second copy of this rule is how the two series would quietly come to be
 * judged differently.
 */
function steadyMedian(ms: number[]): { value: number; samples: number[] } {
  const samples = ms.slice(Math.ceil(ms.length / 2));
  const sorted = [...samples].sort((a, b) => a - b);
  return { value: sorted[Math.floor(sorted.length / 2)]!, samples };
}

interface Line { ev: string; seq?: number; [k: string]: any }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

function spawnHelper() {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  let seq = 100;
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    request: async (c: object, ms = 20_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
    kill: () => proc.kill("SIGKILL"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 20_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const tmpDir = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Same probe and skip wording the other still grant test uses. */
async function probe(): Promise<{ ok: true } | { ok: false; why: string }> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  const r = await h.request({ cmd: "capture-still", dir: tmpDir("stc-probe-") });
  h.kill();
  if (r.ev === "still") return { ok: true };
  return { ok: false, why: `${r.code}: ${r.detail}` };
}

function skipUnless(p: { ok: true } | { ok: false; why: string }): void {
  if (!p.ok) {
    throw new Error(
      `SKIP-GRANT: capture-still answered ${p.why}. Without a Screen Recording grant ` +
      "for the process running the tests (and macOS 14+), gates 3 and 6 are unverified.",
    );
  }
}

/**
 * Printed so a run shows the number, not just a verdict — and it names the
 * STEADY median explicitly, because that is the one the budget is applied to.
 * Printing one statistic and asserting on another is what made STC-341's
 * failure hard to read.
 */
function report(label: string, ms: number[], budget: number): void {
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const steady = steadyMedian(ms);
  process.stderr.write(
    `[gate 3] ${label}: ${ms.map((n) => n.toFixed(1)).join(", ")} ms ` +
    `(overall median ${median.toFixed(1)}, worst ${sorted[sorted.length - 1]!.toFixed(1)}, ` +
    `STEADY median ${steady.value.toFixed(1)} of ${steady.samples.map((n) => n.toFixed(1)).join(", ")}, ` +
    `budget ${budget})\n`);
}

/**
 * Reads a phase out of the reply's `timing` map, REQUIRING a number rather
 * than defaulting to one.
 *
 * Gate 6 below already paid for this lesson: its first draft read the frame
 * counts off `anchors.capture` with `?? 0`, and `anchors-2` carries no such
 * fields — so every assertion compared 0 to 0 and passed however badly the
 * recording had gone. The same shape here would be worse, because a budget
 * compared against `undefined` does not obviously read as broken. If a
 * checkpoint in `helper/src/Still.swift` is renamed or dropped, this gate must
 * say so loudly instead of quietly measuring nothing.
 */
function timingMs(reply: Line, key: string): number {
  const v = (reply.timing as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== "number") {
    throw new Error(
      `the still reply carries no numeric timing.${key}, so this gate cannot see the ` +
      `phase it budgets. Check the mark() calls in helper/src/Still.swift. Reply: ` +
      JSON.stringify(reply));
  }
  return v;
}

/**
 * The encoded frame's pixel size, straight off the reply.
 *
 * STC-383 asked for "the actual pixel dimensions of the PNG being encoded",
 * and it needs no helper change at all: `capture-still` has always returned
 * the whole shot document (`Still.swift` → `reply["shot"] = doc`), and
 * `shotDocument` carries `frame.width`/`frame.height`. The gate simply never
 * printed it. Required rather than defaulted, for the reason above.
 */
function frameSize(reply: Line): { width: number; height: number } {
  const f = (reply.shot as { frame?: { width?: unknown; height?: unknown } } | undefined)?.frame;
  if (typeof f?.width !== "number" || typeof f?.height !== "number") {
    throw new Error(
      "the still reply carries no numeric shot.frame.width/height, so this gate cannot " +
      `say what size frame it just timed. Reply: ${JSON.stringify(reply)}`);
  }
  return { width: f.width, height: f.height };
}

describe("STC-301 gate 3: capture latency", () => {
  test("capture-still is inside both budgets, and says where the time went", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    // Several, because one measurement is an anecdote — and the early ones are
    // judged apart from the rest: `SCShareableContent` enumeration happens once,
    // and STC-341 measured a SECOND warming phase after it, so a cold call and a
    // half-warm call are both different numbers from the steady state and
    // averaging them hides all three. See GATE_3_SAMPLES.
    const walls: number[] = [];
    const buffers: number[] = [];
    let frame = { width: 0, height: 0 };
    for (let i = 0; i < GATE_3_SAMPLES; i++) {
      const t0 = performance.now();
      const r = await h.request({ cmd: "capture-still", dir: tmpDir("stc-lat-") });
      const wall = performance.now() - t0;
      expect(r.ev, JSON.stringify(r)).toBe("still");

      // Broken out rather than dumped as raw JSON (STC-383). The old line
      // printed the `timing` map verbatim, and every reader then had to
      // subtract the cumulative marks by hand against the runbook to find out
      // where the time went — which is how a PNG encode sat at 55-60% of the
      // total, unnoticed, through every previous run of this gate.
      const contentMs = timingMs(r, "contentMs");
      const captureMs = timingMs(r, "captureMs");
      const writeMs = timingMs(r, "writeMs");
      const totalMs = timingMs(r, "totalMs");
      frame = frameSize(r);

      process.stderr.write(
        `[gate 3] sample ${i}: wall ${wall.toFixed(1)} ms` +
        ` | content enum ${contentMs.toFixed(1)}` +
        ` | screenshot ${(captureMs - contentMs).toFixed(1)}` +
        ` | PNG encode ${(writeMs - captureMs).toFixed(1)}` +
        ` | shot.json ${(totalMs - writeMs).toFixed(1)}` +
        ` || verb-to-buffer ${captureMs.toFixed(1)}\n`);
      walls.push(wall);
      buffers.push(captureMs);
    }
    h.kill();

    // What was being encoded, so neither budget below is read as a property of
    // the code alone. The PNG encode scales with frame AREA: on the 6016x3384
    // display this gate first ran on, it was ~140 ms of a ~250 ms request.
    const megapixels = (frame.width * frame.height) / 1e6;
    process.stderr.write(
      `[gate 3] frame encoded: ${frame.width}x${frame.height} px ` +
      `(${megapixels.toFixed(1)} MP) — the PNG encode scales with this area, so both ` +
      "budgets below are about a display size as much as about the code\n");

    report("verb to buffer (captureMs, early ones warm up)", buffers, STILL_BUDGET_MS);
    report("verb to answer (wall, early ones warm up)", walls, STILL_END_TO_END_MS);

    // Both budgets are on the STEADY state, via the one statistic in
    // `steadyMedian` — the early captures pay for warming that the later ones do
    // not, and holding them to the same number would either fail honestly-fast
    // builds or force the budget up until it stopped meaning anything.
    const buffer = steadyMedian(buffers);
    const wall = steadyMedian(walls);

    // Half one: STC-289's own budget, against STC-289's own quantity. This is
    // the tight instrument, and it is unchanged at 200 ms.
    expect(buffer.value,
      `steady-state verb-to-buffer was ${buffer.value.toFixed(1)} ms, over the ` +
      `${STILL_BUDGET_MS} ms STC-289 budget. All ${GATE_3_SAMPLES}: ` +
      `${buffers.map((n) => n.toFixed(1)).join(", ")}; settled half ` +
      `${buffer.samples.map((n) => n.toFixed(1)).join(", ")}. ` +
      "This is the screenshot plus content enumeration and excludes the PNG encode, so " +
      "docs/STC-289-RUNBOOK.md §latency's first two phases are where to look.")
      .toBeLessThan(STILL_BUDGET_MS);

    // Half two: what the user actually waits. A gross-regression backstop —
    // see STILL_END_TO_END_MS on why it is deliberately not tight, and read the
    // per-sample breakdown above for drift inside it.
    expect(wall.value,
      `steady-state verb-to-answer was ${wall.value.toFixed(1)} ms, over the ` +
      `${STILL_END_TO_END_MS} ms end-to-end budget. All ${GATE_3_SAMPLES}: ` +
      `${walls.map((n) => n.toFixed(1)).join(", ")}; settled half ` +
      `${wall.samples.map((n) => n.toFixed(1)).join(", ")}, on a ` +
      `${megapixels.toFixed(1)} MP frame. ` +
      "The per-sample breakdown above says which phase grew; if it is the PNG encode and " +
      "the frame is much larger than ~20 MP, the budget is the thing to revisit (STC-383).")
      .toBeLessThan(STILL_END_TO_END_MS);
  }, 180_000);
});

describe("STC-301 gate 6: a still taken during a recording", () => {
  test("produces a valid shot and leaves the recording's frame timing undisturbed", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    const takeDir = tmpDir("stc-rec-");
    const started = await h.request({ cmd: "start", dir: takeDir }, 30_000);
    expect(started.ev, JSON.stringify(started)).toBe("started");

    // Let the recording reach a steady state before disturbing it, so the
    // comparison is against real frames rather than the first-frame ramp.
    await sleep(2000);
    const stillDir = tmpDir("stc-midtake-");
    const shotReply = await h.request({ cmd: "capture-still", dir: stillDir });
    expect(shotReply.ev, JSON.stringify(shotReply)).toBe("still");
    await sleep(2000);

    const stopped = await h.request({ cmd: "stop" }, 30_000);
    expect(stopped.ev, JSON.stringify(stopped)).toBe("stopped");
    h.kill();

    // Half one: the still is real and loads.
    expect(existsSync(join(stillDir, "shot.json"))).toBe(true);
    const shot = parseShot(JSON.parse(readFileSync(join(stillDir, "shot.json"), "utf8")));
    expect(existsSync(join(stillDir, shot.frame.file))).toBe(true);

    // Half two — the ticket's own words, "asserted against the recording's own
    // frame log, not just 'it didn't crash'".
    //
    // From the `stopped` REPLY, which is where `Capture.swift` reports
    // `frames`/`dropped`/`nonMonotonic`. The first draft of this read them off
    // `anchors.capture` with `?? 0`, and `anchors-2` carries no such fields —
    // so every assertion would have compared 0 to 0 and passed however badly
    // the recording had gone. Read from the wrong place, defaulted, and
    // therefore vacuous: the exact shape of check this repo keeps paying for.
    // They are required here rather than defaulted, so a rename fails loudly.
    for (const k of ["frames", "dropped", "nonMonotonic"] as const) {
      expect(typeof stopped[k],
        `the stopped reply has no numeric ${k} — this gate cannot see the frame log: ` +
        JSON.stringify(stopped)).toBe("number");
    }
    expect(stopped.frames as number,
      "the recording captured no frames at all, so 'undisturbed' means nothing").toBeGreaterThan(0);
    // Nothing dropped and nothing out of order: a still that stalled the
    // capture graph would show up as either.
    expect(stopped.dropped as number,
      "the mid-take still cost the recording frames").toBe(0);
    expect(stopped.nonMonotonic as number,
      "the mid-take still disturbed the frame clock").toBe(0);

    const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
    const events = JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8"));
    expect(anchors.stop?.reason, JSON.stringify(anchors.stop)).toBe("user");
    expect(Array.isArray(events.events)).toBe(true);

    // And the take is still a take: a display.mp4 with bytes in it.
    const mp4 = join(takeDir, anchors.files?.display ?? "display.mp4");
    expect(existsSync(mp4), "the recording lost its display.mp4").toBe(true);
    process.stderr.write(
      `[gate 6] recording survived a mid-take still: ` +
      `${stopped.frames} frames, ${stopped.dropped} dropped, ` +
      `${stopped.nonMonotonic} non-monotonic\n`);
  }, 240_000);
});
