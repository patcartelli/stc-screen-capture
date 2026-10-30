import type { SessionEvent, ZoomOverride } from "@transform/types";
import type { Rect } from "@transform/spaces";
import { zoomWindows, type ZoomPreset } from "@transform/zoom";
import { windowId } from "@transform/zoom-override";
import {
  normalizeEasing, resolveEasing, speedsOf, type CompleteEasing, type EasingSpec, type SpeedPair,
} from "@transform/zoom-easing";

/**
 * The two Ease rows' state while a block is open (STC-619): one speed per
 * direction, "" = the project default for that side. Slow / Medium / Fast are
 * the preset names calm / standard / snappy.
 */
export interface SpeedDraft { in: ZoomPreset | ""; out: ZoomPreset | "" }
export const NO_SPEEDS: Readonly<SpeedDraft> = Object.freeze({ in: "", out: "" });

/** A saved easing as the two rows show it. A plain name is both sides. */
export function draftOf(spec: EasingSpec | CompleteEasing | undefined): SpeedDraft {
  const s = speedsOf(spec);
  return { in: s.in ?? "", out: s.out ?? "" };
}

/**
 * The Zoom chip (STC-606, Figma 171:561; Patrick 2026-10-30): In / Out / Both
 * picks which side its Slow / Medium / Fast control edits, Both setting the
 * two together. The chip edits the same draft as the Ease in / Ease out rows,
 * so the two always agree.
 */
export type ChipSide = "in" | "out" | "both";

/** The speed the chip's control shows for `side`: Both with two different sides is "mixed" (none lit). */
export function chipSpeed(d: SpeedDraft, side: ChipSide): ZoomPreset | "" | "mixed" {
  if (side !== "both") return d[side];
  return d.in === d.out ? d.in : "mixed";
}

/** The draft after picking `speed` with `side` chosen. */
export function withChipSpeed(d: SpeedDraft, side: ChipSide, speed: ZoomPreset | ""): SpeedDraft {
  if (side === "both") return { in: speed, out: speed };
  return { ...d, [side]: speed };
}

/** The side the chip opens on: Both when the two agree, else In, so the control shows a real value. */
export function chipSideFor(d: SpeedDraft): ChipSide {
  return d.in === d.out ? "both" : "in";
}

/**
 * How far a drawn region zooms in (STC-606's editable Amount): the frame over
 * the region's longer side, as zoomAmountLabel reads it. Setting it resizes
 * the region about its centre, keeping its shape, and slides it back inside
 * the frame if the larger size would cross an edge. No new field: the amount
 * IS the region's size. The range is this ticket's call: from just past no
 * zoom to 4x.
 */
export const ZOOM_AMOUNT_MIN = 1.1;
export const ZOOM_AMOUNT_MAX = 4;

export function amountOf(rect: Rect): number {
  const longer = Math.max(rect.width, rect.height);
  return longer > 0 ? 1 / longer : 1;
}

export function rectAtAmount(rect: Rect, amount: number): Rect {
  const a = Math.min(ZOOM_AMOUNT_MAX, Math.max(ZOOM_AMOUNT_MIN, Number.isFinite(amount) ? amount : ZOOM_AMOUNT_MIN));
  const longer = Math.max(rect.width, rect.height);
  if (!(longer > 0)) return rect;
  const k = (1 / a) / longer;
  const width = rect.width * k;
  const height = rect.height * k;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const clamp = (v: number, size: number) => Math.min(1 - size, Math.max(0, v));
  return { x: clamp(cx - width / 2, width), y: clamp(cy - height / 2, height), width, height };
}

const pairOf = (d: SpeedDraft): SpeedPair => ({
  ...(d.in ? { in: d.in } : {}), ...(d.out ? { out: d.out } : {}),
});

/**
 * What an OPEN zoom-override edit commits to (STC-500). No DOM, no Electron.
 *
 * While a zoom block is selected the editor strips that window's own entry
 * from the LIVE project (so the stage shows the unzoomed picture to draw on —
 * STC-330/331). That made the edit invisible to everything that reads the
 * project: a save made meanwhile (trim, levels, a slug…) wrote project.json
 * WITHOUT the window's existing override, an export/frame copy/publish left
 * it out, and closing the take dropped it. Patrick's call (2026-10-02): treat
 * an open edit exactly like STC-461's reframe — saves write the edit as it
 * would commit, outputs commit it first, closing commits it.
 *
 * This is the ONE rule for "as it would commit": Done (`commitDraft` /
 * `commitManualDraft`) assigns its result to the live project, and
 * `persistProject` writes it into the copy it saves while the edit is still
 * open. Idempotent — committing an already-committed array again returns the
 * same array — because Done's own persistProject runs while the edit is still
 * open.
 */
