/**
 * Main's record of which GIF sits in `copiesRoot` for each take, and what it
 * was made WITH (STC-395). The file's name carries no settings (it is what a
 * paste shows), so this is what decides reuse. In memory on purpose: a fresh
 * panel does not outlive the app, and after a restart a flip just re-renders.
 *
 * Every job takes a generation; only the newest job for a take may record its
 * result, so a cancelled or superseded job finishing late cannot claim the file.
 * `forget` bumps the generation too, which is what makes a cancel stick.
 *
 * Settings are compared ONLY when the person picks GIF (spec §3). Copy and
 * Save ask with `"any"`: they take whatever GIF the panel is showing, made
 * with whatever settings were current when it started. A setting changed
 * while a GIF is ready must not turn a Copy into a hidden re-render.
 */
import type { GifSettings } from "@transform/gif-options.js";

export interface GifEntry { path: string; settings: GifSettings; bytes: number }

export class GifCache {
  private readonly entries = new Map<string, GifEntry>();
  private readonly gens = new Map<string, number>();

  lookup(takeDir: string, settings: GifSettings | "any"): GifEntry | undefined {
    const e = this.entries.get(takeDir);
    if (!e) return undefined;
    if (settings === "any") return e;
    return e.settings.fps === settings.fps && e.settings.maxWidth === settings.maxWidth ? e : undefined;
  }
  /** Whether `gen` is still this take's newest job — a queued start asks before it renders. */
  isCurrent(takeDir: string, gen: number): boolean {
    return this.gens.get(takeDir) === gen;
  }
  begin(takeDir: string): number {
    this.entries.delete(takeDir);
    const g = (this.gens.get(takeDir) ?? 0) + 1;
    this.gens.set(takeDir, g);
    return g;
  }
  settle(takeDir: string, gen: number, entry: GifEntry): boolean {
    if (this.gens.get(takeDir) !== gen) return false;
    this.entries.set(takeDir, entry);
    return true;
  }
  forget(takeDir: string): void {
    this.entries.delete(takeDir);
    this.gens.set(takeDir, (this.gens.get(takeDir) ?? 0) + 1);
  }
}
