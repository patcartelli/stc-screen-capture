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
  CAPTURE_DOC_FILE, captureDocForWrite, parseCaptureDoc, salvageCaptureDocId,
} from "@transform/capture-doc.js";
import { mintCaptureId } from "@transform/capture-id.js";
import type { ToastMessage } from "./toast-message.js";

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

/**
 * What `ensureCaptureId` did with a `capture.json` it could not read
 * (STC-436). Only ever reported for a document that EXISTED — a bundle
 * exported for the first time has no document, and minting for it is the
 * ordinary path, not a repair.
 *
 * - `salvaged`: the id was recovered from the bytes and rewritten cleanly.
 *   Nothing is lost, so nothing needs the user.
 * - `reminted`: no single id could be recovered; a fresh one was written.
 *   A finished file carrying the OLD id now lists as a second tile, and
 *   that is what the user needs to be told.
 */
export type CaptureIdRepair =
  | { kind: "salvaged"; path: string; id: string }
  | { kind: "reminted"; path: string; id: string };

/**
 * The toast for a repair, or undefined when there is nothing to tell. Pure
 * and here, beside the decision, so the wording is tested with it.
 */
export function captureIdRepairNotice(r: CaptureIdRepair): ToastMessage | undefined {
  if (r.kind === "salvaged") return undefined;
  return {
    title: "A take's identity file was damaged",
    body: "Its capture.json couldn't be read, so it was given a new identity. " +
          "If this take was exported before, the old export may now show in " +
          "the library as a separate item.",
  };
}

/** The repair, on stderr — always, whether or not a toast follows. */
function logRepair(r: CaptureIdRepair): void {
  console.error(r.kind === "salvaged"
    ? `[capture-identity] ${r.path} could not be parsed; recovered ${r.id} from its bytes and rewrote it.`
    : `[capture-identity] ${r.path} could not be read and no single id could be recovered; ` +
      `minted ${r.id}. Any finished file already carrying the old id will list separately.`);
}

/**
 * This bundle's id, minting and persisting one the first time it is asked for.
 *
 * `onRepair` hears about a corrupt document this call fixed; main passes one
 * that raises `captureIdRepairNotice` as a toast, since stderr is invisible
 * in a packaged app. It is NOT called for a first export.
 */
export function ensureCaptureId(
  bundleDir: string,
  onRepair?: (r: CaptureIdRepair) => void,
): Promise<string> {
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
    // But replaced with its OWN id wherever the bytes still hold one
    // (STC-436). If the document was readable once, a top-level file already
    // carries that id, and a fresh one would strand it — one capture, two
    // tiles. Salvage lives HERE, in the one writer, and never in
    // `readBundleId`: a reader that repaired would be a second owner.
    let repair: CaptureIdRepair["kind"] | undefined;
    let id: string | undefined;
    if (existsSync(path)) {
      try { id = salvageCaptureDocId(await readFile(path)); }
      catch { /* unreadable at all (permissions, a directory): mint below */ }
      repair = id ? "salvaged" : "reminted";
    }
    id ??= mintCaptureId();
    await writeFile(path, JSON.stringify(captureDocForWrite(id), null, 2));
    if (repair) {
      const r: CaptureIdRepair = { kind: repair, path, id };
      logRepair(r);
      onRepair?.(r);
    }
    return id;
  })().finally(() => { claimed.delete(bundleDir); });

  claimed.set(bundleDir, work);
  return work;
}
