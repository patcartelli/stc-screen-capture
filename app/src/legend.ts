/**
 * The selection overlay's legend (STC-598) — what the keys are, as data.
 *
 * The overlay has no chrome, so the keys have to be stated. This decides the
 * words; `overlay.ts` draws them as keycaps in the readout face, like the
 * options bar above. No DOM, no Electron.
 *
 * Return is deliberately absent from the options phase: there it re-confirms
 * the selection (selection.ts `confirm` -> nextPhase "options"), it does not
 * start the take. The arrow on the Capture Video button is decorative
 * (STC-456), so the legend says Click.
 */

export interface LegendItem {
  /** Keycaps, in order. Empty when the item is a plain instruction. */
  keys: string[];
  label: string;
}

export function legendItems(mode: string, phase: "select" | "options" | undefined): LegendItem[] {
  if (phase === "options") {
    return [
      { keys: [], label: "Adjust selection" },
      { keys: ["Click"], label: "Capture Video" },
      { keys: ["Esc"], label: "cancel" },
    ];
  }
  return mode === "window"
    ? [
        { keys: ["Click"], label: "select window" },
        { keys: ["Space"], label: "region" },
        { keys: ["Esc"], label: "cancel" },
      ]
    : [
        { keys: ["Drag"], label: "region" },
        { keys: ["Space"], label: "window" },
        { keys: ["Esc"], label: "cancel" },
      ];
}
