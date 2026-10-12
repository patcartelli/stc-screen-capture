// gifenc ships no types; only the three exports gif-encode.ts uses.
declare module "gifenc" {
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: object): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: object): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