export type OverrideEdit =
  | {
      kind: "derived";
      /** `windowId(w)` of the DERIVED window under edit. */
      windowId: string;
      /** null = no geometry override (the window zooms where stage 2 says). */
      rect: Rect | null;
      /** "" on a side = the project default for it; both "" writes no `easing` key. */
      easing: SpeedDraft;
      /** The draft's timing; a retime is written only where it differs from the TRUE derived bounds. */
      startNs: number;
      endNs: number;
    }
  | {
      kind: "manual";
      id: string;
      /** null = the window is deleted (Remove/Delete window). */
      rect: Rect | null;
      /** A "" side resolves to the project's preset at commit time, else "standard". */
      easing: SpeedDraft;
      startNs: number;
      endNs: number;
    };

export function overridesWithoutWindow(overrides: readonly ZoomOverride[] | undefined, id: string): ZoomOverride[] {
  return (overrides ?? []).filter((o) => !(o.kind === "geometry" && o.windowId === id));
}

/** Strips a `retime` entry for `id` (STC-329) — the sibling of `overridesWithoutWindow`'s geometry-only filter, kept separate rather than folded in: a geometry drag and a retime drag commit independently (dragging the rect must not discard a prior retime, and vice versa). */
export function overridesWithoutRetime(overrides: readonly ZoomOverride[] | undefined, id: string): ZoomOverride[] {
  return (overrides ?? []).filter((o) => !(o.kind === "retime" && o.windowId === id));
}

export function overridesWithoutManual(overrides: readonly ZoomOverride[] | undefined, id: string): ZoomOverride[] {
  return (overrides ?? []).filter((o) => !(o.kind === "manual" && o.id === id));
}

/**
 * `overrides` with `edit` committed into it. Never mutates its input.
 *
 * Derived window: an empty `rect` means "no geometry override" (unchanged
 * since STC-330). A `retime` entry (STC-329) is written or cleared
 * independently: dragging the rect must not discard a prior retime, and
 * dragging an edge must not discard a prior geometry override. Whether a
 * retime is needed is decided against the window's TRUE derived bounds,
 * looked up fresh from `events` rather than trusted from whatever seeded the
 * draft — the draft was seeded from the ALREADY-resolved (possibly
 * already-retimed) window, so comparing against it would miss a retime that
 * exactly undoes a previous one.
 *
 * Manual window: `easing` is REQUIRED on the schema, so each side still on
 * "Project default" is resolved to `preset` (a snapshot, not a live link),
 * else "standard" (STC-619: per side, so a block with only Ease in set keeps
 * the project's preset for its out). Equal sides are written as the preset's
 * name. An empty `rect` deletes the window outright — its rect and timing ARE
 * the window.
 */
export function committedOverrides(
  overrides: readonly ZoomOverride[] | undefined,
  edit: OverrideEdit,
  events: readonly SessionEvent[],
  preset: ZoomPreset | undefined,
): ZoomOverride[] {
  if (edit.kind === "manual") {
    const withoutThis = overridesWithoutManual(overrides, edit.id);
    return edit.rect
      ? [...withoutThis, {
          kind: "manual" as const, id: edit.id, startNs: edit.startNs, endNs: edit.endNs,
          rect: edit.rect,
          easing: normalizeEasing(resolveEasing(normalizeEasing(pairOf(edit.easing)), preset ?? "standard")) as CompleteEasing,
        }]
      : withoutThis;
  }

  const id = edit.windowId;
  const withoutGeometry = overridesWithoutWindow(overrides, id);
  const easing = normalizeEasing(pairOf(edit.easing));
  const withGeometry = edit.rect
    ? [...withoutGeometry, {
        kind: "geometry" as const, windowId: id, rect: edit.rect,
        ...(easing !== undefined ? { easing } : {}),
      }]
    : withoutGeometry;

  const raw = zoomWindows(events).find((w) => windowId(w) === id);
  const withoutRetime = overridesWithoutRetime(withGeometry, id);
  const startChanged = !!raw && edit.startNs !== raw.startNs;
  const endChanged = !!raw && edit.endNs !== raw.endNs;
  return (startChanged || endChanged)
    ? [...withoutRetime, {
        kind: "retime" as const, windowId: id,
        ...(startChanged ? { startNs: edit.startNs } : {}),
        ...(endChanged ? { endNs: edit.endNs } : {}),
      }]
    : withoutRetime;
}
