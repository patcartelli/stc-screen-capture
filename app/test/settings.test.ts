import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettings, writeSettings, DEFAULT_SETTINGS, DEFAULT_SHARE_SETTINGS, DEFAULT_STILL_SETTINGS,
  DEFAULT_THUMBNAIL_SETTINGS, DEFAULT_SCOPE_SETTINGS,
} from "../src/settings.js";
import { SHOT_ACTIONS, DEFAULT_SHORTCUTS, HYPER } from "../src/hotkeys.js";
import { DEFAULT_COUNTDOWN_MS } from "../src/countdown.js";

/**
 * The camera preference is opt-in, default off, and sticky (design spec).
 *
 * It lives in the main process rather than the renderer because it decides
 * whether a physical camera LED comes on, and the renderer is not trusted with
 * paths or with being the source of truth for that.
 */
const dir = () => mkdtempSync(join(tmpdir(), "stc-settings-"));

describe("the camera preference", () => {
  test("defaults to off when nothing has been saved", () => {
    expect(readSettings(dir()))
      .toEqual({ camera: false, displayId: null, micDeviceUid: null, systemAudio: false,
                 shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, countdownMs: DEFAULT_COUNTDOWN_MS,
                 still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS,
                 scope: DEFAULT_SCOPE_SETTINGS, saveFolder: null, showDiagnostics: false,
                 libraryView: "grid" });
    expect(DEFAULT_SETTINGS.camera).toBe(false);
  });

  test("round-trips", () => {
    const d = dir();
    writeSettings(d, { camera: true });
    expect(readSettings(d).camera).toBe(true);
    writeSettings(d, { camera: false });
    expect(readSettings(d).camera).toBe(false);
  });

  // A corrupt sidecar must not cost a recording — the same rule parseProject
  // follows for a mangled project.json. Throwing here would mean a bad byte in
  // a preferences file makes the app unable to record at all.
  test("corrupt JSON falls back to the default instead of throwing", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), "{not json");
    expect(readSettings(d)).toEqual(DEFAULT_SETTINGS);
  });

  test("a file of the wrong shape falls back too", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify(["nope"]));
    expect(readSettings(d)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(join(d, "settings.json"), JSON.stringify({ camera: "yes" }));
    expect(readSettings(d).camera, "a non-boolean is not a preference").toBe(false);
  });

  // Otherwise a typo in one call silently persists a key nothing reads, and the
  // file becomes a place where wrong things accumulate unnoticed.
  test("unknown keys are dropped rather than persisted", () => {
    const d = dir();
    writeSettings(d, { camera: true, nonsense: 1 } as never);
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")))
      .toEqual({ camera: true, displayId: null, micDeviceUid: null, systemAudio: false,
                 shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, countdownMs: DEFAULT_COUNTDOWN_MS,
                 still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS,
                 scope: DEFAULT_SCOPE_SETTINGS, saveFolder: null, showDiagnostics: false,
                 libraryView: "grid" });
  });

  test("an unwritable directory does not throw — the preference is not worth a crash", () => {
    const d = join(dir(), "readonly");
    mkdirSync(d);
    chmodSync(d, 0o500);
    expect(() => writeSettings(d, { camera: true })).not.toThrow();
    chmodSync(d, 0o700);
  });

  test("a partial update leaves the rest alone", () => {
    const d = dir();
    writeSettings(d, { camera: true });
    writeSettings(d, {});
    expect(readSettings(d).camera).toBe(true);
    expect(existsSync(join(d, "settings.json"))).toBe(true);
  });
});

