import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoSlug, DEFAULT_EMBED_TEMPLATE, DEFAULT_SLUG, SLUG_PATTERN, embedSnippet,
  exportManifestName, exportMediaName, planPublish, publicSrc, slugIsValid,
} from "../src/share.js";

/**
 * STC-242 — the publish decisions, tested where they are decidable.
 *
 * `main.ts` copies a file and reveals it and decides nothing, so everything
 * worth asserting is in here and needs no Electron.
 */

const REQ = {
  exportFile: "/Users/x/Desktop/stc/2026-09-09_14-22-05.mp4",
  destination: "/Users/x/site/public/lab/videos",
  slug: "network",
};

describe("planPublish", () => {
  test("an export is named for its take, with no prefix", () => {
    expect(exportMediaName("2026-09-22_14-30-01")).toBe("2026-09-22_14-30-01.mp4");
  });

  test("publish copies the file it was handed", () => {
    const plan = planPublish({
      exportFile: "/tmp/f/2026-09-22_14-30-01.mp4",
      destination: "/site", slug: "network",
    });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.from).toBe("/tmp/f/2026-09-22_14-30-01.mp4");
    expect(plan.from).not.toContain("/raw/");
  });

  /**
   * The load-bearing case. Deriving `<root>/<takeName>.mp4` would miss this
   * file entirely and report the take as unexported — the whole reason
   * `PublishRequest` takes a resolved path rather than a take name.
   */
  test("A RENAMED export still publishes — the path is not re-derived", () => {
    const plan = planPublish({
      exportFile: "/tmp/f/login-bug.mp4",
      destination: "/site", slug: "network",
    });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.from).toBe("/tmp/f/login-bug.mp4");
    // ...and it still publishes under the STABLE slug, not the user's filename.
    expect(plan.name).toBe("network.mp4");
  });

  test("no export yet is still refused", () => {
    const plan = planPublish({ exportFile: null, destination: "/site", slug: "network" });
    expect(plan.kind).not.toBe("ready");
  });

  test("names the destination file from the SLUG, never from the take", () => {
    const plan = planPublish(REQ);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.name).toBe("network.mp4");
    expect(plan.to).toBe("/Users/x/site/public/lab/videos/network.mp4");
    // `from` is exactly the path this was handed — never re-derived from a
    // take name, which is the fix this task exists to make.
    expect(plan.from).toBe(REQ.exportFile);
  });

  /**
   * The property the whole design rests on: two different takes publish to the
   * SAME path. That is what lets the page embed a fixed src and a re-shoot
   * cost nothing, and it is the reason the overwrite is deliberate rather than
   * a bug — so it is asserted rather than left as a comment.
   */
  test("two takes of the same demo publish to one path", () => {
    const a = planPublish(REQ);
    const b = planPublish({ ...REQ, exportFile: "/Users/x/Desktop/stc/2026-10-01_09-00-00.mp4" });
    expect(a.kind).toBe("ready");
    expect(b.kind).toBe("ready");
    if (a.kind !== "ready" || b.kind !== "ready") throw new Error("unreachable");
    expect(b.to).toBe(a.to);
    expect(b.from).not.toBe(a.from);
  });

  test("refuses with a reason rather than defaulting, for each way it can fail", () => {
    const noDest = planPublish({ ...REQ, destination: null });
    expect(noDest.kind).toBe("no-destination");
    expect(noDest.kind !== "ready" && noDest.message).toMatch(/site repo/i);

    const noExport = planPublish({ ...REQ, exportFile: null });
    expect(noExport.kind).toBe("no-export");
    expect(noExport.kind !== "ready" && noExport.message).toMatch(/export/i);

    const badSlug = planPublish({ ...REQ, slug: "My Demo" });
    expect(badSlug.kind).toBe("bad-slug");
    expect(badSlug.kind !== "ready" && badSlug.message).toContain("My Demo");
  });

  /**
   * Ordering is a decision, not an accident: a run with two things wrong
   * reports the slug first, because it is the one the user typed and the one
   * they can fix without a file picker.
   */
  test("reports the slug before the destination when both are wrong", () => {
    expect(planPublish({ ...REQ, slug: "", destination: null }).kind).toBe("bad-slug");
  });

  test("joins a destination that already ends in a separator without doubling it", () => {
    const plan = planPublish({ ...REQ, destination: "/Users/x/site/public/lab/videos/" });
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.to).toBe("/Users/x/site/public/lab/videos/network.mp4");
    expect(plan.to).not.toContain("//");
  });
});

