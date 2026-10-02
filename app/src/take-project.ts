/**
 * The project.json a take is born with, when the Record bar asked for something
 * the default project does not say (STC-420). Pure, no Electron, no fs.
 *
 * ## Why this exists at all
 *
 * Nothing writes a project.json at record time — the editor does, on the first
 * save, and `parseProject` fills a default for a take with none. That is right
 * for every setting the editor owns. Show Clicks is different: it is chosen on
 * the Record bar BEFORE there is an editor, and it has to reach `render()`
 * through the project, never a live setting (render is pure; a sink that read a
 * preference at draw time would fork the transform).
 *
 * ## A seed, not a project
 *
 * This writes the RAW document `parseProject` is handed, carrying only the
 * choice: `{ version, showClicks }`. It deliberately does not assemble a
 * Project — no `output`, `cursor` or `transform` — because "one parser decides
 * a project" (STC-232, `trim.test.ts`): `parseProject` fills the capture size,
 * the default pointer and the CURRENT transform stamp itself, and a second
 * place that knew those answers would be two answers. The cost is that the file
 * is not schema-valid until the editor's first save rewrites it through
 * `projectForWrite`; every reader of a take's project.json is a tolerant one
 * (`parseProject`, `readProjectSlug`).
 *
 * ## The rule
 *
 * A choice that equals the default writes NOTHING: show-clicks ON is what every
 * take did before project-13, and a file that says so would pin the take to a
 * version for no reason (`projectForWrite`'s own minimum-version rule).
 *
 * ## The PiP default (STC-461)
 *
 * Settings' PiP style is chosen before there is an editor, like Show Clicks. It
 * is seeded only when it differs from the default AND the take was started with
 * the camera on, and never with a framing: framing is per take, and absent
 * means centred.
 */

import { DEFAULT_PIP_FIXED, isDefaultPipStyle, type PipStyle } from "@transform/pip-style.js";


export interface RecordTimeChoices {
  showClicks: boolean;
  /** Already filtered by `defaultStyleForTake`: null = seed nothing. */
  pipStyle: PipStyle | null;
}

/** The style a new take starts with, or null when there is nothing to say. */
export function defaultStyleForTake(stored: PipStyle, cameraOn: boolean): PipStyle | null {
  if (!cameraOn || isDefaultPipStyle(stored)) return null;
  const { framing: _framing, ...style } = stored;
  return style;
}

/** The text to write to project.json, or null when every choice is the default. */
export function recordTimeProject(choices: RecordTimeChoices): string | null {
  const body: Record<string, unknown> = {};
  let version = 0;
  if (!choices.showClicks) { body.showClicks = false; version = 13; }
  if (choices.pipStyle) { body.pip = { ...DEFAULT_PIP_FIXED, style: choices.pipStyle }; version = 15; }
  if (version === 0) return null;
  return JSON.stringify({ version, ...body }, null, 2) + "\n";
}
