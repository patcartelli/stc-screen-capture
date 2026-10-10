// omggif ships no types; only what the GIF tests read back.
declare module "omggif" {
  export interface GifFrameInfo {
    delay: number;
    disposal: number;
    transparent_index: number | null;
    palette_offset: number | null;
  }
  export class GifReader {
    constructor(buf: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(i: number): GifFrameInfo;
    decodeAndBlitFrameRGBA(i: number, pixels: Uint8ClampedArray): void;
  }
}