describe("slugs", () => {
  test("accepts what a URL and a filename can both carry", () => {
    for (const ok of ["network", "vividly", "a", "demo-2", "x1"]) {
      expect(slugIsValid(ok), ok).toBe(true);
    }
  });

  /**
   * Each of these is refused for its own reason, and traversal is the one that
   * matters most: the slug becomes a path segment in a `copyFile` destination,
   * so a slug that could escape would write outside the folder the user chose.
   */
  test("refuses traversal, separators, spaces, dots, case and emptiness", () => {
    for (const bad of ["..", "../etc", "a/b", "a b", "a.mp4", "Network", "", "-lead", "a_b"]) {
      expect(slugIsValid(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("the pattern is anchored, so a bad slug cannot hide inside a good one", () => {
    expect(SLUG_PATTERN.test("ok/../../etc")).toBe(false);
    expect(SLUG_PATTERN.source.startsWith("^")).toBe(true);
    expect(SLUG_PATTERN.source.endsWith("$")).toBe(true);
  });

  test("the default slug is itself valid", () => {
    expect(slugIsValid(DEFAULT_SLUG)).toBe(true);
  });
});

describe("autoSlug", () => {
  test("lowercases and collapses non-alphanumeric runs to one hyphen", () => {
    expect(autoSlug("My Demo")).toBe("my-demo");
    expect(autoSlug("2026-08-24_10-00-00")).toBe("2026-08-24-10-00-00");
  });

  test("trims leading and trailing hyphens the collapse can produce", () => {
    expect(autoSlug("__My Demo!!")).toBe("my-demo");
  });

  test("falls back to DEFAULT_SLUG when there is nothing usable left", () => {
    expect(autoSlug("")).toBe(DEFAULT_SLUG);
    expect(autoSlug("!!!")).toBe(DEFAULT_SLUG);
  });

  test("what it returns always passes slugIsValid", () => {
    for (const name of ["My Demo", "", "!!!", "2026-08-24_10-00-00", "Login Bug #42"]) {
      expect(slugIsValid(autoSlug(name)), name).toBe(true);
    }
  });
});

describe("the embed snippet", () => {
  test("substitutes what it knows", () => {
    const out = embedSnippet(DEFAULT_EMBED_TEMPLATE,
      { src: "/lab/videos/network.mp4", slug: "network", width: 2464, height: 1386 });
    expect(out).toContain("src: '/lab/videos/network.mp4'");
    expect(out).toContain("width: 2464");
    expect(out).toContain("height: 1386");
    expect(out).toContain("network: {");
    expect(out).toContain("published: true");
  });

  /**
   * The default template is the site's DATA ENTRY, not an HTML tag, and the
   * blanks only a person can fill stay visibly blank (STC-313).
   *
   * `label` and `caption` are prose about what the viewer is looking at. A
   * template that invented them would paste plausible-looking wrong copy onto
   * a portfolio page, which is the same failure as `width="0"` one layer up:
   * a wrong answer wearing a right answer's clothes.
   */
  test("the default template leaves the prose blank rather than inventing it", () => {
    const out = embedSnippet(DEFAULT_EMBED_TEMPLATE,
      { src: "/lab/videos/network.mp4", slug: "network", width: 2464, height: 1386 });
    expect(out).toContain("{label}");
    expect(out).toContain("{caption}");
    expect(out).toContain("{poster}");
    // Not an HTML tag: pasting one into the page would be a second way to put
    // a video there, bypassing the site's own check that the file exists.
    expect(out).not.toContain("<video");
  });

  /**
   * The half that matters more than the substitution.
   *
   * An export whose manifest is missing has no dimensions to offer, and the
   * snippet must SAY so rather than paste `width="0"` into somebody's page — a
   * zero renders as a real attribute and a collapsed video, which is a wrong
   * answer wearing a right answer's clothes.
   */
  test("leaves a token unsubstituted when the value is unknown", () => {
    const out = embedSnippet(DEFAULT_EMBED_TEMPLATE, { src: "/x.mp4", slug: "x" });
    expect(out).toContain("{width}");
    expect(out).toContain("{height}");
    expect(out).not.toContain("width: 0");
    expect(out).toContain("src: '/x.mp4'");
  });

  test("leaves a token it does not know alone", () => {
    expect(embedSnippet('<video src="{src}" poster="{poster}">',
                        { src: "/x.mp4", slug: "x" })).toContain("{poster}");
  });

  /**
   * Checked against the real site (STC-313), which is how the old answer was
   * found to be wrong.
   *
   * `publicSrc` used to nest the slug under itself — `/lab/network/network.mp4`
   * — which needed a `public/lab/network/` directory on a site where
   * `/lab/network` is a live SSR route, and named a path the copy never wrote.
   * STC-242's runbook predicted exactly this symptom: a snippet whose `src`
   * 404s while the file sits in the folder the user chose.
   */
  test("the public src is built from the slug the file was published under", () => {
    expect(publicSrc("network")).toBe("/lab/videos/network.mp4");
    expect(publicSrc("network", "/lab/videos/")).toBe("/lab/videos/network.mp4");
    expect(publicSrc("network", "/videos")).toBe("/videos/network.mp4");
  });

  /**
   * The control. Without it the assertion above is satisfied by any function
   * that happens to return that string, and the defect it replaced — the slug
   * appearing twice — would read as fixed by coincidence.
   */
  test("the slug appears exactly once in the published path", () => {
    const src = publicSrc("network");
    expect(src.split("network").length - 1).toBe(1);
    expect(src).not.toContain("/network/network");
  });
});

/**
 * The drift guard, and the reason this file reaches for the filesystem.
 *
 * The export names were built inline as template literals, and STC-242's
 * publish path — in the MAIN process — has to find that exact file
 * afterwards. That is one filename rule with two authors in two processes,
 * which CLAUDE.md records this repo fixing four times in a single session
 * under "one value, two copies". The export moved from `renderer.ts` to
 * `editor.ts` with the rest of the player (STC-373); the guard moved with it.
 *
 * A test that only checked `exportMediaName` would pass just as well with the
 * literal back in the editor, so this greps the real file. The controls
 * matter more than the assertion (STC-294's lesson): the pattern is proven to
 * fire against the literal it is meant to catch, so an empty result means the
 * second copy is gone rather than that the regex never worked.
 */
describe("the export filename lives in exactly one place", () => {
  const root = join(__dirname, "..", "..");
  const editor = readFileSync(join(root, "app", "src", "editor.ts"), "utf8");
  /**
   * The shape of an inline copy — `${…}.mp4` with or WITHOUT the old
   * `export-` prefix, or `export-${…}.json`.
   *
   * The optional prefix is the whole point of this widening. STC-413 dropped
   * `export-` from the media name (its LOCATION says "finished" now), and
   * the guard stayed anchored to the prefix — so it could still catch a copy
   * of the OLD rule and not one of the rule it is actually keeping, which is
   * a guard that has quietly stopped guarding. The manifest keeps its
   * prefix, so its half stays exact rather than being loosened for symmetry.
   */
  const INLINE = /`(?:export-)?\$\{[^`]*\}\.mp4`|`export-\$\{[^`]*\}\.json`/g;

  test("the pattern can fire", () => {
    // The old shape...
    expect("const name = `export-${takeName}.mp4`;".match(INLINE)).toHaveLength(1);
    expect("`export-${n}.json`".match(INLINE)).toHaveLength(1);
    // ...and the CURRENT one, which the prefix-anchored version could not see.
    expect("const name = `${takeName}.mp4`;".match(INLINE)).toHaveLength(1);
  });

  test("and does not fire on the editor as it stands", () => {
    // Comments are blanked first: this file's own explanation of the rule
    // mentions the literal, and a guard that flags a file for DISCUSSING the
    // rule it keeps is a guard someone turns off (STC-294).
    const code = editor
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code.match(INLINE) ?? []).toEqual([]);
  });

  test("and the editor uses the shared functions instead", () => {
    expect(editor).toContain("exportMediaName(takeName)");
    expect(editor).toContain("exportManifestName(takeName)");
  });

  /**
   * They no longer land beside each other (STC-413) — the media file moved
   * to the top level of the folder and the manifest stayed in the bundle —
   * so they no longer need to agree on a stem either. The media name lost
   * its `export-` prefix because its LOCATION now says "finished"; the
   * manifest keeps it, since it is still describing itself as derived from
   * the app's own process, sitting where the rest of the bundle's
   * provenance already does.
   */
  test("the media name has no prefix; the manifest still names itself as derived", () => {
    const take = "2026-09-09_14-22-05";
    expect(exportMediaName(take)).toBe(`${take}.mp4`);
    expect(exportManifestName(take)).toBe(`export-${take}.json`);
  });
});
