// Vendored from patcartelli/studio-cartelli, src/lib/gradient-mesh-gl.ts, as of commit 3f724eb
// (STC-610, PRs #779 and #790; the PCG grain hash, STC-622, PR #792) — NOT
// imported: the two are separate repos with no package published between
// them, the same arrangement as transform/src/frame-diff-rule.ts. Ported into
// Capture's still pipeline by STC-622. A re-sync is a deliberate, by-hand
// decision, never a silent drift.
//
// Changed on the way in: import specifiers end in .js rather than .ts,
// because this repo's tsconfig resolves the bundler way without
// allowImportingTsExtensions. Nothing else: the grain is a PCG integer hash
// upstream too (STC-622, Patrick 2026-10-30), so the lab page and Capture
// draw identical grain.
//
// ── upstream file, verbatim from here ─────────────────────────────────────
//
// STC-610: the WebGL2 half of the gradient-mesh study.
//
// Three shaders share one GLSL noise: the mesh itself, and a probe that
// evaluates perlin2/fbm2 at given coordinates into a float target so the
// page can hold the port to src/lib/seeded-noise.ts. The noise's table is
// that module's permutation(TABLE_SEED), uploaded as a 512x1 R8UI texture
// and read with texelFetch, so the shader indexes exactly the integers the
// CPU does.
//
// This file draws; it decides nothing. Looks, arrangement, calm and settle
// are src/lib/gradient-mesh-params.ts.

import { TABLE_SEED, permutation } from './seeded-noise.js';
import { foldScaleFor, type Point } from './gradient-mesh-params.js';

const VERTEX_SRC = `#version 300 es
// Full-screen triangle from gl_VertexID — no vertex buffer needed.
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = p * 0.5 + 0.5;
}
`;

/**
 * perlin2 and fbm2, line for line from seeded-noise.ts. Lerp is written as
 * a + (b - a) * t rather than mix() so the rounding matches the reference.
 */
export const NOISE_GLSL = `
uniform highp usampler2D uPerm;
int P(int i) { return int(texelFetch(uPerm, ivec2(i, 0), 0).r); }
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float lerpf(float a, float b, float t) { return a + (b - a) * t; }
float grad2(int hash, float x, float y) {
  int h = hash & 3;
  float u = h < 2 ? x : y;
  float v = h < 2 ? y : x;
  return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
}
float perlin2(vec2 p) {
  vec2 fl = floor(p);
  int xi = int(fl.x) & 255;
  int yi = int(fl.y) & 255;
  vec2 f = p - fl;
  float u = fade(f.x);
  float v = fade(f.y);
  int aa = P(P(xi) + yi);
  int ab = P(P(xi) + yi + 1);
  int ba = P(P(xi + 1) + yi);
  int bb = P(P(xi + 1) + yi + 1);
  float x1 = lerpf(grad2(aa, f.x, f.y), grad2(ba, f.x - 1.0, f.y), u);
  float x2 = lerpf(grad2(ab, f.x, f.y - 1.0), grad2(bb, f.x - 1.0, f.y - 1.0), u);
  return lerpf(x1, x2, v);
}
float fbm2(vec2 p, int octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    value += perlin2(p * frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value;
}
`;

/**
 * The mockups ran on value noise, which swings about twice as far as Perlin
 * fbm. This gain carries the approved warp and fold values across; it is
 * judged against the mockup by eye in the session 1 findings.
 */
const NOISE_GAIN = 2.0;

export const MESH_FRAG = `#version 300 es
precision highp float;
precision highp int;
${NOISE_GLSL}
uniform vec3 uC[3];     // dark, mid, bright
uniform vec2 uB[4];     // base points: bright, mid, dark, dark
uniform vec2 uOffset;
uniform float uT;
uniform float uAspect;
uniform float uWarp;
uniform float uScale;
uniform float uFoldScale;
uniform float uValueRange;
uniform float uSheen;
uniform int uGrain;
in vec2 vUv;
out vec4 outColor;

const float GAIN = ${NOISE_GAIN.toFixed(1)};

// pcg2d (Jarzynski & Olano, "Hash Functions for GPU Rendering", 2020) on the
// integer pixel. The top 24 bits divide exactly in float32, so the CPU
// reference gets the identical value.
uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}
float grain(vec2 fragCoord) {
  return float(pcg2d(uvec2(fragCoord)).x >> 8u) / 16777216.0;
}
float nz(vec2 p) { return fbm2(p, 3) * GAIN; }

vec3 mesh(vec2 q) {
  vec2 pts[4];
  vec3 cols[4];
  pts[0] = uB[0] + vec2(0.10 * sin(uT * 0.11),       0.08 * cos(uT * 0.13));       cols[0] = uC[2];
  pts[1] = uB[1] + vec2(0.08 * cos(uT * 0.09 + 1.0), 0.10 * sin(uT * 0.12 + 2.0)); cols[1] = uC[1];
  pts[2] = uB[2] + vec2(0.12 * sin(uT * 0.07 + 3.0), 0.08 * cos(uT * 0.10 + 1.0)); cols[2] = uC[0];
  pts[3] = uB[3] + vec2(0.06 * cos(uT * 0.08 + 4.0), 0.06 * sin(uT * 0.09));       cols[3] = uC[0];
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = (q - pts[i]) * vec2(uAspect, 1.0);
    float w = 1.0 / pow(dot(d, d) + 0.02, 1.6);
    acc += cols[i] * w;
    ws += w;
  }
  return acc / ws;
}

void main() {
  vec2 q = vUv;
  vec2 s = q * vec2(uAspect, 1.0) * uScale + uOffset;
  vec2 w = vec2(nz(s + vec2(0.0, uT * 0.05)), nz(s + vec2(5.2, 1.3) - vec2(uT * 0.04, 0.0)));
  q += w * uWarp;
  vec3 col = mesh(q);
  if (uSheen > 0.0) {
    float fold = nz(s * uFoldScale + w * 1.2 + uT * 0.03);
    float sheen = smoothstep(0.05, 0.6, fold);
    col += (mix(uC[1], uC[2], 0.6) + 0.15) * sheen * 0.28 * (0.4 + length(col)) * uSheen;
    // 1 - smoothstep(lo, hi): GLSL leaves smoothstep undefined when edge0 >= edge1.
    col = mix(col, col * 0.85, (1.0 - smoothstep(-0.5, -0.1, fold)) * uSheen);
  }
  col = mix(uC[1], col, uValueRange);
  if (uGrain == 1) {
    // gl_FragCoord only, never uT: a still must not shimmer.
    col += (grain(gl_FragCoord.xy) - 0.5) * 0.035;
  }
  outColor = vec4(col, 1.0);
}
`;

