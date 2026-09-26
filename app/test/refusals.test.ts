import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { START_FAULTS, recordRefusalText, stillNoticeText } from "../src/refusals.js";

/**
 * One sentence per refusal, for every door (STC-465 review). The wiring — that
 * the menu bar and the hotkeys actually SAY these, with or without a window —
 * is `warnings.e2e.test.ts`'s; this file pins what is said, and that nothing
 * is said when nothing should be.
 */
describe("a Record that did not start", () => {
  test("says nothing when it started, or when the user cancelled", () => {
    expect(recordRefusalText({ ok: true })).toBeUndefined();
    expect(recordRefusalText({ ok: false, cancelled: true })).toBeUndefined();
  });

  test("says nothing for a second press while its own overlay or countdown is up", () => {
    // `record-in-flight` is `runRecordFlow`'s answer when the flow on screen
    // IS this Record — the flow is the answer, and a toast would float over
    // the overlay the take is being framed with.
    expect(recordRefusalText({ ok: false, code: "record-in-flight" })).toBeUndefined();
  });

  test("a known refusal gets its START_FAULTS sentence, verbatim", () => {
    for (const code of Object.keys(START_FAULTS)) {
      expect(recordRefusalText({ ok: false, code, detail: "ignored" })).toBe(START_FAULTS[code]);
    }
    expect(recordRefusalText({ ok: false, code: "event-tap-unavailable" }))
      .toMatch(/^Nothing was recorded/);
  });

  test("an unknown one still says SOMETHING, with its code and detail", () => {
    expect(recordRefusalText({ ok: false, code: "start-failed", detail: "boom" }))
      .toBe("Could not start: start-failed\nboom");
    expect(recordRefusalText({ ok: false, code: "already-recording" }))
      .toBe("Could not start: already-recording\n");
  });
});

describe("a shot", () => {
  test("says nothing when it was cancelled, or succeeded with nothing to add", () => {
    expect(stillNoticeText({ ok: false, cancelled: true })).toBeUndefined();
    expect(stillNoticeText({ ok: true })).toBeUndefined();
    expect(stillNoticeText({ ok: true, warning: "" })).toBeUndefined();
  });

  test("passes the helper's own warning through on success", () => {
    expect(stillNoticeText({ ok: true, warning: "no alpha" })).toBe("no alpha");
  });

  test("names the refusals it knows, and falls back to the code for the rest", () => {
    expect(stillNoticeText({ ok: false, code: "no-displays" }))
      .toMatch(/Screen Recording permission is required/);
    expect(stillNoticeText({ ok: false, code: "still-unsupported" })).toBe("Shots need macOS 14 or newer.");
    expect(stillNoticeText({ ok: false, code: "overlay-open" })).toBe("A shot is already in progress.");
    expect(stillNoticeText({ ok: false, code: "helper-not-running", detail: "x" }))
      .toBe("Could not take the shot: helper-not-running\nx");
  });
});

describe("the mapping lives in ONE place", () => {
  // The window used to own it, which is exactly why only the window door
  // could speak. A copy left behind in either process is the "one value, two
  // copies" defect, and it would drift the first time a message changed.
  const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const DEFINES_A_COPY = /\bSTART_FAULTS\s*[:=]|Shots need macOS 14/;

  test("the pattern can fire", () => {
    expect(src("refusals.ts")).toMatch(DEFINES_A_COPY);
  });

  test("and neither renderer.ts nor main.ts defines its own", () => {
    expect(src("renderer.ts")).not.toMatch(DEFINES_A_COPY);
    expect(src("main.ts")).not.toMatch(DEFINES_A_COPY);
  });
});
