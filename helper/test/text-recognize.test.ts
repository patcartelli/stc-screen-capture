import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";
import { clipboardText, type RecognisedLine } from "../../app/src/ocr-text.js";

/**
 * STC-572: the helper's `recognizeText` on a frame with known text, through
 * the app's `clipboardText`, so the two halves of Capture Text are checked
 * against each other on every `npm test`. Vision needs no grant and no
 * display; only the capture in front of it does, and that is the runbook's.
 */
/**
 * A new binary's FIRST Vision call takes ~40-45 s (the ANE compile, measured
 * 2026-11-03); later calls take under a second. Every run of this file compiles
 * a new harness binary, so on CI it is always the cold case, and the default
 * `HARNESS_RUN_MS` (45 s) killed it at 47 s on this Mac under the full suite.
 * The run gets 100 s, and the test's own timeout stays clear above it so the
 * harness's message (which step hung) is the one that reports.
 */
const COLD_VISION_RUN_MS = 100_000;

describe("recognize-text (STC-572)", () => {
  test("Vision reads two drawn lines, top first, and the clipboard string keeps the break", async () => {
    const out = await runSwiftHarness({
      label: "text-recognize",
      sources: ["helper/src/TextRecognize.swift", "helper/test/text-recognize/main.swift"],
      runMs: COLD_VISION_RUN_MS,
    });
    const m = out.match(/^lines (.*)$/m);
    expect(m, out).not.toBeNull();
    const lines = JSON.parse(m![1]!) as RecognisedLine[];

    expect(clipboardText(lines)).toBe("Capture text quickly\nSecond line here");
    // The box is y DOWN: the top line has the smaller y.
    expect(lines[0]!.box!.y).toBeLessThan(lines[1]!.box!.y);
    for (const l of lines) {
      expect(l.confidence).toBeGreaterThan(0);
      for (const v of Object.values(l.box!)) expect(v).toBeGreaterThanOrEqual(0);
    }
  }, COLD_VISION_RUN_MS + 60_000);   // + the compile (up to 45 s) and margin
});
