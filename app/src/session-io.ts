/**
 * Loading a take over IPC, for every window that renders one (STC-488).
 *
 * Lifted VERBATIM out of `editor.ts` so the editor's preview and a recording's
 * copy render read the take through one loader. The renderer never names a
 * path: `io` is the window's own bridge onto the guarded
 * preview:read/size/chunk handlers. See `ipcSource`'s doc (moved with it) for
 * why video is read by range and audio whole.
 */
import { loadSession, type LoadedSession } from "@transform/session";
import type { ByteSource } from "@transform/chunk-reader";
import { parseProject } from "@transform/trim";
import type { Project } from "@transform/types";

export interface TakeIO {
  read(name: string): Promise<ArrayBuffer>;
  size(name: string): Promise<number>;
  chunk(name: string, offset: number, length: number): Promise<ArrayBuffer>;
}
export type CountingSource = ByteSource & { readonly bytesRead: number };

const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;

export async function readWhole(io: TakeIO, name = "display.mp4"): Promise<ArrayBuffer> {
  const size = await io.size(name);
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - offset);
    out.set(new Uint8Array(await io.chunk(name, offset, length)), offset);
  }
  return out.buffer;
}

/**
 * A take file read by range (STC-236), over the same preview:size /
 * preview:chunk channels readWhole uses — the renderer still never names a
 * path. The video tracks go through this; the audio tracks still go through
 * readWhole, whole (decoded PCM is their real cost, a separate ticket).
 *
 * preview:chunk returns fewer bytes than asked at EOF rather than failing, so
 * the length is checked here: a short chunk handed to the decoder would be a
 * corrupt frame, not an error anyone could see.
 */
export async function ipcSource(io: TakeIO, name: string): Promise<CountingSource> {
  const size = await io.size(name);
  let bytesRead = 0;
  return {
    size,
    get bytesRead() { return bytesRead; },
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new Error(`${name}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`);
      }
      if (length === 0) return new Uint8Array(0);
      const got = new Uint8Array(await io.chunk(name, offset, length));
      if (got.byteLength !== length) {
        throw new Error(`${name}: short read at ${offset} — asked for ${length} bytes, got ${got.byteLength}. Was the file changed while open?`);
      }
      bytesRead += length;
      return got;
    },
  };
}

export interface LoadedTake {
  session: LoadedSession;
  project: Project;
  anchors: any;
  sources: { display: CountingSource; camera?: CountingSource };
}

export async function loadTake(io: TakeIO): Promise<LoadedTake> {
  const dec = new TextDecoder();
  const [anchors, events, displaySrc, projectRaw] = await Promise.all([
    io.read("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    io.read("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    ipcSource(io, "display.mp4"),
    io.read("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
  ]);
  const cameraSrc = anchors.files?.camera ? await ipcSource(io, anchors.files.camera) : undefined;
  // STC-233: same reasoning as cameraSrc above (only when the anchors claim the track), one track over.
  const micM4a = anchors.files?.mic ? await readWhole(io, anchors.files.mic) : undefined;
  // STC-418: and again for system audio — loadSession refuses a claimed track that was not supplied.
  const systemM4a = anchors.files?.system ? await readWhole(io, anchors.files.system) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: displaySrc, cameraMp4: cameraSrc, micM4a, systemM4a });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );
  return { session, project, anchors, sources: { display: displaySrc, camera: cameraSrc } };
}
