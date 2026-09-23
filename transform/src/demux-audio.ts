import * as MP4BoxNS from "mp4box";

// mp4box ships CJS+ESM; normalize the default-export interop once — same as demux.ts.
const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

/**
 * The AAC muxer's own `AudioSpecificConfig`, not mp4box's `track.audio.channel_count`,
 * is the true channel count (STC-233, found running against a real file for the first
 * time). `AudioSampleEntry.channelcount` — what mp4box reports as `channel_count` — is
 * a legacy QuickTime-compatibility field, and AVAssetWriter's AAC muxer writes it as a
 * hardcoded 2 regardless of the actual encoded channel count: measured on a real
 * BuiltInMicrophoneDevice (genuinely mono, confirmed at capture — `MicCapture.swift`
 * reads `channels=1` off both the device's active format AND the first delivered
 * `CMSampleBuffer`) exported mic.m4a, mp4box read `channel_count: 2` while the true
 * channel count is 1. The AudioSpecificConfig's `channelConfiguration` field agreed with
 * the device: 1. Reading the config bytes we already extract for `description` is the
 * fix, not a second box.
 *
 * ISO/IEC 14496-3 §1.6.2.1: 5 bits audioObjectType, 4 bits samplingFrequencyIndex
 * (24 explicit bits follow if that index is 0xf), 4 bits channelConfiguration. The
 * channelConfiguration -> channel count mapping is Table 1.19; only 1-7 are legal
 * for an encoder (0 means "channels defined elsewhere, in a PCE" and is refused here
 * rather than guessed, since nothing in this app ever asks AVAssetWriter for that).
 */
export function channelCountFromAudioSpecificConfig(description: Uint8Array): number | undefined {
  if (description.length < 2) return undefined;
  let bitPos = 0;
  const readBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = description[bitPos >> 3];
      if (byte === undefined) return v << (n - i); // ran off the end; caller treats as invalid
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      v = (v << 1) | bit;
      bitPos++;
    }
    return v;
  };
  readBits(5); // audioObjectType — not needed to find channelConfiguration
  const samplingFreqIndex = readBits(4);
  if (samplingFreqIndex === 0x0f) readBits(24); // explicit sampling frequency, rare
  const channelConfig = readBits(4);
  // Table 1.19: 1..6 map directly to that many channels, 7 maps to 8 (7.1).
  const CHANNEL_CONFIG_TABLE: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8 };
  return CHANNEL_CONFIG_TABLE[channelConfig];
}

/**
 * The audio twin of demux.ts's `demuxTrack` (STC-233): mic.m4a's own sample
 * table, read the same way display.mp4/camera.mp4's is, so the audio track's
 * PTS grid is session-relative ns on the identical convention the video
 * tracks already use — no separate correction term for audio.
 *
 * A parallel implementation rather than a shared one: `demuxTrack` is
 * load-bearing, exercised by every gate in this repo, and this file's whole
 * subject (an mp4box audio track, an `esds` box instead of an `avcC` one) has
 * never run against a real browser from this checkout — see this repo's own
 * "the WGSL leg has never run on a GPU" precedent (STC-320). Generalising the
 * two into one function would have risked the untested half regressing the
 * proven one for a saving that is mostly boilerplate.
 */
export interface DemuxedAudio {
  /** source-sample PTS grid, session-relative integer ns */
  framesNs: number[];
  /** e.g. "mp4a.40.2" (AAC-LC) — what AudioDecoder.configure() wants as `codec` */
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig bytes, from the esds box — AudioDecoder.configure()'s `description` */
  description: Uint8Array;
  chunks: { timestampUs: number; data: Uint8Array }[];
}

