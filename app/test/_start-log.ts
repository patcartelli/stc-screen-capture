import { existsSync, readFileSync } from "node:fs";

/**
 * The stand-in helper's `start` log (`STC_FAKE_START_LOG`,
 * `_fake-helper.mjs`), waited for rather than raced (STC-434).
 *
 * ## The race this replaces
 *
 * Four files wrote the same two lines:
 *
 *     await expect.poll(() => existsSync(startLog), …).toBe(true);
 *     const cmd = JSON.parse(readFileSync(startLog, "utf8").trim().split("\n")[0]!);
 *
 * and `existsSync` becoming true is NOT the file having content. The helper
 * appends with `writeFileSync(path, line, { flag: "a" })`, which opens,
 * writes and closes — so between the open and the write there is a real
 * window where the file exists and is EMPTY. Read in that window,
 * `"".trim().split("\n")[0]` is `""` and `JSON.parse("")` throws
 * `Unexpected end of JSON input` — a failure that looks nothing like the
 * assertion it interrupts, in a test that passes on a re-run.
 *
 * That is this repo's own STC-337 lesson, in a fourth place: *before reading
 * a value straight after `expect.poll`, ask whether the polled signal and the
 * asserted one are set at the same point in the code.* Here they are set by
 * two different syscalls in another process.
 *
 * `camera-toggle.e2e.test.ts` and `display-picker.e2e.test.ts` are two of the
 * files STC-434 records flaking on CI, and the tests it names are exactly the
 * ones that read this log. `mic-picker` and `scope-picker` had the same two
 * lines and had not been caught yet.
 *
 * ## What the poll is on instead
 *
 * The CONTENT, parsed. A start that has not landed yet is indistinguishable
 * from one that never will only by waiting, so the wait is bounded and says
 * what it saw.
 */

/**
 * Every `start` command the helper has been asked for so far.
 *
 * Absent, empty, and mid-write all read as "nothing yet" rather than
 * throwing. A trailing line that does not parse is one being written right
 * now — dropped rather than raised, which is the whole point of this module;
 * a line that is complete and malformed would be a real fault, and there is
 * no such producer (the helper writes `JSON.stringify(cmd) + "\n"`).
 */
export function readStarts(log: string): any[] {
  if (!existsSync(log)) return [];
  const out: any[] = [];
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* still being written */ }
  }
  return out;
}

/**
 * Wait until at least `count` starts have actually LANDED, then return them.
 *
 * Returns the whole list rather than one entry so a caller wanting the last
 * start (`scope-picker`) and one wanting the first (`camera-toggle`) share
 * this wait instead of growing a second one.
 */
export async function waitForStarts(log: string, count = 1, timeoutMs = 30_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const starts = readStarts(log);
    if (starts.length >= count) return starts;
    if (Date.now() > deadline) {
      throw new Error(
        `only ${starts.length} of ${count} start command(s) landed in ${log} within ${timeoutMs} ms`
        + (existsSync(log) ? ` (raw: ${JSON.stringify(readFileSync(log, "utf8"))})` : " (no such file)"));
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The FIRST start, once it has landed — the common case. */
export async function waitForStart(log: string, timeoutMs?: number): Promise<any> {
  return (await waitForStarts(log, 1, timeoutMs))[0];
}
