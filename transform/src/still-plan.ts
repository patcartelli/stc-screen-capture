import type { Shot } from "./shot.js";
import { layoutStill, pxPerPointOf, type StillLayout } from "./still-decorate.js";
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

export function planStill(shot: Shot, options: ExportOptions): StillPlan {
  const drawn = shot;
  const layout = layoutStill(drawn);
  const pxPerPoint = pxPerPointOf(drawn);
  return { shot: drawn, layout, pxPerPoint, plan: planRender(options, { layout, pxPerPoint }) };
}
