import type { Shot } from "./shot.js";
import { decorationForMode, layoutStill, pxPerPointOf, type StillLayout } from "./still-decorate.js";
import { planRender, type ExportOptions, type RenderPlan } from "./still-export.js";

/**
 * What a shot looks like on its way to pixels, decided in ONE place (STC-675).
 *
 * Every path that turns a `Shot` into an image goes through here: the panel's
 * picture and its Copy/Save (`thumbnail-renderer.ts`), the still editor's view
 * and its Save (`still-editor-renderer.ts`), and the Library's thumbnail and
 * Share (`renderer.ts`) — the last four through `composeStill`, the panel's
 * export plan directly. Before this, three of them filled the mode's presets
 * and the panel did not, so a fresh window shot (whose `shot.json` carries no
 * `paddingPct` and no `shadow`) had a margin in the Library and the editor and
 * none from the panel: the same "composite, then export" drift as STC-477.
 *
 * Pure, node-free and DOM-free, so the sizes can be compared in a unit test.
 */
export interface StillPlan {
  /** The document as it is DRAWN. */
  shot: Shot;
  /** `layoutStill`'s answer at the capture's own scale. */
  layout: StillLayout;
  pxPerPoint: number;
  /** The layout at export scale, plus format and alpha. */
  plan: RenderPlan;
}

/**
 * The shot passed in is a stored document (the panel, the Library) or a live
 * one (the editor, with its boxes), and either may lack what its mode means:
 * a fresh capture is written with only the look's mode and background
 * (`captureLook` → `applyLook`), so `paddingPct` and `shadow` are absent.
 * `decorationForMode` fills them here and nowhere else; explicit values in the
 * document still win. Nothing is written back: `shot.json` stays as stored, so
 * no version changes and every existing shot opens as it did.
 */
export function planStill(shot: Shot, options: ExportOptions): StillPlan {
  const drawn: Shot = { ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) };
  const layout = layoutStill(drawn);
  const pxPerPoint = pxPerPointOf(drawn);
  return { shot: drawn, layout, pxPerPoint, plan: planRender(options, { layout, pxPerPoint }) };
}
