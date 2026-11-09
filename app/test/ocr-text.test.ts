import { describe, test, expect } from "vitest";
import { clipboardText, firstLine, textOutcome, textFailure, TOAST_LINE_MAX } from "../src/ocr-text.js";
import { parseToastMessage } from "../src/toast-message.js";

/** Canned Vision output, shaped as the helper's `recognize-text` reply sends it. */
const line = (text: string, y = 0) => ({ text, confidence: 0.98, box: { x: 0.05, y, width: 0.6, height: 0.08 } });

describe("clipboardText (STC-572)", () => {
  test("multi-line input keeps its line breaks, in Vision's order", () => {
    const lines = [line("function hello() {", 0.1), line("  return 42;", 0.2), line("}", 0.3)];
    expect(clipboardText(lines)).toBe("function hello() {\n  return 42;\n}");
  });

  test("lines are never joined into paragraphs", () => {
    const lines = [line("The quick brown fox jumps over"), line("the lazy dog.")];
    expect(clipboardText(lines)).toBe("The quick brown fox jumps over\nthe lazy dog.");
  });

  test("Vision's order is kept, not re-sorted by box", () => {
    // Two columns: Vision reads the left one first even though the right
    // one's first line sits higher on screen.
    const lines = [line("Left one", 0.2), line("Left two", 0.3), line("Right one", 0.1)];
    expect(clipboardText(lines)).toBe("Left one\nLeft two\nRight one");
  });

  test("trailing whitespace goes, leading indentation stays, blank lines are dropped", () => {
    expect(clipboardText([line("a  "), line("   "), line(""), line("  b")])).toBe("a\n  b");
  });

  test("nothing recognised is the empty string", () => {
    expect(clipboardText([])).toBe("");
    expect(clipboardText([line(" "), line("\t")])).toBe("");
  });
});

describe("firstLine", () => {
  test("is the first line of the copied text", () => {
    expect(firstLine("Hello there\nsecond")).toBe("Hello there");
  });

  test("a long line is cut with an ellipsis at the limit", () => {
    const out = firstLine("x".repeat(200));
    expect([...out]).toHaveLength(TOAST_LINE_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  test("never cuts an emoji in half", () => {
    const out = firstLine("\u{1F600}".repeat(100));
    expect(out).toBe("\u{1F600}".repeat(TOAST_LINE_MAX - 1) + "…");
  });
});

describe("textOutcome", () => {
  test("recognised text is copied, and the toast shows its first line", () => {
    const o = textOutcome({ lines: [line("First line"), line("Second line")] });
    expect(o).toEqual({
      kind: "copied", text: "First line\nSecond line",
      toast: { title: "Text copied", body: "First line", tone: "success" },
    });
  });

  test("nothing recognised is 'No text found', and nothing is copied", () => {
    const o = textOutcome({ lines: [] });
    expect(o.kind).toBe("empty");
    expect(o.toast.title).toBe("No text found");
    expect("text" in o).toBe(false);
  });

  test("whitespace-only lines are 'No text found' too", () => {
    expect(textOutcome({ lines: [line("  ")] }).kind).toBe("empty");
  });

  test("a reply without lines is a failure, not an empty result", () => {
    expect(textOutcome(undefined).kind).toBe("failed");
    expect(textOutcome({}).kind).toBe("failed");
    expect(textOutcome({ lines: [{ nope: 1 }] }).kind).toBe("failed");
  });

  test("every toast survives the toast window's own parser", () => {
    for (const o of [
      textOutcome({ lines: [line("Hi")] }), textOutcome({ lines: [] }), textFailure("the helper is not running"),
    ]) {
      expect(parseToastMessage(o.toast)).toEqual(o.toast);
    }
  });
});
