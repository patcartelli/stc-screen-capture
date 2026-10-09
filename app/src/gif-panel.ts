/**
 * The panel's GIF / Video switch, decided without a DOM (STC-395). The
 * renderer draws `gifLabel`, enables Copy/Save by `copySaveEnabled`, and asks
 * main to do whatever `effectOfPick` says; every sentence the user sees about
 * a GIF is here, with the one threshold that decides the warning.
 *
 * Events that arrive after the switch went back to Video (a progress tick or a
 * `done` racing a cancel) are ignored: the reducer only listens to a
 * conversion while one is showing.
 */
export type OutputFormat = "video" | "gif";

export type GifState =
  | { kind: "video" }
  | { kind: "converting"; permille: number }
  | { kind: "ready"; bytes: number }
  | { kind: "failed"; detail: string };

export type GifEvent =
  | { kind: "pick"; format: OutputFormat }
  | { kind: "progress"; done: number; total: number }
  | { kind: "done"; bytes: number }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/** Decimal bytes, so the number matches what Finder shows. */
export const GIF_LARGE_BYTES = 10_000_000;

export const INITIAL_GIF_STATE: GifState = { kind: "video" };

export function formatOf(s: GifState): OutputFormat {
  return s.kind === "video" ? "video" : "gif";
}

/** What a pick must make main do: start (or reuse) a conversion, cancel one, or nothing. */
export function effectOfPick(s: GifState, format: OutputFormat): "start" | "cancel" | "none" {
  if (format === "gif") return s.kind === "video" || s.kind === "failed" ? "start" : "none";
  return s.kind === "converting" ? "cancel" : "none";
}

export function reduceGif(s: GifState, e: GifEvent): GifState {
  switch (e.kind) {
    case "pick":
      if (e.format === "video") return { kind: "video" };
      return effectOfPick(s, "gif") === "start" ? { kind: "converting", permille: 0 } : s;
    case "progress": {
      if (s.kind !== "converting") return s;
      const permille = e.total > 0
        ? Math.max(0, Math.min(1000, Math.round((e.done / e.total) * 1000)))
        : 0;
      return { kind: "converting", permille };
    }
    case "done":
      return s.kind === "converting" ? { kind: "ready", bytes: e.bytes } : s;
    case "failed":
      return s.kind === "converting" ? { kind: "failed", detail: e.detail } : s;
    case "cancelled":
      return s.kind === "converting" ? { kind: "video" } : s;
  }
}

/** Decimal, Finder-style: "820 KB", "3.4 MB", "14 MB". */
export function formatBytes(n: number): string {
  if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))} KB`;
  const mb = n / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

export function gifLabel(s: GifState): { text: string; warn: boolean } | null {
  switch (s.kind) {
    case "video":
      return null;
    case "converting":
      return { text: `GIF ${Math.floor(s.permille / 10)}%`, warn: false };
    case "ready":
      return s.bytes > GIF_LARGE_BYTES
        ? { text: `GIF · ${formatBytes(s.bytes)} — large for a GIF; Video is smaller`, warn: true }
        : { text: `GIF · ${formatBytes(s.bytes)}`, warn: false };
    case "failed":
      return { text: `GIF failed — ${s.detail}`, warn: true };
  }
}

/** Copy and Save wait out a conversion; they are only off when there is nothing to copy. */
export function copySaveEnabled(s: GifState): boolean {
  return s.kind !== "failed";
}
