import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSystemAudioTakeFolder } from "./_take-fixture.js";
import { loadSession } from "../../transform/src/session.js";

const buf = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * The system-audio take fixture (STC-418 PR 3) is MUXED at test time, not
 * committed — so it is only worth an e2e test's trust if it loads the way a
 * real take does. This is that check: the same `loadSession` the editor
 * calls, with the same files the editor would read.
 */
describe("makeSystemAudioTakeFolder", () => {
  test("loads through loadSession with a system-audio track, rebased onto its anchors", async () => {
    const { takeDir } = makeSystemAudioTakeFolder();
    const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
    expect(anchors.version).toBe(6);
    const session = await loadSession({
      anchors,
      events: JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8")),
      displayMp4: buf(join(takeDir, "display.mp4")),
      systemM4a: buf(join(takeDir, "system.m4a")),
    });
    expect(session.systemAudio).toBeDefined();
    expect(session.systemAudio!.sampleRate).toBe(48_000);
    expect(session.systemAudio!.numberOfChannels).toBe(2);
    expect(session.systemAudio!.framesNs[0]).toBe(anchors.system.firstFramePtsNs);
  });
});
