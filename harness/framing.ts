import { composite } from "@transform/compositor";
import { framingLayout, type Framing } from "@transform/framing";
import { FULL_FRAME_UV, type FrameState } from "@transform/render";

/**
 * The video framing gate's page (STC-396). Draws a flat-colour "recording"
 * through the REAL compositor with a hand-built FrameState and reports pixel
 * facts the gate script asserts as PROPERTIES (no golden images: gradients and
 * blurred shadows are rasteriser output — see scripts/still-gate.mjs).
 */
const W = 960, H = 540;
const FILL = { r: 0x2f, g: 0x6d, b: 0xd8 };

async function frameBitmap(): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(640, 360);
  const x = c.getContext("2d")!;
  x.fillStyle = `rgb(${FILL.r},${FILL.g},${FILL.b})`;
  x.fillRect(0, 0, 640, 360);
  return createImageBitmap(c);
}

function stateFor(framing: Framing | undefined, pointer?: { x: number; y: number }): FrameState {
  const layout = framingLayout(framing, { width: W, height: H }, 16 / 9) ?? null;
  return {
    tick: 0, frameIndex: 0, framePtsNs: 0, pip: null, keycast: null,
    zoom: { amount: 0, crop: FULL_FRAME_UV },
    cursor: { x: pointer?.x ?? 0, y: pointer?.y ?? 0, vx: 0, vy: 0, pressed: false, showClicks: false,
              visible: !!pointer, shape: "arrow", style: "default", pxPerPoint: 2 },
    framing: layout,
  } as unknown as FrameState;
}

async function render(framing: Framing | undefined, pointer?: { x: number; y: number }) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  composite(ctx, await frameBitmap(), null, stateFor(framing, pointer), W, H);
  return ctx.getImageData(0, 0, W, H);
}

const px = (d: ImageData, x: number, y: number) => {
  const i = (Math.round(y) * d.width + Math.round(x)) * 4;
  return { r: d.data[i]!, g: d.data[i + 1]!, b: d.data[i + 2]!, a: d.data[i + 3]! };
};
const lum = (p: { r: number; g: number; b: number }) => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

(window as any).__framingGate = async () => {
  const out: any[] = [];
  for (const framing of [{ preset: "clean" }, { preset: "dark" }, { preset: "solid", color: "#c0392b" }] as Framing[]) {
    const layout = framingLayout(framing, { width: W, height: H }, 16 / 9)!;
    const c = layout.content;
    const a = await render(framing);
    const b = await render(framing);
    // the same document with the shadow switched off, as the "no shadow" reference
    const none = await render({ ...framing, shadow: { offsetYPct: 0, blurPct: 0, opacity: 0 } } as Framing);
    const cx = c.x + c.width / 2;
    const below: { d: number; lum: number; ref: number }[] = [];
    const reach = Math.ceil(layout.shadow.blur * 1.5 + Math.abs(layout.shadow.offsetY));
    for (let d = 0; d <= reach + 6; d += 2) {
      const y = c.y + c.height + d;
      if (y >= H) break;
      below.push({ d, lum: lum(px(a, cx, y)), ref: lum(px(none, cx, y)) });
    }
    out.push({
      preset: (framing as any).preset, layout,
      repeatEqual: a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]),
      interior: px(a, cx, c.y + c.height / 2),
      corner: px(a, c.x + 1, c.y + 1),
      cornerNoShadow: px(none, c.x + 1, c.y + 1),   // diagnostic: separates shadow from fringe
      background: px(a, 0, 0),
      backgroundFar: px(a, W - 1, H - 1),
      below,
    });
  }
  // a pointer on the CHROME (outside the picture) must not be drawn
  const layout = framingLayout({ preset: "clean" }, { width: W, height: H }, 16 / 9)!;
  const clean = await render({ preset: "clean" });
  const stray = { x: 4, y: 4 };   // inside the padding, outside the content
  const withPointer = await render({ preset: "clean" }, stray);
  let chromeDiff = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const p = px(clean, x, y), q = px(withPointer, x, y);
    if (p.r !== q.r || p.g !== q.g || p.b !== q.b) chromeDiff++;
  }
  return { probes: out, fill: FILL, chromeDiff, contentX: layout.content.x };
};

(window as any).__ready = true;
