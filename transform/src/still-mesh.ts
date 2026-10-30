import { isMeshBackground, type Background, type MeshBackground } from "./shot.js";
import { arrangementFor, PALETTES } from "./gradient-mesh-params.js";
import { GradientMeshRenderer, type RenderInput } from "./gradient-mesh-gl.js";

/**
 * A stored `mesh` background, turned into pixels (STC-622).
 *
 * STC-610 decided all of it (`docs/stc-610-decision.md` in
 * patcartelli/studio-cartelli): render on the GPU, in the renderer that
 * already composes the still, at the export's own size, and hand the result
 * to `still-render.ts` as `StillSources.background` — the `drawImage` path the
 * `image` kind already takes. The CPU port is the reference the shader is
 * held to (the still gate), never a renderer: 3.4 s at 4K against 23 ms.
 *
 * Two halves. `meshRenderInput` is pure — which settings the shader gets, and
 * the one place a stored document becomes the vendored renderer's
 * `RenderInput` — so node can test it. `renderMeshBackground` draws, and is the
 * ONE function every renderer of a still reaches through `withMeshBackground`
 * — `app/src/still-compose.ts` (panel and still editor), the library grid's
 * thumbnail (`app/src/renderer.ts`) and the still gate's page — so the gate
 * exercises the app's own path rather than a copy of it.
 */

/**
 * A fresh mesh's settings: STC-610's expressive look ("D2", which the
 * decision's own example document carries) on the Aurora palette, with grain
 * ON. Grain is what fixes 8-bit banding in the dark stops — Bayer did not —
 * so it is on for every look in Capture, the quiet one included.
 *
 * What a picker (STC-599) offers is that ticket's to decide; this is only
 * what a mesh is when nobody has said otherwise.
 */
export function meshBackground(seed: number): MeshBackground {
  return {
    kind: "mesh", colors: [PALETTES.aurora[0], PALETTES.aurora[1], PALETTES.aurora[2]], seed: seed >>> 0,
    sheen: 0.9, warp: 0.22, scale: 0.75, grain: true, points: null, t: 0,
  };
}

/**
 * What the shader is given for a stored mesh.
 *
 * The noise offset is NOT stored and must never be: it derives from the seed,
 * so a shot that stored it could disagree with its own seed. Points come from
 * the seed too unless the author dragged one (`points` non-null). `calm` is
 * not a setting (STC-610 left it out), so it is always 0 here, and
 * `valueRange` — calm's other output — is always 1.
 */
export function meshRenderInput(bg: MeshBackground): RenderInput {
  const arrangement = arrangementFor(bg.seed);
  return {
    palette: [bg.colors[0], bg.colors[1], bg.colors[2]],
    calm: 0,
    sheen: bg.sheen,
    warp: bg.warp,
    scale: bg.scale,
    grain: bg.grain,
    points: bg.points ? bg.points.map((p) => [p[0], p[1]]) as RenderInput["points"] : arrangement.points,
    offset: arrangement.offset,
    t: bg.t,
    valueRange: 1,
  };
}

/**
 * Draws a mesh at exactly `width` x `height` into a fresh WebGL2 canvas, ready
 * to be `drawImage`d. Throws when WebGL2 is unavailable rather than handing
 * back nothing: a still that silently lost its background is a different
 * picture from the one its document describes, and `paintBackground`'s
 * first-colour fallback would hide that. Capture never disables hardware
 * acceleration, and Chromium falls back to SwiftShader without it.
 *
 * Call `release` once the canvas has been drawn from: Chromium keeps a small
 * number of live WebGL contexts and evicts the oldest past it, and one is
 * made per compose.
 */
export function renderMeshBackground(bg: MeshBackground, width: number, height: number):
    { canvas: HTMLCanvasElement; release(): void } {
  const canvas = document.createElement("canvas");
  const renderer = new GradientMeshRenderer(canvas);
  renderer.drawAt(meshRenderInput(bg), width, height);
  return {
    canvas,
    release() {
      // The same context the renderer made: getContext hands back the existing one.
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/**
 * Runs `draw` with the background source a still at `width` x `height` needs:
 * a rendered mesh when `bg` is one, otherwise nothing. The WebGL context is
 * released once `draw` returns, on every path. The size must be the canvas
 * `renderStill` draws into, scaled layout and all.
 */
export function withMeshBackground<T>(bg: Background | undefined, width: number, height: number,
                                      draw: (background: HTMLCanvasElement | undefined) => T): T {
  if (!isMeshBackground(bg)) return draw(undefined);
  const mesh = renderMeshBackground(bg, width, height);
  try {
    return draw(mesh.canvas);
  } finally {
    mesh.release();
  }
}
