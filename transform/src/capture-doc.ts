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

import { isCaptureId } from "./capture-id.js";

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