export function demuxAudioTrack(buf: ArrayBuffer, what: string): Promise<DemuxedAudio> {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    let sawReady = false;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const fail = (msg: string) => finish(() => reject(new Error(msg)));

    // Same backstop demux.ts carries, same reason: mp4box signals a malformed
    // file by never calling back at all.
    const watchdog = setTimeout(
      () => fail(`timed out reading ${what} — the file may be truncated or not an MP4`),
      15_000,
    );

    file.onError = (e: unknown) => { clearTimeout(watchdog); fail(`mp4box reading ${what}: ${String(e)}`); };
    file.onReady = (info: any) => {
      sawReady = true;
      const track = info.audioTracks[0];
      if (!track) { clearTimeout(watchdog); fail(`no audio track in ${what}`); return; }

      // AudioSpecificConfig: the AAC decoder's own config bytes, nested two
      // descriptors deep in the esds box's ES_Descriptor
      // (DecoderConfigDescriptor -> DecoderSpecificInfo). mp4box.js exposes
      // this as `esds.esd.descs[0].descs[0].data` — the same "read the box,
      // strip nothing" idiom demux.ts uses for `avcC`, just one layer deeper
      // because esds is itself a descriptor tree rather than a flat box.
      const trak = file.getTrackById(track.id);
      const entries = trak.mdia.minf.stbl.stsd.entries;
      const esds = entries.map((e: any) => e.esds).find(Boolean);
      if (!esds) { clearTimeout(watchdog); fail(`no esds box in ${what}`); return; }
      const configDesc = esds.esd?.descs?.[0]?.descs?.[0];
      if (!configDesc?.data) { clearTimeout(watchdog); fail(`no AudioSpecificConfig in ${what}'s esds box`); return; }
      const description = new Uint8Array(configDesc.data);

      // Presentation time = media time + edit-list offset — identical
      // reasoning to demux.ts's video path: AVAssetWriter records the
      // start-to-first-sample gap as an empty edit, not a shifted CTS.
      const movieTimescale = file.moov.mvhd.timescale;
      const editOffsetNs = Math.round(
        (trak.edts?.elst?.entries ?? [])
          .filter((e: any) => e.media_time === -1)
          .reduce((sum: number, e: any) => sum + (e.segment_duration / movieTimescale) * 1_000_000_000, 0),
      );

      const collected: any[] = [];
      file.onSamples = (_id: number, _user: unknown, samples: any[]) => {
        collected.push(...samples);
        if (collected.length < track.nb_samples) return;
        // demux.ts's video twin asserts this SUM is already an integer, because
        // Capture.swift/CameraCapture.swift force mediaTimeScale to exactly
        // 1_000_000_000 on every video input, making scale === 1 always. Audio
        // cannot do that: AVFoundation rejects mediaTimeScale on any
        // audio-media-type input outright (the STC-233 crash this repo's own
        // CLAUDE.md records), so an AAC track's own sample grid is its CODEC
        // RATE — 48000 Hz here, 1024-sample frames — and cts*scale is a real
        // number on real hardware (cts=1024, timescale=48000 -> 21.333... ms).
        // Rounding is the right answer, not a refusal: the worst case is under
        // 1/48000 s (~20.8 us), two orders of magnitude inside session.ts's own
        // OFFSET_TOLERANCE_NS (50 us) and three inside this app's measured
        // camera<->mic sync tolerance (1.8 ms median, MicCapture.swift's header).
        // Chained from durations, not read from each sample's own `cts` —
        // demux.ts's identical fix, STC-394, and the same reason: once
        // mic.m4a is fragmented too (`MicCapture.swift`'s own
        // `movieFragmentInterval`), a crash-truncated file's first REAL
        // `moof` resets mp4box.js's accumulated decode time back near zero.
        // A sample's own `duration` is a per-sample delta, not an
        // accumulated base, so it survives the reset.
        let cumulative = collected[0].cts as number;
        const framesNs = collected.map((s, i) => {
          if (i > 0) cumulative += collected[i - 1].duration;
          const scale = 1_000_000_000 / s.timescale;
          return Math.round(cumulative * scale + editOffsetNs);
        });
        clearTimeout(watchdog);
        finish(() => resolve({
          framesNs,
          codec: track.codec,
          sampleRate: track.audio?.sample_rate ?? 0,
          numberOfChannels: channelCountFromAudioSpecificConfig(description) ?? (track.audio?.channel_count ?? 0),
          description,
          chunks: collected.map((s, i) => ({
            timestampUs: Math.round(framesNs[i]! / 1000),
            data: s.data as Uint8Array,
          })),
        }));
      };
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
    };
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    try {
      file.appendBuffer(ab);
      file.flush();
    } catch (e) {
      clearTimeout(watchdog);
      fail(`could not parse ${what}: ${String(e)}`);
      return;
    }

    if (!sawReady) {
      clearTimeout(watchdog);
      fail(`${what} is not a readable MP4 — no track information found`);
    }
  });
}
