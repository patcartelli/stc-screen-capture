import type { SessionEvent, ZoomOverride } from "@transform/types";
import type { Rect } from "@transform/spaces";
import { zoomWindows, type ZoomPreset } from "@transform/zoom";
import { windowId } from "@transform/zoom-override";

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
      /** "" = the project default (no `easing` key written). */
      easing: ZoomPreset | "";
      /** The draft's timing; a retime is written only where it differs from the TRUE derived bounds. */
      startNs: number;
      endNs: number;
    }
  | {
      kind: "manual";
      id: string;
      /** null = the window is deleted (Remove/Delete window). */
      rect: Rect | null;
      /** "" resolves to the project's preset at commit time, else "standard". */
      easing: ZoomPreset | "";
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
 * Manual window: `easing` is REQUIRED on the schema, so an unresolved
 * "Project default" picker is resolved to `preset` (a snapshot, not a live
 * link), else "standard". An empty `rect` deletes the window outright — its
 * rect and timing ARE the window.
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
          rect: edit.rect, easing: edit.easing || preset || "standard",
        }]
      : withoutThis;
  }

  const id = edit.windowId;
  const withoutGeometry = overridesWithoutWindow(overrides, id);
  const withGeometry = edit.rect
    ? [...withoutGeometry, {
        kind: "geometry" as const, windowId: id, rect: edit.rect,
        ...(edit.easing ? { easing: edit.easing } : {}),
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
