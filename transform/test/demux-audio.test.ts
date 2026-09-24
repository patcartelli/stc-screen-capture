import { describe, test, expect } from "vitest";
import { channelCountFromAudioSpecificConfig } from "../src/demux-audio.js";

/**
 * `channelCountFromAudioSpecificConfig` exists because mp4box's
 * `track.audio.channel_count` — the `AudioSampleEntry.channelcount` field —
 * is NOT the AAC track's real channel count: AVAssetWriter's muxer writes it
 * as a hardcoded 2 regardless of what was actually encoded, a legacy
 * QuickTime-compatibility default. The real count is the AudioSpecificConfig
 * nested in the `esds` box. See demux-audio.ts's header for the real-hardware
 * measurement that found this (STC-233): a genuinely mono BuiltInMicrophoneDevice
 * take, confirmed mono at capture, was demuxed as `channel_count: 2`.
 */
describe("channelCountFromAudioSpecificConfig", () => {
  test("real hardware fixture: AAC-LC 48kHz mono (0x11 0x88)", () => {
    // Measured directly off a real mic.m4a recorded from BuiltInMicrophoneDevice
    // (genuinely mono, confirmed at capture by MicCapture.swift reading
    // channels=1 off both device.activeFormat and the first delivered
    // CMSampleBuffer). mp4box's own channel_count read 2 for this same file.
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([0x11, 0x88]))).toBe(1);
  });

  test("AAC-LC 48kHz stereo (0x11 0x90)", () => {
    // audioObjectType=2 (AAC-LC), samplingFreqIndex=3 (48000), channelConfig=2.
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([0x11, 0x90]))).toBe(2);
  });

  test("extended sampling frequency (index 0x0f) shifts the 24 explicit bits before channelConfiguration", () => {
    // audioObjectType=2 (00010), samplingFreqIndex=0xf (1111) -> 24 explicit
    // frequency bits (all zero, value irrelevant here) -> channelConfig=1 (0001).
    // Bit stream: 00010 1111 000000000000000000000000 0001 0000
    const bits =
      "00010" + "1111" + "0".repeat(24) + "0001" + "0000";
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    expect(channelCountFromAudioSpecificConfig(new Uint8Array(bytes))).toBe(1);
  });

  test("channelConfig 0 (channels defined in a PCE) is refused rather than guessed", () => {
    // audioObjectType=2, samplingFreqIndex=3, channelConfig=0.
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([0x11, 0x80]))).toBeUndefined();
  });

  test("channelConfig 7 maps to 8 channels (7.1), not 7", () => {
    // audioObjectType=2, samplingFreqIndex=3, channelConfig=7 (0111).
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([0x11, 0xb8]))).toBe(8);
  });

  test("too short to hold even the first two fields", () => {
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([0x11]))).toBeUndefined();
    expect(channelCountFromAudioSpecificConfig(new Uint8Array([]))).toBeUndefined();
  });
});