/** Texel i of the output holds perlin2 (octaves 0) or fbm2 of input coordinate i. */
export const NOISE_PROBE_FRAG = `#version 300 es
precision highp float;
precision highp int;
${NOISE_GLSL}
uniform highp sampler2D uIn;
uniform int uOctaves;
out vec4 outColor;
void main() {
  vec2 xy = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0).rg;
  float v = uOctaves == 0 ? perlin2(xy) : fbm2(xy, uOctaves);
  outColor = vec4(v, 0.0, 0.0, 1.0);
}
`;

export interface MeshSupport {
  webgl2: boolean;
  floatTarget: boolean;
  reason: string;
}

export function meshSupport(): MeshSupport {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return { webgl2: false, floatTarget: false, reason: 'WebGL2 is not available in this browser' };
  const floatTarget = gl.getExtension('EXT_color_buffer_float') !== null;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    webgl2: true,
    floatTarget,
    reason: floatTarget ? '' : 'EXT_color_buffer_float is missing, so the shader noise cannot be read back',
  };
}

export interface RenderInput {
  /** Darkest first, as PALETTES holds them. */
  palette: [string, string, string];
  calm: number;
  /** 0..1: how much light catches the folds. */
  sheen: number;
  warp: number;
  scale: number;
  grain: boolean;
  points: [Point, Point, Point, Point];
  offset: Point;
  t: number;
  /** From applyCalm. */
  valueRange: number;
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('gl.createShader returned null');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('gl.createProgram returned null');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export class GradientMeshRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly mesh: WebGLProgram;
  private readonly perm: WebGLTexture;
  private probe: WebGLProgram | null = null;
  private readonly floatTarget: boolean;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.floatTarget = gl.getExtension('EXT_color_buffer_float') !== null;
    this.mesh = program(gl, MESH_FRAG);

    const perm = gl.createTexture();
    if (!perm) throw new Error('gl.createTexture returned null');
    this.perm = perm;
    gl.bindTexture(gl.TEXTURE_2D, perm);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 512, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, permutation(TABLE_SEED));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private bindPerm(p: WebGLProgram): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.perm);
    gl.uniform1i(gl.getUniformLocation(p, 'uPerm'), 0);
  }

  /** Draws at the canvas's on-screen size times the device pixel ratio. */
  draw(input: RenderInput): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.drawAt(
      input,
      Math.max(1, Math.round(this.canvas.clientWidth * dpr)),
      Math.max(1, Math.round(this.canvas.clientHeight * dpr)),
    );
  }

  /** Draws at an exact size — an export's, or a canvas that is not on screen. */
  drawAt(input: RenderInput, w: number, h: number): void {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.mesh);
    this.bindPerm(this.mesh);
    const u = (name: string) => gl.getUniformLocation(this.mesh, name);
    gl.uniform3fv(u('uC'), input.palette.flatMap(hexToRgb));
    gl.uniform2fv(u('uB'), input.points.flat());
    gl.uniform2fv(u('uOffset'), input.offset);
    gl.uniform1f(u('uT'), input.t);
    gl.uniform1f(u('uAspect'), w / h);
    gl.uniform1f(u('uWarp'), input.warp);
    gl.uniform1f(u('uScale'), input.scale);
    gl.uniform1f(u('uFoldScale'), foldScaleFor(input.scale));
    gl.uniform1f(u('uValueRange'), input.valueRange);
    gl.uniform1f(u('uSheen'), input.sheen);
    gl.uniform1i(u('uGrain'), input.grain ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * perlin2 (octaves 0) or fbm2 at each [x, y] pair of `xy`, computed by the
   * shader and read back. Null when this browser cannot render to float.
   */
  sampleNoise(xy: Float32Array, octaves: 0 | 3): Float32Array | null {
    if (!this.floatTarget) return null;
    const gl = this.gl;
    const n = xy.length / 2;
    if (!this.probe) this.probe = program(gl, NOISE_PROBE_FRAG);

    const input = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, n, 1, 0, gl.RG, gl.FLOAT, xy);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const target = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

    gl.viewport(0, 0, n, 1);
    gl.useProgram(this.probe);
    this.bindPerm(this.probe);
    gl.uniform1i(gl.getUniformLocation(this.probe, 'uIn'), 1);
    gl.uniform1i(gl.getUniformLocation(this.probe, 'uOctaves'), octaves);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const out = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, out);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);
    gl.deleteTexture(input);

    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = out[i * 4]!;
    return values;
  }

  /** The drawn canvas, RGBA8, bottom row first. */
  pixels(): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
}
