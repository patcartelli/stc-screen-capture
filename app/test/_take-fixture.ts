import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

const root = join(__dirname, "..", "..");

/**
 * A complete, committed session fixture, copied into a temp recordings folder.
 *
 * These tests used to reach into ~/Desktop/stc for whatever real recording
 * happened to be there. That made the suite depend on the developer's Desktop —
 * it broke the moment those takes were deleted, and CI could never run it at
 * all. The gates still default to a real take, which is where 4K and real
 * capture behaviour get exercised; the E2E tests only need a valid session to
 * verify wiring, and a 90-frame 640x360 fixture does that in a fraction of the
 * time.
 */
export function makeTakeFolder(takeName = "2026-08-24_10-00-00",
                               opts: { into?: string } = {}): { dir: string; takeDir: string } {
  // `into` puts it in an EXISTING root, so a test can seed a mixed library
  // (STC-294) rather than getting one temp folder per fixture.
  const dir = opts.into ?? mkdtempSync(join(tmpdir(), "stc-takes-"));
  const takeDir = join(dir, takeName);
  mkdirSync(takeDir, { recursive: true });
  for (const f of ["anchors.json", "events.json", "display.mp4"]) {
    cpSync(join(root, "fixtures", "basic", f), join(takeDir, f));
  }
  return { dir, takeDir };
}

/**
 * A take WITH a camera track, from the committed PiP fixture.
 *
 * Exists because every camera take was unopenable in the app until the
 * renderer passed camera.mp4 to loadSession: the load threw "anchors.camera
 * .present is true but no camera.mp4 was supplied", which is loadSession
 * correctly refusing to silently drop the PiP. Nothing in the suite noticed,
 * because every other fixture is camera-less.
 */
export function makePipTakeFolder(
  takeName = "2026-08-26_11-00-00-pip",
  opts: { withProject?: boolean } = {},
): { dir: string; takeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "stc-pip-takes-"));
  const takeDir = join(dir, takeName);
  mkdirSync(takeDir, { recursive: true });
  const files = ["anchors.json", "events.json", "display.mp4", "camera.mp4"];
  // Nothing writes a project.json at record time, so a take the app records is
  // exactly this: a camera track and no edit document. `withProject: false` is
  // the realistic case, not the exotic one.
  if (opts.withProject !== false) files.push("project.json");
  for (const f of files) cpSync(join(root, "fixtures", "pip", f), join(takeDir, f));
  return { dir, takeDir };
}

/**
 * A take WITH a system-audio track (STC-418 PR 3), built on `fixtures/basic`.
 *
 * No committed `system.m4a` exists (making a real one needs a Mac, the same
 * gap the mic has), so one is MUXED here at test time with the repo's own
 * mp4-muxer: a real AAC-LC 48 kHz stereo sample entry (its esds carries the
 * two-byte AudioSpecificConfig below) over placeholder sample bytes. That is
 * enough for everything that happens when a take is OPENED — `loadSession`
 * demuxes and rebases the track, it never decodes it — and deliberately NOT
 * enough to export: only the export decodes audio, and a test that exported
 * this file would be testing the placeholder, not the mix.
 */
export function makeSystemAudioTakeFolder(
  takeName = "2026-09-25_10-00-00-sys",
): { dir: string; takeDir: string } {
  const { dir, takeDir } = makeTakeFolder(takeName);
  const { frames, frameUs } = writePlaceholderAac(join(takeDir, "system.m4a"), 2);

  const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
  anchors.version = 6;
  anchors.files = { ...anchors.files, system: "system.m4a" };
  anchors.system = {
    present: true, sampleRate: 48_000, channels: 2,
    firstFramePtsNs: 100_000_000, lastFramePtsNs: 100_000_000 + Math.round((frames - 1) * frameUs * 1000),
  };
  writeFileSync(join(takeDir, "anchors.json"), JSON.stringify(anchors, null, 2));
  return { dir, takeDir };
}

