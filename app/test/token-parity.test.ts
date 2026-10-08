/**
 * Token parity (STC-504) — the countdown, the floating panel and the selection
 * overlay are on `tokens.css`, and stay on it.
 *
 * Two halves, because they catch different regressions:
 *
 *   SOURCE   — a grep over the three pages. A raw colour, or a page that stopped
 *              linking tokens.css, fails here before anything renders.
 *   PIXELS   — each page loaded in a real browser (headless Chrome, the same one
 *              scripts/gate.mjs uses). Proves the tokens are actually APPLIED:
 *              the surface is dark under BOTH OS appearances (the theme rule —
 *              tokens.css), and changing `--accent` changes what is drawn.
 *
 * A browser that cannot launch FAILS the pixel half rather than skipping it: a
 * skip reads as covered (CLAUDE.md, *.grant.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const RENDERER = fileURLToPath(new URL("../renderer/", import.meta.url));
const read = (f: string) => readFileSync(join(RENDERER, f), "utf8");

const SURFACES = ["countdown.html", "thumbnail.html", "overlay.html"] as const;

/** `#rgb`/`#rrggbb[aa]` and rgb()/rgba()/hsl() — HTML entities like `&#8629;` are not colours. */
const RAW_COLOUR = /(?<!&)#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

describe("source: the three short-lived surfaces", () => {
  for (const file of SURFACES) {
    const src = read(file);
    it(`${file} has no raw colour`, () => {
      expect(src.match(RAW_COLOUR) ?? []).toEqual([]);
    });
    it(`${file} links tokens.css and declares itself a dark surface`, () => {
      expect(src).toMatch(/<link rel="stylesheet" href="tokens\.css">/);
      expect(src).toMatch(/<html data-surface="dark">/);
    });
    it(`${file} reads its values from var(--…)`, () => {
      expect((src.match(/var\(--/g) ?? []).length).toBeGreaterThan(10);
    });
  }

  it("the countdown numerals are not Silkscreen (it renders elapsed take time only)", () => {
    expect(read("countdown.html")).not.toMatch(/font-pixel|Silkscreen|type-timer/);
  });
});

describe("source: tokens.css", () => {
  /** The `--name: value` pairs inside the first block matching `open`. */
  const block = (css: string, open: RegExp): Map<string, string> => {
    const m = open.exec(css);
    if (!m) throw new Error(`no block matches ${open}`);
    const start = css.indexOf("{", m.index) + 1;
    const end = css.indexOf("}", start);
    const out = new Map<string, string>();
    for (const d of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(d[1]!, d[2]!.trim());
    return out;
  };

  it("data-surface=dark carries exactly the prefers-color-scheme: dark values", () => {
    const css = read("tokens.css");
    const media = block(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root/);
    const attr = block(css, /:root\[data-surface="dark"\]/);
    expect(media.size).toBeGreaterThan(10);
    expect(Object.fromEntries(attr)).toEqual(Object.fromEntries(media));
  });
});

describe("pixels: tokens are applied", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** Open a surface, forcing the OS appearance. Missing ../dist scripts 404 — irrelevant here. */
  const open = async (file: string, scheme: "light" | "dark"): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 360, height: 220 }, colorScheme: scheme });
    await page.goto(pathToFileURL(join(RENDERER, file)).href);
    await page.evaluate(() => document.fonts.ready);
    return page;
  };

  /** Put something accent-coloured on screen that the real script would show in some state. */
  const showAccent = async (page: Page, file: string): Promise<void> => {
    await page.evaluate((f) => {
      const $ = (id: string) => document.getElementById(id)!;
      if (f === "thumbnail.html") {
        $("card").classList.add("in"); // the renderer adds this on show; it is opacity 0 until then
        // A recording's Copy renders first and shows this bar (STC-488).
        $("thumbwrap").hidden = true;
        $("takecard").hidden = false;
        const p = $("copyprogress") as HTMLProgressElement;
        p.hidden = false;
        p.value = 600;
        p.style.height = "40px";
      }
      if (f === "overlay.html") {
        // Window mode's pick outline.
        Object.assign($("highlight").style, { display: "block", left: "40px", top: "40px", width: "200px", height: "120px" });
      }
    }, file);
  };

  const shot = (page: Page) => page.screenshot({ animations: "disabled" });

  for (const file of SURFACES) {
    it(`${file} stays dark under a light OS appearance`, async () => {
      const light = await open(file, "light");
      const dark = await open(file, "dark");
      const read = (p: Page) =>
        p.evaluate(() => {
          const s = getComputedStyle(document.documentElement);
          return [s.getPropertyValue("--text").trim(), s.getPropertyValue("--accent").trim(), s.colorScheme];
        });
      const [l, d] = await Promise.all([read(light), read(dark)]);
      expect(l).toEqual(d);
      expect(l[2]).toBe("dark");
      await Promise.all([light.close(), dark.close()]);
    });

    it(`${file} visibly changes when --accent changes`, async () => {
      const page = await open(file, "dark");
      await showAccent(page, file);
      const before = await shot(page);
      await page.evaluate(() => document.documentElement.style.setProperty("--accent", "#ff00ff"));
      const after = await shot(page);
      expect(Buffer.compare(before, after)).not.toBe(0);
      await page.close();
    });
  }
});
