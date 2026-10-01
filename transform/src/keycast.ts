/**
 * The keycast (STC-419): which keyboard COMMAND is on screen at a tick, and
 * where it sits. Pure, node-free and DOM-free — the compositor draws what
 * this decides and decides nothing.
 *
 * One key at a time, with a repeat count: ↓, ↓ ×2, ↓ ×3, then → replaces it.
 * Each press stays at full opacity for KEYCAST_HOLD_TICKS and fades over
 * KEYCAST_FADE_TICKS. A repeat counts only while the previous press is still
 * inside its hold. Everything is a function of the 120 Hz tick, so stepping
 * and seeking cannot disagree.
 *
 * Placement is bottom-centre of the OUTPUT canvas, after the zoom crop. It is
 * decided in exactly one function, `keycastLayout`, so a later placement
 * setting has one place to plug in.
 */
import type { KeyEvent, KeyMod } from "./types.js";
import { SessionLoadError } from "./session-error.js";
import { tickOf } from "./time.js";

/** Must equal schema/events-3.schema.json's enum, in order (events-3-schema.test.ts) and KeyDecisions.swift's table. */
export const NAMED_KEYS = [
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Return", "Enter", "Tab", "Escape",
  "Delete", "ForwardDelete", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;
export type NamedKey = typeof NAMED_KEYS[number];

/** Recorded and displayed in this order: macOS menu order, ⌃⌥⇧⌘. */
export const KEY_MODS: readonly KeyMod[] = ["ctrl", "opt", "shift", "cmd"];
/** A chord's character: printable ASCII with the lowercase letters cut out (the schema's own pattern). */
const CHORD_CHAR = /^[!-`{-~]$/;

export const KEYCAST_HOLD_TICKS = 144;   // 1.2 s at 120 Hz
export const KEYCAST_FADE_TICKS = 24;    // 200 ms
/** A SYSTEM font: nothing to load, so neither sink can draw a frame in a fallback face before it arrives. */
export const KEYCAST_FONT_FAMILY = '-apple-system, "Helvetica Neue", Arial, sans-serif';
export const KEYCAST_FONT_WEIGHT = 600;
export const KEYCAST_FONT_FRACTION = 0.022;
export const KEYCAST_MIN_FONT_PX = 14;
export const KEYCAST_BOTTOM_FRACTION = 0.06;
export const KEYCAST_PAD_X_EM = 0.75;
export const KEYCAST_PAD_Y_EM = 0.45;
export const KEYCAST_SIDE_MARGIN_PX = 8;
export const KEYCAST_BG_ALPHA = 0.72;
/** The pill's background as `r, g, b` (alpha is KEYCAST_BG_ALPHA) and its text colour. */
export const KEYCAST_BG_RGB = "0, 0, 0";
export const KEYCAST_TEXT_COLOR = "#ffffff";

const MOD_GLYPH: Record<KeyMod, string> = { ctrl: "⌃", opt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_WORD: Record<NamedKey, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Return: "Return", Enter: "Enter", Tab: "Tab", Escape: "Esc",
  Delete: "Delete", ForwardDelete: "Fwd Delete", Home: "Home", End: "End",
  PageUp: "Page Up", PageDown: "Page Down",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};

export function keyLabel(key: string, mods: readonly KeyMod[]): string {
  const m = KEY_MODS.filter((x) => mods.includes(x)).map((x) => MOD_GLYPH[x]).join("");
  return m + ((KEY_WORD as Record<string, string>)[key] ?? key);
}

const isNamed = (k: unknown): k is NamedKey => (NAMED_KEYS as readonly unknown[]).includes(k);

/** The loader's refusal, mirroring events-3's keyEvent including its privacy if/then. */
export function checkKeyEvent(e: unknown, index: number): KeyEvent {
  const fail = (why: string): never => {
    throw new SessionLoadError(`events.json key event ${index}: ${why}`);
  };
  const o = e as Record<string, unknown>;
  if (!o || typeof o !== "object") fail("not an object");
  if (!Number.isInteger(o.t) || (o.t as number) < 0) fail("t must be a non-negative integer");
  if (!Array.isArray(o.mods)) fail("mods must be an array");
  const mods = o.mods as unknown[];
  if (!mods.every((m) => (KEY_MODS as readonly unknown[]).includes(m))) fail(`unknown mod in ${JSON.stringify(mods)}`);
  if (new Set(mods).size !== mods.length) fail("mods repeat");
  const key = o.key;
  if (isNamed(key)) return { t: o.t as number, kind: "key", key, mods: mods as KeyMod[] };
  if (typeof key !== "string" || !CHORD_CHAR.test(key)) fail(`key ${JSON.stringify(key)} is neither a named key nor a chord character`);
  if (!mods.includes("cmd") && !mods.includes("ctrl")) fail(`key ${JSON.stringify(key)} without cmd or ctrl is typing, which a take never records`);
  return { t: o.t as number, kind: "key", key: key as string, mods: mods as KeyMod[] };
}

export interface KeycastPress { label: string; count: number; tick: number }
export interface KeycastState { label: string; count: number; opacity: number }

/** One entry per press, carrying the count AS OF that press. `keys` must be sorted by t (the loader sorts). */
export function buildKeycastPresses(keys: readonly KeyEvent[]): KeycastPress[] {
  const out: KeycastPress[] = [];
  for (const k of keys) {
    const tick = tickOf(k.t);
    const label = keyLabel(k.key, k.mods);
    const prev = out[out.length - 1];
    const count = prev && prev.label === label && tick < prev.tick + KEYCAST_HOLD_TICKS ? prev.count + 1 : 1;
    out.push({ label, count, tick });
  }
  return out;
}

export function keycastAt(presses: readonly KeycastPress[], tick: number): KeycastState | null {
  // The LAST press at or before `tick` (upper bound - 1), so a same-tick pair resolves to the later one.
  let lo = 0, hi = presses.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (presses[mid]!.tick <= tick) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return null;
  const p = presses[lo - 1]!;
  const age = tick - p.tick;
  if (age <= KEYCAST_HOLD_TICKS) return { label: p.label, count: p.count, opacity: 1 };
  if (age >= KEYCAST_HOLD_TICKS + KEYCAST_FADE_TICKS) return null;
  return { label: p.label, count: p.count, opacity: 1 - (age - KEYCAST_HOLD_TICKS) / KEYCAST_FADE_TICKS };
}

export function keycastText(s: KeycastState): string {
  return s.count >= 2 ? `${s.label} ×${s.count}` : s.label;
}

export function keycastFontPx(outputW: number): number {
  return Math.max(KEYCAST_MIN_FONT_PX, Math.round(outputW * KEYCAST_FONT_FRACTION));
}

export function keycastFont(px: number): string {
  return `${KEYCAST_FONT_WEIGHT} ${px}px ${KEYCAST_FONT_FAMILY}`;
}

export interface KeycastBox {
  x: number; y: number; width: number; height: number; radius: number;
  textX: number; textY: number; fontPx: number; maxTextWidth: number;
}

/** THE placement. `textWidth` is the measured width of `keycastText` at `keycastFont(keycastFontPx(outputW))`. */
export function keycastLayout(outputW: number, outputH: number, textWidth: number): KeycastBox {
  const fontPx = keycastFontPx(outputW);
  const padX = Math.round(fontPx * KEYCAST_PAD_X_EM);
  const padY = Math.round(fontPx * KEYCAST_PAD_Y_EM);
  const maxWidth = Math.max(0, outputW - 2 * KEYCAST_SIDE_MARGIN_PX);
  // ceil, not round: a rounded-down box would hand fillText a maxWidth below
  // the text's own width, and the canvas would squeeze the glyphs to fit.
  const width = Math.min(maxWidth, Math.ceil(textWidth) + 2 * padX);
  const height = fontPx + 2 * padY;
  const x = Math.round((outputW - width) / 2);
  const y = Math.round(outputH - outputH * KEYCAST_BOTTOM_FRACTION - height);
  return {
    x, y, width, height, radius: height / 2,
    textX: x + width / 2, textY: y + height / 2, fontPx,
    maxTextWidth: Math.max(0, width - 2 * padX),
  };
}
