/**
 * Reading, minting and persisting a bundle's identity (STC-413).
 *
 * ## One reader, because three disagreed
 *
 * "Read this bundle's id" had three implementations — here, in `library.ts`'s
 * scan, and in `temp-takes.ts`'s orphan sweep — each a few lines of
 * `readFile` → `JSON.parse` → `parseCaptureDoc`. They were not identical,
 * and the difference was not cosmetic: `ensureCaptureId` treated a corrupt
 * document as "replace it", while the other two treated it as "no id". So a
 * mangled `capture.json` left the existing top-level file unmatched in the
 * library AND let the next export mint a fresh id and write a SECOND
 * top-level file — one capture, two tiles, permanently.
 *
 * `readBundleId` is now the only reader, and this file's most-repeated
 * defect (one value, two copies) has one owner for this value.
 *
 * `ensureCaptureId` is still called by the export paths alone — a bundle
 * with no finished file needs no identity, since nothing points back at it
 * yet — and is the ONLY thing here that writes. Anything that merely wants
 * to know an id, on a path the user did not ask to modify anything, calls
 * `readBundleId` (see `share:publish`).
 */

import { existsSync } from "node:fs";
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

/**
 * This bundle's id as it stands on disk, or undefined — never written to,
 * never minted.
 *
 * Undefined covers three states the callers deliberately do not tell apart:
 * never exported (no `capture.json` at all, since it is minted lazily at
 * export time), a document that will not parse, and a directory that is not
 * a bundle. All three mean the same thing to a reader — there is no id to
 * match against — and a reader has no business repairing any of them.
 */
export async function readBundleId(bundleDir: string): Promise<string | undefined> {
  try {
    const doc = JSON.parse(await readFile(join(bundleDir, CAPTURE_DOC_FILE), "utf8"));
    return parseCaptureDoc(doc).id;
  } catch {
    return undefined;
  }
}

/** This bundle's id, minting and persisting one the first time it is asked for. */
export function ensureCaptureId(bundleDir: string): Promise<string> {
  const existing = claimed.get(bundleDir);
  if (existing) return existing;

  const work = (async () => {
    const path = join(bundleDir, CAPTURE_DOC_FILE);
    const existingId = await readBundleId(bundleDir);
    if (existingId) return existingId;

    // Absent, or present and unreadable. A corrupt document is replaced
    // rather than fatal: refusing to export because a bookkeeping file got
    // mangled would cost the user their take for nothing.
    //
    // The residual cost is stated rather than hidden, because collapsing the
    // three readers into one did not remove it: if the document WAS readable
    // once, a top-level file already carries the old id, and nothing on disk
    // can now link the two — so that capture will list as two tiles until
    // one of them is deleted. Announced rather than done silently, since
    // this is the only branch here that can produce that state.
    if (existsSync(path)) {
      console.error(`[capture-identity] ${path} could not be read; minting a fresh id. ` +
                    "Any finished file already carrying the old id will list separately.");
    }
    const id = mintCaptureId();
    await writeFile(path, JSON.stringify(captureDocForWrite(id), null, 2));
    return id;
  })().finally(() => { claimed.delete(bundleDir); });

  claimed.set(bundleDir, work);
  return work;
}