/**
 * A structurally valid AAC-LC 48 kHz `.m4a` over PLACEHOLDER sample bytes,
 * ~4.5 s long — enough for `loadSession` to demux and rebase, never enough
 * to decode (see `makeSystemAudioTakeFolder`).
 */
function writePlaceholderAac(path: string, channels: 1 | 2, undecodable = false): { frames: number; frameUs: number } {
  // AudioSpecificConfig: object type 2 (AAC-LC), frequency index 3 (48 kHz),
  // channel configuration 1 or 2 -> 00010 0011 0001|0010 000 -> 0x11 0x88|0x90.
  // `undecodable` writes object type 0 (00000 ...) instead: the container
  // still parses and the channel count still reads, but no decoder accepts it.
  const asc = new Uint8Array([undecodable ? 0x01 : 0x11, channels === 1 ? 0x88 : 0x90]);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: "aac", numberOfChannels: channels, sampleRate: 48_000 },
    fastStart: "in-memory",
  });
  const frameUs = (1024 * 1e6) / 48_000;
  const frames = Math.floor(4.5e6 / frameUs);
  for (let i = 0; i < frames; i++) {
    muxer.addAudioChunkRaw(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]), "key",
      Math.round(i * frameUs), Math.round(frameUs),
      i === 0 ? { decoderConfig: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: channels, description: asc } } : undefined);
  }
  muxer.finalize();
  writeFileSync(path, new Uint8Array(muxer.target.buffer));
  return { frames, frameUs };
}

/**
 * A take WITH a mic track and nothing else new (STC-455): anchors-4's `mic`
 * block over a placeholder `mic.m4a`, the same trick and the same limit as
 * `makeSystemAudioTakeFolder` — it opens, it does not export.
 */
export function makeMicTakeFolder(
  takeName = "2026-09-25_11-00-00-mic",
  opts: { undecodable?: boolean } = {},
): { dir: string; takeDir: string } {
  const { dir, takeDir } = makeTakeFolder(takeName);
  const { frames, frameUs } = writePlaceholderAac(join(takeDir, "mic.m4a"), 1, opts.undecodable);
  const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
  anchors.version = 4;
  anchors.files = { ...anchors.files, mic: "mic.m4a" };
  anchors.mic = {
    present: true, device: "Fixture Mic", sampleRate: 48_000, channels: 1,
    firstFramePtsNs: 100_000_000, lastFramePtsNs: 100_000_000 + Math.round((frames - 1) * frameUs * 1000),
  };
  writeFileSync(join(takeDir, "anchors.json"), JSON.stringify(anchors, null, 2));
  return { dir, takeDir };
}

/**
 * A still, from the committed window-capture fixture (STC-294).
 *
 * `fixtures/shot-window/` is a real `shot.json` plus a synthetic 720x480 RGBA
 * frame — enough for the library to classify, summarise and decorate one
 * without a Mac, a grant or a helper. Named with a timestamp because that IS
 * the identity and the sort key for both kinds, which is the whole reason one
 * index over two formats is possible.
 */
export function makeStillFolder(
  takeName = "2026-09-08_12-00-00",
  opts: { into?: string; redactions?: { x: number; y: number; width: number; height: number }[] } = {},
): { dir: string; takeDir: string } {
  const dir = opts.into ?? mkdtempSync(join(tmpdir(), "stc-takes-"));
  const takeDir = join(dir, takeName);
  mkdirSync(takeDir, { recursive: true });
  cpSync(join(root, "fixtures", "shot-window", "frame.png"), join(takeDir, "frame.png"));
  const shot = JSON.parse(
    readFileSync(join(root, "fixtures", "shot-window", "shot.json"), "utf8"));
  if (opts.redactions) shot.decoration.redactions = opts.redactions;
  writeFileSync(join(takeDir, "shot.json"), JSON.stringify(shot, null, 2));
  return { dir, takeDir };
}
