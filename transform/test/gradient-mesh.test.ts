import { describe, test, expect } from "vitest";
import { TABLE_SEED, mulberry32, permutation, createNoise } from "../src/seeded-noise.js";
import {
  arrangementFor, applyCalm, settle, clampPoint, lerpArrangement, foldScaleFor, LOOKS, PALETTES,
} from "../src/gradient-mesh-params.js";
import { renderMeshCpu } from "./_gradient-mesh-cpu.js";

/**
 * The gradient mesh's arithmetic and its pinned numbers (STC-622), ported from
 * `patcartelli/studio-cartelli`'s `scripts/check-gradient-mesh.mjs` (STC-610)
 * as of commit 3ea1d6b.
 *
 * Upstream these ran on that repo's build; here a stored `mesh` background is
 * a SEED in `shot.json`, so they are this repo's format guarantee too. The
 * arithmetic checks hold the reference to arithmetic rather than to a port
 * (two ports of one mistake agree). The pinned checks hold the NUMBERS: a
 * change to mulberry32, the shuffle or the arrangement draw would silently
 * re-arrange every background ever saved while every arithmetic check still
 * passed. If a pinned check fails on purpose, it is a format change: a new
 * shot version, not a new constant here.
 */

describe("seeded noise (the reference the GLSL port is held to)", () => {
  test.each([TABLE_SEED, 1, 2])("permutation(%i) is a doubled permutation of 0..255", (seed) => {
    const perm = permutation(seed);
    expect(perm.length).toBe(512);
    expect(Array.from(perm.slice(0, 256)).sort((a, b) => a - b)).toEqual(Array.from({ length: 256 }, (_, i) => i));
    for (let i = 0; i < 256; i++) expect(perm[i]).toBe(perm[i + 256]);
  });

  test("permutation is deterministic, and seeds differ", () => {
    expect(permutation(7)).toEqual(permutation(7));
    expect(permutation(1)).not.toEqual(permutation(2));
  });

  const noise = createNoise(TABLE_SEED);

  test("perlin2 is zero on the lattice", () => {
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) expect(noise.perlin2(i, j) === 0).toBe(true);   // -0 counts, as upstream's !== does
  });

  test("fbm2 with one octave is half of perlin2", () => {
    const rand = mulberry32(3);
    for (let k = 0; k < 50; k++) {
      const x = rand() * 40 - 20;
      const y = rand() * 40 - 20;
      expect(noise.fbm2(x, y, 1)).toBe(Math.fround(0.5 * noise.perlin2(x, y)));
    }
  });

  test("perlin2 is bounded and alive", () => {
    const values: number[] = [];
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) values.push(noise.perlin2(i / 10, j / 10));
    for (const v of values) expect(Number.isFinite(v) && Math.abs(v) < 1.5).toBe(true);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    expect(sd).toBeGreaterThan(0.05);
  });
});

describe("mesh decisions (arrangement, calm, settle)", () => {
  test("arrangement is deterministic and differs by seed", () => {
    expect(arrangementFor(42)).toEqual(arrangementFor(42));
    expect(arrangementFor(42)).not.toEqual(arrangementFor(43));
  });

  test("arrangement bounds hold over edge seeds", () => {
    for (const seed of [0, 1, -1, 2 ** 31, 123456789, 0xffffffff]) {
      const { points, offset } = arrangementFor(seed);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0.05); expect(x).toBeLessThanOrEqual(0.95);
        expect(y).toBeGreaterThanOrEqual(0.05); expect(y).toBeLessThanOrEqual(0.95);
      }
      for (const o of offset) { expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThan(100); }
    }
  });

  test("settle is pure in elapsed time and lands exactly", () => {
    expect([settle(0, 10, 0), settle(0, 10, 2500), settle(0, 10, 9999), settle(0, 10, -5)]).toEqual([0, 10, 10, 0]);
    expect(settle(2, 9, 700)).toBe(settle(2, 9, 700));
    let prev = -Infinity;
    for (let ms = 0; ms <= 2500; ms += 50) {
      const v = settle(0, 10, ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("calm endpoints", () => {
    expect(applyCalm(0.2, 0)).toEqual({ warp: 0.2, valueRange: 1 });
    expect(applyCalm(0.2, 1).warp).toBeCloseTo(0.04, 9);
    expect(applyCalm(0.2, 7)).toEqual(applyCalm(0.2, 1));
  });

  test("clampPoint and lerpArrangement's ends", () => {
    expect(clampPoint([-0.3, 1.4])).toEqual([0, 1]);
    const a = arrangementFor(5), b = arrangementFor(6);
    expect(lerpArrangement(a, b, 0)).toEqual(a);
    expect(lerpArrangement(a, b, 1)).toEqual(b);
  });

  test("fold scale follows scale at the approved ratio", () => {
    expect(foldScaleFor(LOOKS.folded.scale)).toBeCloseTo(1.3, 1);
    expect(foldScaleFor(LOOKS.glossy.scale)).toBeCloseTo(0.7, 1);
    expect([LOOKS.folded.sheen, LOOKS.glossy.sheen]).toEqual([0, 1]);
  });
});

describe("pinned values: a stored seed must always mean the same picture", () => {
  test("permutation(TABLE_SEED) prefix", () => {
    expect(Array.from(permutation(TABLE_SEED).slice(0, 16)))
      .toEqual([29, 178, 47, 7, 74, 73, 138, 99, 146, 196, 1, 41, 218, 81, 165, 3]);
  });

  test("perlin2 / fbm2 sample values", () => {
    const n = createNoise(TABLE_SEED);
    expect([n.perlin2(0.3, 0.7), n.perlin2(-3.25, 7.75), n.fbm2(12.3, -4.56, 3)])
      .toEqual([0.10918793082237244, 0.04640007019042969, -0.10933320224285126]);
  });

  test("arrangementFor(42)", () => {
    expect(arrangementFor(42)).toEqual({
      points: [
        [0.5909933767281473, 0.4534615030977875],
        [0.8172192141413689, 0.6527606372954324],
        [0.2073325088713318, 0.5239332879660651],
        [0.2959051948972046, 0.6122701885411517],
      ],
      offset: [86.54746483080089, 47.23170551005751],
    });
  });

  // New here, not upstream: the whole picture, not just its inputs. The
  // reference renders the mesh in arithmetic node evaluates the same way on
  // every run, so a hash of a small render pins everything between the seed
  // and the pixel — the IDW blend, the warp, the sheen, the grain hash. The
  // shader is held to this reference by the still gate (scripts/still-gate.mjs).
  function fnv(bytes: Uint8ClampedArray): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  const input = (grain: boolean) => {
    const { points, offset } = arrangementFor(806664024);
    return { palette: PALETTES.aurora, calm: 0, sheen: 0.9, warp: 0.22, scale: 0.75, grain,
             points, offset, t: 11.734, valueRange: 1 };
  };

  test("the reference render of one stored mesh, without grain", () => {
    expect(fnv(renderMeshCpu(input(false), 64, 40))).toBe("4e8a985c");
  });

  test("the reference render of one stored mesh, with grain", () => {
    expect(fnv(renderMeshCpu(input(true), 64, 40))).toBe("e18aa6fa");
  });
});
