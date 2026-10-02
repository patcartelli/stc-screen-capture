/**
 * A bundle's identity document (STC-413).
 *
 * `capture.json` holds nothing but the id embedded in the finished file it
 * produced — Task 8's scan matches the two back together. It is written
 * LAZILY, at export time: a bundle with no finished file has nothing pointing
 * back at it, so nothing on the capture or promote path needs to change.
 *
 * REFUSES rather than defaults, the stance `parseShot` takes: a bundle whose
 * identity cannot be read must be treated as unidentified, never quietly
 * handed a fresh id that orphans the file it already has. That refusal is
 * what lets `ensureCaptureId` (app/src/capture-identity.ts) tell "no id yet"
 * apart from "id present but the file is corrupt" and decide accordingly.
 */

import { captureIdTokens, isCaptureId } from "./capture-id.js";

export const CAPTURE_DOC_FILE = "capture.json";

export interface CaptureDoc { version: 1; id: string }

export class CaptureDocError extends Error {}

export function captureDocForWrite(id: string): CaptureDoc {
  if (!isCaptureId(id)) throw new CaptureDocError(`not a capture id: ${String(id)}`);
  return { version: 1, id };
}

export function parseCaptureDoc(doc: unknown): CaptureDoc {
  if (!doc || typeof doc !== "object") throw new CaptureDocError("capture.json is not an object");
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (k !== "version" && k !== "id") throw new CaptureDocError(`unexpected field: ${k}`);
  }
  if (d.version !== 1) throw new CaptureDocError(`unsupported version: ${String(d.version)}`);
  if (!isCaptureId(d.id)) throw new CaptureDocError("id is not a capture id");
  return { version: 1, id: d.id };
}

/**
 * The id a `capture.json` that will NOT parse still carries, or undefined
 * (STC-436).
 *
 * A document that was readable once has already been embedded in a finished
 * file; minting a replacement would leave that file pointing at an id no
 * bundle owns, and the capture listing as two tiles. A partial write, a disk
 * hiccup or a hand edit gone wrong usually leaves the id itself intact, so
 * this reads it out of the raw bytes with the same scanner the media readers
 * use — no `JSON.parse`, no schema.
 *
 * EXACTLY ONE distinct id, or nothing. Two different ids in one document
 * (two writes interleaved, a paste on top of the old contents) means the
 * bytes cannot say which one the finished file carries, and guessing wrong
 * is worse than minting: it could hand this bundle an id ANOTHER bundle
 * owns, merging two captures into one tile. The same id repeated is fine.
 *
 * Only `ensureCaptureId`, the one writer, calls this. A reader that repaired
 * on the side would be a second owner of the id — the defect
 * `app/src/capture-identity.ts`'s header records fixing.
 */
export function salvageCaptureDocId(bytes: Uint8Array): string | undefined {
  let found: string | undefined;
  for (const id of captureIdTokens(bytes)) {
    if (found === undefined) found = id;
    else if (id !== found) return undefined;
  }
  return found;
}
