/**
 * Minting and persisting a bundle's identity (STC-413).
 *
 * `ensureCaptureId` is called by the two export paths and by nothing else —
 * a bundle with no finished file needs no identity, since nothing points
 * back at it yet.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPTURE_DOC_FILE, captureDocForWrite, parseCaptureDoc,
} from "@transform/capture-doc.js";
import { mintCaptureId } from "@transform/capture-id.js";

/**
 * Ids handed out for a bundle but not yet on disk (STC-413).
 *
 * The read and the write are two moments, and two exports of one take racing
 * in the gap would both see no document and mint DIFFERENT ids — the second
 * overwriting the first, orphaning the file the first had already embedded.
 * Same race, and the same in-process fix, as `still-io.ts`'s export names.
 */
const claimed = new Map<string, Promise<string>>();

/** This bundle's id, minting and persisting one the first time it is asked for. */
export function ensureCaptureId(bundleDir: string): Promise<string> {
  const existing = claimed.get(bundleDir);
  if (existing) return existing;

  const work = (async () => {
    const path = join(bundleDir, CAPTURE_DOC_FILE);
    try {
      return parseCaptureDoc(JSON.parse(await readFile(path, "utf8"))).id;
    } catch {
      // Absent or unreadable. A corrupt document is replaced rather than
      // fatal: refusing to export because a bookkeeping file got mangled
      // would cost the user their take for nothing.
    }
    const id = mintCaptureId();
    await writeFile(path, JSON.stringify(captureDocForWrite(id), null, 2));
    return id;
  })().finally(() => { claimed.delete(bundleDir); });

  claimed.set(bundleDir, work);
  return work;
}
