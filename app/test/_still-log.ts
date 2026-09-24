import { existsSync, readFileSync } from "node:fs";
import { CLIPBOARD_SUBDIR } from "../src/still-io.js";

/**
 * The stand-in helper's request log (`STC_FAKE_STILL_LOG`,
 * `_fake-helper.mjs`), as parsed lines — one JSON object per command it was
 * asked to run.
 *
 * Lifted out of `thumbnail.e2e.test.ts` into a shared helper by STC-412's
 * final review (I3), when two more files needed it. What they needed it FOR
 * is the same thing in each: several assertions across this suite claimed
 * "and nothing was exported", and proved it by reading back a fixture
 * destination folder that stayed empty. That worked while `still.destination`
 * (stills) and the recordings root were independent settings — pointing one
 * somewhere and finding the other's traffic never arrived discriminated a
 * real misdirection bug. STC-412 unified both into one `saveFolder`, every
 * such fixture correctly sets it to null, and so NOTHING the app can do
 * resolves to that folder any more: the reads passed unconditionally, which
 * is a dead assertion reading as coverage.
 *
 * An export request is the thing those assertions were always about, and it
 * is something the app genuinely might make — so it can fail, which is the
 * whole difference.
 */
export function readRequests(log: string): any[] {
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

/**
 * Just the `export-still` requests. Identified by `rgba` — the pixel payload
 * only an export carries — rather than by a command name, matching how
 * `_fake-helper.mjs`'s own log already distinguishes them from `capture-still`.
 */
export function exportRequests(log: string): any[] {
  return readRequests(log).filter((x) => x.rgba !== undefined);
}

/**
 * Exports that produced a file the USER is meant to keep — anywhere but the
 * clipboard cache.
 *
 * This distinction is the whole reason this helper exists rather than
 * `exportRequests` being enough, and it is a fact about the product that
 * surprised the assertion that found it: **a panel exports as soon as it
 * paints**, whether or not anyone touches it. `main.ts`'s `still:dragFile`
 * writes the decorated file a drag-out would hand over AHEAD of the gesture
 * (measured at ~250 ms for the RGBA scratch write alone, far too slow to
 * happen inside a `startDrag`), into `CLIPBOARD_SUBDIR` for the same reason a
 * plain Copy goes there: nobody dragging a shot into Slack asked for a copy
 * to accumulate in their shots folder.
 *
 * So "the panel exported nothing" is simply FALSE and always was; the claim
 * every one of these tests actually wants is "the panel put no file where the
 * user keeps things", which is what the destination-folder reads they replace
 * were reaching for. It can fail: wire a save into a path that only meant to
 * show a panel and the file lands outside the cache, here.
 */
export function keptFileRequests(log: string): any[] {
  return exportRequests(log)
    .filter((x) => typeof x.file === "string" && !x.file.includes(CLIPBOARD_SUBDIR));
}
