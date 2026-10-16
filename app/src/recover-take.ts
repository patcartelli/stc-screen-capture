/**
 * A take the recorder quit on, made openable (STC-530) — the I/O half of
 * `transform/src/recover-anchors.ts`.
 *
 * ONE path for both ways such a take reaches the app: the live `recording-lost` (the helper
 * died mid-take) and launch-time recovery (STC-393, a previous run left one behind) — plus
 * STC-527's full disk, where the helper stopped cleanly but could not write anchors.json.
 *
 * Reads `anchors.partial.json`, reads where each media file actually ENDS (the demux
 * already handles a fragmented file cut off mid-write, STC-394), builds the document, and
 * runs it through `loadSession` — the editor's own loader — before writing anything, so a
 * take this calls recovered is one the editor can open. Never overwrites an anchors.json,
 * never deletes a media file, never deletes the take: a failure leaves the directory
 * exactly as it was, for launch recovery to offer.
 *
 * Video is read by RANGE (box headers and the sample index), never whole — a take can be
 * gigabytes. Audio is read whole, as `session-io.ts` already does.
 */
import { link, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demuxTrack } from "@transform/demux.js";
import { demuxAudioTrack } from "@transform/demux-audio.js";
import { loadSession, rebaseMicAudio } from "@transform/session.js";
import type { ByteSource } from "@transform/chunk-reader.js";
import { PARTIAL_ANCHORS_FILE, recoverAnchors, type RecoveredMedia } from "@transform/recover-anchors.js";

/** `SIDECAR_RESERVE_FILE` in `helper/src/DiskDecisions.swift` (STC-527): 8 MiB the helper holds for its sidecars and deletes at a clean stop. */
const SIDECAR_RESERVE_FILE = ".sidecar-reserve";

export type TakeRecovery = { ok: true } | { ok: false; why: string };

/** A ranged reader over one file on disk. Exported for STC-238's soak, which loads takes the same way. */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, "r");
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new Error(`${path}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`);
      }
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new Error(`${path}: short read (${bytesRead} of ${length})`);
      return buf;
    },
    close: () => fh.close(),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await (await open(path, "r")).close(); return true; } catch { return false; }
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function hasPartialAnchors(dir: string): Promise<boolean> {
  return (await exists(join(dir, PARTIAL_ANCHORS_FILE))) && !(await exists(join(dir, "anchors.json")));
}

/** A track's frames, or null when its file is missing or yields nothing — `recoverAnchors` drops it then. */
async function videoFrames(path: string, what: string): Promise<number[] | null> {
  let src: Awaited<ReturnType<typeof fileSource>> | undefined;
  try {
    src = await fileSource(path);
    const v = await demuxTrack(src, what);
    return v.framesNs.length > 0 ? v.framesNs : null;
  } catch (e) {
    console.error(`[recover] ${what} yielded no frames:`, (e as Error).message);
    return null;
  } finally {
    await src?.close().catch(() => {});
  }
}

async function audioLastNs(path: string, what: string, firstNs: number): Promise<number | null> {
  try {
    const raw = await demuxAudioTrack(toArrayBuffer(await readFile(path)), what);
    if (raw.framesNs.length === 0) return null;
    return rebaseMicAudio(raw, firstNs).framesNs.at(-1)!;
  } catch (e) {
    console.error(`[recover] ${what} yielded no samples:`, (e as Error).message);
    return null;
  }
}

/** A name the partial gave a media file: a plain string, no separator, no `..`. */
function plainName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !/[\\/]/.test(v) && v !== ".." && v !== ".";
}

/**
 * Never rejects: every failure is `{ ok: false, why }`, and a failure leaves the
 * directory as it was (callers `void` this from event handlers).
 */
export async function recoverTake(dir: string, reason: string): Promise<TakeRecovery> {
  try {
    return await recoverTakeInner(dir, reason);
  } catch (e) {
    return { ok: false, why: `recovery failed unexpectedly: ${(e as Error).message}` };
  }
}