describe("the display preference (STC-247)", () => {
  test("defaults to automatic — null, which start() turns into no displayId at all", () => {
    expect(readSettings(dir()).displayId).toBeNull();
    expect(DEFAULT_SETTINGS.displayId).toBeNull();
  });

  test("round-trips an id and clears back to automatic", () => {
    const d = dir();
    writeSettings(d, { displayId: 69734662 });
    expect(readSettings(d).displayId).toBe(69734662);
    writeSettings(d, { displayId: null });
    expect(readSettings(d).displayId).toBeNull();
  });

  // A display id is a CGDirectDisplayID: a positive integer. Anything else is
  // not a choice, and passing it to the helper would be an error the user
  // never asked for.
  test("a value that is not a positive integer reads as automatic", () => {
    const d = dir();
    for (const bad of ["2", 0, -1, 1.5, true, {}]) {
      writeFileSync(join(d, "settings.json"), JSON.stringify({ camera: false, displayId: bad }));
      expect(readSettings(d).displayId, `displayId ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  test("a partial update leaves the display choice alone", () => {
    const d = dir();
    writeSettings(d, { displayId: 2 });
    writeSettings(d, { camera: true });
    expect(readSettings(d))
      .toEqual({ camera: true, displayId: 2, micDeviceUid: null, systemAudio: false,
                 shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, countdownMs: DEFAULT_COUNTDOWN_MS,
                 still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS,
                 scope: DEFAULT_SCOPE_SETTINGS, saveFolder: null, showDiagnostics: false,
                 libraryView: "grid" });
  });
});

/**
 * The shutter sound (STC-292). Unlike the camera, this defaults ON — macOS's
 * own screenshot makes a noise, and a capture with no window and no overlay has
 * no other feedback at all. Which is why every fallback here goes to ON, the
 * mirror of the camera's `=== true`.
 */
describe("the system-audio preference (STC-418)", () => {
  test("defaults to off — nobody records the machine's audio without turning it on", () => {
    expect(readSettings(dir()).systemAudio).toBe(false);
    expect(DEFAULT_SETTINGS.systemAudio).toBe(false);
  });

  test("persists when turned on, and back off", () => {
    const d = dir();
    expect(writeSettings(d, { systemAudio: true }).systemAudio).toBe(true);
    expect(readSettings(d).systemAudio).toBe(true);
    expect(writeSettings(d, { systemAudio: false }).systemAudio).toBe(false);
    expect(readSettings(d).systemAudio).toBe(false);
  });

  test("anything but a literal true is off, on read and on write", () => {
    for (const bad of ["true", 1, null, {}]) {
      const d = dir();
      writeFileSync(join(d, "settings.json"), JSON.stringify({ systemAudio: bad }));
      expect(readSettings(d).systemAudio, `stored ${JSON.stringify(bad)}`).toBe(false);
      expect(writeSettings(d, { systemAudio: bad as never }).systemAudio).toBe(false);
    }
  });

  test("an unrelated write does not turn it off", () => {
    const d = dir();
    writeSettings(d, { systemAudio: true });
    writeSettings(d, { camera: true });
    expect(readSettings(d).systemAudio).toBe(true);
  });
});

describe("the shutter sound preference", () => {
  test("defaults to on", () => {
    expect(readSettings(dir()).shutterSound).toBe(true);
  });

  test("round-trips, and being off survives a restart", () => {
    const d = dir();
    writeSettings(d, { shutterSound: false });
    expect(readSettings(d).shutterSound).toBe(false);
    writeSettings(d, { shutterSound: true });
    expect(readSettings(d).shutterSound).toBe(true);
  });

  test("a non-boolean is not a preference, and falls back to ON not to silence", () => {
    const d = dir();
    for (const bad of ["false", 0, null, {}]) {
      writeFileSync(join(d, "settings.json"), JSON.stringify({ shutterSound: bad }));
      expect(readSettings(d).shutterSound, JSON.stringify(bad)).toBe(true);
    }
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { shutterSound: false });
    writeSettings(d, { camera: true });
    expect(readSettings(d).shutterSound).toBe(false);
  });
});

/**
 * The capture shortcuts (STC-292). Stored here rather than in the renderer for
 * the same reason the camera is: main registers them at launch, before any
 * window exists, so a preference the renderer owned would arrive too late to
 * be the thing that binds.
 */
describe("the capture shortcuts", () => {
  test("default to the hyperkey row when nothing has been saved", () => {
    expect(readSettings(dir()).shortcuts).toEqual({
      region: `${HYPER}+1`, window: `${HYPER}+2`, display: `${HYPER}+3`,
      // STC-391. 5 rather than 4, leaving 4 for the Record flow (STC-388).
      "self-timer": `${HYPER}+5`,
    });
  });

  test("a rebinding round-trips, which is the acceptance criterion", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, region: "Alt+Shift+R" } });
    // Read back through a fresh call, as a relaunch would.
    expect(readSettings(d).shortcuts.region).toBe("Alt+Shift+R");
    expect(readSettings(d).shortcuts.window).toBe(DEFAULT_SHORTCUTS.window);
  });

  test("stored NORMALISED, so the file, the menu bar and the report agree", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, window: "shift+alt+r" } });
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")).shortcuts.window)
      .toBe("Alt+Shift+R");
  });

  test("an unbound action stays unbound across a restart", () => {
    // `null` is a preference, not an absence: springing back to the default the
    // next time the file is read would silently rebind a key the user cleared.
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, display: null } });
    expect(readSettings(d).shortcuts.display).toBeNull();
  });

  test("a binding that no longer parses falls back to the default, not to nothing", () => {
    const d = dir();
    for (const bad of ["Command+Hyper", "A", 7, {}, ["Command+A"]]) {
      writeFileSync(join(d, "settings.json"),
                    JSON.stringify({ shortcuts: { region: bad } }));
      expect(readSettings(d).shortcuts.region, JSON.stringify(bad))
        .toBe(DEFAULT_SHORTCUTS.region);
    }
  });

  test("a hand-edited file naming a system binding falls back rather than storing it", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ shortcuts: { region: "Command+Shift+4" } }));
    expect(readSettings(d).shortcuts.region).toBe(DEFAULT_SHORTCUTS.region);
  });

  test("a partial update leaves the shortcuts alone", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, region: null } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).shortcuts.region).toBeNull();
  });

  test("only known actions are written — a typo cannot accumulate in the file", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, regoin: "Alt+X" } as never });
    const stored = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    // The declared list rather than three literals: the fault this catches is
    // `regoin` reaching the file, which it still catches, and it does not go
    // stale the next time an action is added.
    expect(Object.keys(stored.shortcuts).sort()).toEqual([...SHOT_ACTIONS].sort());
  });
});

/**
 * STC-242: where a shared take goes. Same rules as every other block — an
 * unknown shape falls back whole, each field is validated on its own terms.
 *
 * The slug moved off this object in STC-444 slice 3 (it is per-take now,
 * `Project.slug` in `transform/src/types.ts`) — `settings.test.ts` no
 * longer has anything to say about it; `share.test.ts` covers `autoSlug`
 * and `slugIsValid`, and `settings.ts`'s own `cleanShare` comment covers
 * what happens to a slug still sitting in an old settings file.
 */
describe("the share preferences (STC-242)", () => {
  test("defaults to no site folder", () => {
    const s = readSettings(dir()).share;
    // Null rather than a guess: this app cannot know where someone keeps a
    // site checkout, and a wrong default writes a file somewhere unasked.
    expect(s.destination).toBeNull();
    expect(s.embedTemplate).toContain("{src}");
  });

  test("the site folder is sticky and survives an unrelated change", () => {
    const d = dir();
    writeSettings(d, { share: { ...readSettings(d).share, destination: "/Users/me/site/public" } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).share.destination).toBe("/Users/me/site/public");
  });

  test("a relative destination is treated as unset, not resolved against cwd", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ share: { destination: "site/public" } }));
    expect(readSettings(d).share.destination).toBeNull();
  });

  test("an empty template falls back rather than pasting nothing", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ share: { embedTemplate: "   " } }));
    expect(readSettings(d).share.embedTemplate).toContain("{src}");
  });

  /**
   * A settings file written before STC-444 slice 3 still has `share.slug`
   * sitting in it. This is the migration path: the stray field is dropped
   * rather than tripping `additionalProperties`-style validation or leaking
   * into `ShareSettings`, and the fields around it are still honoured.
   */
  test("a stray pre-slice-3 slug is dropped, not carried or repaired", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ share: { slug: "network", destination: "/s" } }));
    const s = readSettings(d).share as unknown as Record<string, unknown>;
    expect("slug" in s).toBe(false);
    expect(s.destination).toBe("/s");
  });
});

/**
 * STC-293: the still export preferences. Format, quality, scale, metadata
 * stripping, and filename template, shared by every exit out of the app —
 * the ticket's Note forbids the thumbnail growing its own. Save folder moved
 * to Settings.saveFolder (STC-412).
 */
describe("the still export preferences (STC-293)", () => {
  test("defaults are PNG, native scale, metadata kept", () => {
    const s = readSettings(dir()).still;
    expect(s.format).toBe("png");
    expect(s.scale).toBe("native");
    expect(s.stripMetadata).toBe(false);
    expect(s.template).toContain("{date}");
  });

  test("a still preference survives an unrelated camera change", () => {
    const d = dir();
    writeSettings(d, { still: { ...readSettings(d).still, format: "heic" } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).still.format).toBe("heic");
  });

  test("an unknown format or scale falls back rather than reaching the encoder", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ still: { format: "webp", scale: "4x", quality: 99 } }));
    const s = readSettings(d).still;
    expect(s.format).toBe("png");
    expect(s.scale).toBe("native");
    expect(s.quality).toBe(1);
  });

  test("an empty template falls back, so a save is never named \".png\"", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ still: { template: "   " } }));
    expect(readSettings(d).still.template).toBe(DEFAULT_SETTINGS.still.template);
  });

  test("a still block of the wrong shape falls back whole", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ still: "png please" }));
    expect(readSettings(d).still).toEqual(DEFAULT_SETTINGS.still);
  });
});

/**
 * STC-412: one save location for both recordings and stills, replacing
 * StillSettings.destination and the "beside the shot" concept.
 */
describe("the save folder (STC-412)", () => {
  test("defaults to null — 'not chosen', which takesRoot() resolves the same way it always has", () => {
    expect(readSettings(dir()).saveFolder).toBeNull();
    expect(DEFAULT_SETTINGS.saveFolder).toBeNull();
  });

  test("round-trips an absolute path", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    expect(readSettings(d).saveFolder).toBe("/Users/me/Captures");
  });

  test("a relative path is treated as unset, never resolved against the cwd", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ saveFolder: "Captures" }));
    expect(readSettings(d).saveFolder).toBeNull();
  });

  test("clearing it back to null is a real, storable choice", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    writeSettings(d, { saveFolder: null });
    expect(readSettings(d).saveFolder).toBeNull();
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    writeSettings(d, { camera: true });
    expect(readSettings(d).saveFolder).toBe("/Users/me/Captures");
  });
});

describe("the diagnostics toggle (STC-412)", () => {
  test("defaults to off — developer instrumentation, not a normal control", () => {
    expect(readSettings(dir()).showDiagnostics).toBe(false);
    expect(DEFAULT_SETTINGS.showDiagnostics).toBe(false);
  });

  test("round-trips, and being on survives a restart", () => {
    const d = dir();
    writeSettings(d, { showDiagnostics: true });
    expect(readSettings(d).showDiagnostics).toBe(true);
  });

  test("a non-boolean is not a preference, and falls back to OFF not to silence", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ showDiagnostics: "yes" }));
    expect(readSettings(d).showDiagnostics).toBe(false);
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { showDiagnostics: true });
    writeSettings(d, { camera: true });
    expect(readSettings(d).showDiagnostics).toBe(true);
  });
});

/**
 * The post-capture floating thumbnail's preferences (STC-296, narrowed by
 * STC-392): where it sits, and whether it shows at all. `thumbnail.ts` owns
 * the validation rule (the corner enum); this only checks that `settings.ts`
 * applies it the same way every other block here is applied — falls back
 * field by field, and a partial update leaves the rest alone.
 */
describe("the thumbnail preferences (STC-296)", () => {
  test("defaults: bottom-right, not skipped", () => {
    const t = readSettings(dir()).thumbnail;
    expect(t).toEqual({ corner: "bottom-right", skip: false });
  });

  test("round-trips a full change", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { corner: "top-left", skip: true } });
    expect(readSettings(d).thumbnail)
      .toEqual({ corner: "top-left", skip: true });
  });

  test("changing one field does not drop the others", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, corner: "top-right" } });
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, skip: true } });
    const t = readSettings(d).thumbnail;
    expect(t.corner).toBe("top-right");
    expect(t.skip).toBe(true);
  });

  test("an unknown corner falls back rather than reaching the window", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ thumbnail: { corner: "middle" } }));
    const t = readSettings(d).thumbnail;
    expect(t.corner).toBe("bottom-right");
  });

  test("a non-boolean skip is not a preference, and falls back to off", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ thumbnail: { skip: "yes" } }));
    expect(readSettings(d).thumbnail.skip).toBe(false);
  });

  test("a thumbnail block of the wrong shape falls back whole", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ thumbnail: "bottom-right please" }));
    expect(readSettings(d).thumbnail).toEqual(DEFAULT_SETTINGS.thumbnail);
  });

  test("a still-preference change leaves the thumbnail preference alone, and vice versa", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, skip: true } });
    writeSettings(d, { still: { ...readSettings(d).still, format: "heic" } });
    expect(readSettings(d).thumbnail.skip).toBe(true);
    expect(readSettings(d).still.format).toBe("heic");
  });

  test("the panel's clock is not a preference any more (STC-392)", () => {
    // Both described a timeout that no longer exists. A stored `settleAction`
    // after this ticket would be a preference with no code path, which is
    // worse than no preference: it reads as configurable and changes nothing.
    const s = readSettings(dir());
    expect(s.thumbnail).not.toHaveProperty("timeoutMs");
    expect(s.thumbnail).not.toHaveProperty("settleAction");
    // The controls: what SURVIVES, so this cannot pass by the block being gone.
    expect(s.thumbnail).toHaveProperty("corner");
    expect(s.thumbnail).toHaveProperty("skip");
  });

  test("a settings file written before STC-392 loses the two dead keys", () => {
    // Someone upgrading has both in their settings.json. `cleanThumbnail` must
    // drop them rather than carrying them forward forever.
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({
      thumbnail: { corner: "top-left", skip: false, timeoutMs: 9000, settleAction: "copy" },
    }));
    const s = readSettings(d);
    expect(s.thumbnail.corner).toBe("top-left");
    expect(s.thumbnail).not.toHaveProperty("timeoutMs");
  });
});

describe("the capture scope (STC-370/STC-374)", () => {
  test("defaults to the whole display, nothing picked", () => {
    expect(readSettings(dir()).scope).toEqual(DEFAULT_SCOPE_SETTINGS);
  });

  test("round-trips a region", () => {
    const d = dir();
    writeSettings(d, { scope: { kind: "region", region: { displayId: 2, x: 10, y: 20, width: 300, height: 200 },
                                 windowId: null, windowLabel: null } });
    expect(readSettings(d).scope).toEqual({
      kind: "region", region: { displayId: 2, x: 10, y: 20, width: 300, height: 200 },
      windowId: null, windowLabel: null,
    });
  });

  test("round-trips a window and its cosmetic label", () => {
    const d = dir();
    writeSettings(d, { scope: { kind: "window", region: null, windowId: 4242, windowLabel: "Safari — Example" } });
    expect(readSettings(d).scope).toEqual({
      kind: "window", region: null, windowId: 4242, windowLabel: "Safari — Example",
    });
  });

  // `kind` is kept even with nothing valid picked for it — "window scope, no
  // window yet" is a real state the source control has to show, not an error
  // to correct here. `recorder:start` is where that combination is refused.
  test("kind survives a region or window that fails validation", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ scope: { kind: "window", windowId: "not-a-number" } }));
    const scope = readSettings(d).scope;
    expect(scope.kind).toBe("window");
    expect(scope.windowId).toBeNull();
  });

  test("an unknown kind falls back to display", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ scope: { kind: "fullscreen" } }));
    expect(readSettings(d).scope.kind).toBe("display");
  });

  // Same rule `parseRect` enforces helper-side: a region needs a display to be
  // local to and four finite, positive-sized numbers, or it is not a region.
  test("a region missing its display, or with a non-positive size, is dropped", () => {
    const d = dir();
    for (const bad of [
      { x: 0, y: 0, width: 100, height: 100 }, // no displayId
      { displayId: 1, x: 0, y: 0, width: 0, height: 100 },
      { displayId: 1, x: 0, y: 0, width: 100, height: -1 },
      { displayId: 1, x: "0", y: 0, width: 100, height: 100 },
    ]) {
      writeFileSync(join(d, "settings.json"), JSON.stringify({ scope: { kind: "region", region: bad } }));
      expect(readSettings(d).scope.region, JSON.stringify(bad)).toBeNull();
    }
  });

  test("a scope change leaves the display id and other preferences alone, and vice versa", () => {
    const d = dir();
    writeSettings(d, { displayId: 2 });
    writeSettings(d, { scope: { kind: "window", region: null, windowId: 7, windowLabel: null } });
    expect(readSettings(d).displayId).toBe(2);
    expect(readSettings(d).scope.kind).toBe("window");
  });

  test("a scope block of the wrong shape falls back whole", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ scope: "window please" }));
    expect(readSettings(d).scope).toEqual(DEFAULT_SCOPE_SETTINGS);
  });
});
