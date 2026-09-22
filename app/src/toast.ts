import type { Size } from "./thumbnail.js";

/**
 * The toast's pure decisions — how big each mode's window is, and how long a
 * message toast stays up. No Electron, no DOM, no clock.
 *
 * `toast-window.ts` used to say there was "no separate pure decision module
 * here", and that was true while a toast had exactly one size and one fixed
 * duration. STC-412's final review made it false: a message toast now sizes
 * itself for prose and derives its own duration from how much of it there is,
 * which is a real decision with real numbers — and this repo puts those where
 * a test can reach them without launching Electron (`thumbnail.ts`/
 * `thumbnail-window.ts`, `pill.ts`/`pill-window.ts`, `countdown.ts`/
 * `countdown-window.ts` are all the same split).
 *
 * ## Two sizes, because they hold two different things
 *
 * The undo toast is one word and a button ("Deleted" + Undo) and has been
 * 240x68 since STC-392. The message toast inherited that size and should not
 * have: it carries the main window's WARNINGS now (STC-412 Task 6 removed the
 * inline `#alert` banner), and those are multi-paragraph instructions —
 * `renderer.ts`'s `event-tap-unavailable` refusal is 572 characters across
 * four paragraphs, the longest string this app can put in front of anyone.
 * At 240x68 about a fifth of it was on screen and the rest was clipped by
 * `#card`'s `overflow: hidden`, silently: nothing about the window said there
 * was more to read, and `textContent` — which is what every e2e assertion in
 * this repo reads — is blind to CSS clipping, so the whole suite stayed green
 * over it.
 *
 * MESSAGE_TOAST_SIZE is derived from that longest real string rather than
 * chosen for looks, and `warnings.e2e.test.ts` MEASURES it in real Chromium
 * with that exact message showing (`#label`'s rendered height against the
 * box's) rather than trusting anyone's arithmetic about font metrics. As
 * measured there, 400x300 holds it with about three lines to spare; at the
 * 240x68 it was inheriting the same text overflows by 370px, which is the
 * ~15%-visible the review reported. `toast.html` still gets an
 * `overflow-y: auto` backstop in case that headroom is not enough on some
 * other font stack — a message that scrolls is a poor experience, one that
 * silently ends mid-sentence is a broken one.
 */
export const UNDO_TOAST_SIZE: Size = { width: 240, height: 68 };

/** See the header: sized to hold `renderer.ts`'s longest warning unscrolled. */
export const MESSAGE_TOAST_SIZE: Size = { width: 400, height: 300 };

/**
 * A short notice's floor — long enough to notice, read and recognise, which
 * is all "Copied", "Display configuration changed" and friends need. It is
 * the duration the message toast shipped with, kept as the minimum rather
 * than as the answer.
 */
export const MESSAGE_TOAST_MIN_MS = 4_000;

/**
 * Reading time per character. ~180 wpm of careful instruction-following, at
 * ~5.7 characters per word with its space, is about 17 characters a second —
 * 59 ms each. Rounded down to 55 because MESSAGE_TOAST_MIN_MS already covers
 * the "notice it and start reading" part that a per-character rate does not.
 */
export const MESSAGE_TOAST_PER_CHAR_MS = 55;

/**
 * The ceiling, and the one number here that is a judgement rather than an
 * arithmetic result.
 *
 * This window is `alwaysOnTop` at screen-saver level and is NOT excluded from
 * a capture, and several of the warnings that reach it (`camera-no-frames`,
 * `av-runtime-error`) fire DURING a live take — so a toast that stays up for
 * its full unclamped reading time would be sitting in the recording. 20 s is
 * about 2.5x the undo toast's own 8 s window and covers the per-character
 * rate in full up to ~290 characters, which is every warning in `renderer.ts`
 * except the `event-tap-unavailable` refusal.
 *
 * That one message is deliberately left short of its own ideal reading time
 * rather than given a 35 s window: it is the one warning that can only happen
 * when a take was REFUSED (so nothing is being recorded over), it is fully
 * visible for those 20 s rather than clipped, it recurs identically on the
 * next Record press, and the ✕ this mode now carries means a reader who is
 * done can clear it early rather than waiting the clock out.
 */
export const MESSAGE_TOAST_MAX_MS = 20_000;

/**
 * How long a message toast stays up: a floor, plus reading time for what it
 * actually says, capped. Pure — the length of the string is the only input,
 * and the same string always answers the same number, which is what lets
 * `toast-window.ts`'s real timer and the page's own draining bar be handed
 * ONE value (ruling 2, the undo toast's own rule) rather than computing it
 * twice.
 */
export function messageToastMs(text: string): number {
  const wanted = MESSAGE_TOAST_MIN_MS + text.length * MESSAGE_TOAST_PER_CHAR_MS;
  return Math.min(wanted, MESSAGE_TOAST_MAX_MS);
}