async function recoverTakeInner(dir: string, reason: string): Promise<TakeRecovery> {
  if (await exists(join(dir, "anchors.json"))) {
    return { ok: false, why: "anchors.json already exists — this take is not one to recover" };
  }
  let partial: any;
  try {
    partial = JSON.parse(await readFile(join(dir, PARTIAL_ANCHORS_FILE), "utf8"));
  } catch (e) {
    return { ok: false, why: `no readable ${PARTIAL_ANCHORS_FILE}: ${(e as Error).message}` };
  }
  const files = (partial && typeof partial === "object" && partial.files) || {};
  if (typeof files !== "object") return { ok: false, why: "anchors.partial.json has a malformed files block" };
  for (const k of ["display", "camera", "mic", "system"]) {
    if (files[k] !== undefined && !plainName(files[k])) {
      return { ok: false, why: `anchors.partial.json names files.${k} as something that is not a plain file name` };
    }
  }

  const display = await videoFrames(join(dir, files.display ?? "display.mp4"), "display.mp4");
  const media: RecoveredMedia = { displayFramesNs: display ?? [] };
  if (partial?.camera?.present === true) {
    media.cameraFramesNs = files.camera ? await videoFrames(join(dir, files.camera), "camera.mp4") : null;
  }
  if (partial?.mic?.present === true) {
    media.micLastNs = files.mic ? await audioLastNs(join(dir, files.mic), "mic.m4a", partial.mic.firstFramePtsNs) : null;
  }
  if (partial?.system?.present === true) {
    media.systemLastNs = files.system ? await audioLastNs(join(dir, files.system), "system.m4a", partial.system.firstFramePtsNs) : null;
  }

  const r = recoverAnchors(partial, media, reason);
  if (!r.ok) return r;
  const anchors = r.anchors as any;

  // The editor's own loader, before anything is written: recovered means openable.
  let events: unknown = { version: 1, events: [] };
  try { events = JSON.parse(await readFile(join(dir, "events.json"), "utf8")); } catch { /* none: no cursor */ }
  const sources: Awaited<ReturnType<typeof fileSource>>[] = [];
  try {
    const displayMp4 = await fileSource(join(dir, anchors.files.display));
    sources.push(displayMp4);
    const cameraMp4 = anchors.files.camera ? await fileSource(join(dir, anchors.files.camera)) : undefined;
    if (cameraMp4) sources.push(cameraMp4);
    const micM4a = anchors.files.mic ? toArrayBuffer(await readFile(join(dir, anchors.files.mic))) : undefined;
    const systemM4a = anchors.files.system ? toArrayBuffer(await readFile(join(dir, anchors.files.system))) : undefined;
    await loadSession({ anchors, events: events as any, displayMp4, cameraMp4, micM4a, systemM4a });
  } catch (e) {
    return { ok: false, why: `the rebuilt take does not load: ${(e as Error).message}` };
  } finally {
    for (const s of sources) await s.close().catch(() => {});
  }

  // Written whole under a temp name, then PUBLISHED with `link`, which fails if anchors.json
  // exists (it wins) and never exposes a half-written file: a process exit mid-write leaves
  // only the temp, not a truncated anchors.json that launch recovery would trust.
  const tmp = join(dir, "anchors.json.recovering");
  try {
    await writeFile(tmp, JSON.stringify(anchors));
    await link(tmp, join(dir, "anchors.json"));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    return { ok: false, why: `could not write anchors.json: ${(e as Error).message}` };
  }
  await rm(tmp, { force: true }).catch(() => {});
  await rm(join(dir, PARTIAL_ANCHORS_FILE), { force: true }).catch(() => {});
  // A killed helper never reached its own cleanup (STC-540). Only after anchors.json is
  // published: a FAILED recovery returns above and leaves the directory exactly as it was.
  await rm(join(dir, SIDECAR_RESERVE_FILE), { force: true }).catch(() => {});
  return { ok: true };
}
