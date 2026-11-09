/**
 * Capture Text's decisions (STC-572). No Electron, no DOM, no helper.
 *
 * The helper's `recognize-text` captures the overlay's selection in memory,
 * runs Apple's Vision over it and replies with one entry per recognised line,
 * in Vision's order. This file turns that into the string for the clipboard
 * and the words for the toast.
 *
 * ## Line breaks are kept
 *
 * One recognised line is one line of the result, joined with `\n`, never
 * reflowed into paragraphs (Patrick, 2026-11-03). Code pastes as it was, and
 * prose can be fixed after the paste. Vision's order is kept too: it is
 * already reading order, and a sort by box here would scramble columns.
 *
 * ## States
 *
 * copied (text on the clipboard, a toast with its first line), empty (nothing
 * recognised: "No text copied" and the clipboard is NOT touched), failed (a
 * toast says why). A cancelled overlay never reaches here: it shows nothing.
 */
import type { ToastMessage } from "./toast-message.js";

/** One recognised line as the helper sends it. Only `text` is read today. */
export interface RecognisedLine {
  text: string;
  confidence?: number;
  /** Frame UV, y down. Kept for the auto-redaction follow-up the ticket names. */
  box?: { x: number; y: number; width: number; height: number };
}

/** The longest first line the toast shows before it is cut with an ellipsis. */
export const TOAST_LINE_MAX = 80;

/**
 * What goes on the clipboard: each line with trailing whitespace removed,
 * blank lines dropped, joined with `\n`. `""` means nothing was recognised.
 */
export function clipboardText(lines: readonly RecognisedLine[]): string {
  return lines.map((l) => l.text.trimEnd()).filter((t) => t.trim() !== "").join("\n");
}

/** The first line, cut at `TOAST_LINE_MAX` characters (code points, never half a surrogate). */
export function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]!.trim();
  const chars = [...line];
  return chars.length <= TOAST_LINE_MAX ? line : chars.slice(0, TOAST_LINE_MAX - 1).join("").trimEnd() + "…";
}

export type TextOutcome =
  | { kind: "copied"; text: string; toast: ToastMessage }
  | { kind: "empty"; toast: ToastMessage }
  | { kind: "failed"; toast: ToastMessage };

const isLine = (x: unknown): x is RecognisedLine =>
  typeof x === "object" && x !== null && typeof (x as { text?: unknown }).text === "string";

/** What a `recognize-text` reply means. Anything that is not a list of lines is a failure. */
export function textOutcome(reply: Record<string, unknown> | undefined): TextOutcome {
  const lines = reply?.lines;
  if (!Array.isArray(lines) || !lines.every(isLine)) {
    return textFailure("The text recogniser returned no answer.");
  }
  const text = clipboardText(lines);
  if (text === "") {
    return { kind: "empty", toast: { title: "No text copied", body: "The clipboard is unchanged." } };
  }
  return { kind: "copied", text, toast: { title: "Text copied", body: firstLine(text), tone: "success" } };
}

/**
 * How long a recognition may run before the user is told it is still going.
 * A warm one takes 0.1-0.6 s; the first after a new helper build (and so after
 * every update) takes ~40-45 s, and silence that long reads as broken
 * (Patrick, 2026-11-09). The result's own toast replaces this one.
 */
export const TEXT_SLOW_MS = 1500;

export const READING_TEXT_TOAST: ToastMessage = {
  title: "Reading text…",
  body: "The first use after an update can take up to a minute.",
};

/** A visible message for a capture or recognition that failed. */
export function textFailure(detail: string): TextOutcome & { kind: "failed" } {
  return { kind: "failed", toast: { title: "Couldn't capture text", body: detail } };
}
