import type { LibraryActionId, LibraryItem, LibraryList } from "./library-items.js";

/**
 * The library grid. Draws what the adapter hands it and decides nothing
 * (STC-294).
 *
 * ## Why this is its own file
 *
 * The ticket's fourth acceptance criterion is *"no view component branches on
 * kind outside the adapter"*, and `app/test/library-seam.test.ts` enforces it by
 * grepping. Grepping `renderer.ts` for `.kind` does not work: that file already
 * has an unrelated one — a capture RESULT's shot kind (`display-crop` /
 * `window`) in the status line — and a guard that fires on legitimate code is a
 * guard someone turns off within a day. So the library's view is a module of
 * its own, which must never mention kind at all, and the grep is exact.
 *
 * That is not a trick to satisfy a test. It is the criterion's own logic: if
 * the view can be written without knowing what kinds exist, the seam really is
 * in one place, and the way to be sure is to put the view somewhere the word
 * cannot appear.
 *
 * ## What it therefore may not do
 *
 * No "if this is a still". The badge is text the adapter wrote, the summary is
 * a string it composed, the buttons are a list it chose, and the filter chips
 * are data it supplied. When something here needs a fact this module cannot
 * see, the instruction from the ticket is to widen `LibraryItem` deliberately —
 * never to reach for the kind at the call site.
 *
 * ## STC-429 — grid, list, and the button hierarchy
 *
 * A second layout (`view: "list"`) reuses the exact same card-building code as
 * the grid; only the wrapper's class name differs (`.librow` vs `.libtile`),
 * and CSS alone turns the same DOM into a row. No second builder, no branch
 * on which layout is showing.
 *
 * Actions are still one flat, always-visible row of buttons — never a
 * collapsed overflow menu — because several existing tests locate an action
 * by `button[data-action="…"]` and click it directly; hiding "rename" or
 * "reveal" behind a menu would need those to open it first. The visual
 * hierarchy the ticket asks for (Edit/Share primary, Delete de-emphasised,
 * Rename/Show/Duplicate quieter) is expressed as a CSS class keyed off the
 * action id alone (`primary` for "open"/"share", `delete` for "delete",
 * `tertiary` for everything else) — still data the adapter chose the shape
 * of, never a kind check.
 */

/** Everything the view needs done for it. Each is the shared UI's one door. */
export interface LibraryCallbacks {
  /** A tile's button was pressed. Dispatched by action id — never by kind. */
  act(id: LibraryActionId, item: LibraryItem): void | Promise<void>;
  /** A rename was committed with a non-empty, changed value. */
  rename(item: LibraryItem, label: string): void | Promise<void>;
  /** A filter chip was chosen. */
  setFilter(id: string): void | Promise<void>;
  /** The grid/list toggle was pressed (STC-429). */
  setView(mode: "grid" | "list"): void | Promise<void>;
  /**
   * Put a picture in this tile.
   *
   * Called only for items whose thumbnail the adapter said exists or can be
   * made; the view neither knows nor asks which kinds those are. Failure is
   * the caller's to swallow — a thumbnail that cannot be drawn must cost the
   * tile its picture and nothing else.
   */
  paintThumbnail(item: LibraryItem, img: HTMLImageElement): void | Promise<void>;
}

/**
 * Tiles are painted when they scroll into view, never all at once.
 *
 * The acceptance criterion is *"a library containing 500 mixed takes scrolls at
 * 60 fps with decorated thumbnails cached"*, and painting on render would mean
 * 500 IPC reads and — for anything not yet cached — 500 full-size decodes and
 * decoration passes before the first frame. `loading="lazy"` does not help,
 * because the work here is not fetching an `<img src>`; it is producing the
 * picture in the first place.
 *
 * One observer per render pass, disconnected by the next one, so a tile that
 * has scrolled away with work still queued cannot paint into a grid that no
 * longer contains it.
 */
let painting: IntersectionObserver | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function filterBar(list: LibraryList, cb: LibraryCallbacks): HTMLElement {
  const bar = el("div", "libfilters");
  for (const f of list.filters) {
    const chip = el("button", "chip", f.label);
    // `aria-pressed` rather than a class alone: the chips are a single-choice
    // control and a screen reader has no other way to learn which one is on.
    chip.setAttribute("aria-pressed", String(f.id === list.filter));
    if (f.id === list.filter) chip.classList.add("on");
    chip.dataset.filter = f.id;
    chip.addEventListener("click", () => void cb.setFilter(f.id));
    bar.append(chip);
  }
  return bar;
}

/** The grid/list layout switch (STC-429), drawn beside the filter chips. */
function viewSwitch(view: "grid" | "list", cb: LibraryCallbacks): HTMLElement {
  const box = el("div", "libviewtoggle");
  for (const mode of ["grid", "list"] as const) {
    const btn = el("button", undefined, mode === "grid" ? "Grid" : "List");
    btn.setAttribute("aria-pressed", String(mode === view));
    if (mode === view) btn.classList.add("on");
    btn.addEventListener("click", () => { if (mode !== view) void cb.setView(mode); });
    box.append(btn);
  }
  return box;
}

/**
 * If this item can be opened, make its thumbnail a second door to the same
 * action (STC-429) — a large, obvious click target beside the explicit
 * button, the same affordance a photo grid already trains people to expect.
 * Driven entirely by whether an "open" action exists on THIS item, never by
 * kind, so a loose file that withholds "open" gets no click handler either.
 */
function wireOpenOnThumb(box: HTMLElement, item: LibraryItem, cb: LibraryCallbacks): void {
  const open = item.actions.find((a) => a.id === "open");
  if (!open) return;
  box.classList.add("clickable");
  box.setAttribute("role", "button");
  box.tabIndex = 0;
  box.setAttribute("aria-label", `${open.label} ${item.label ?? item.id}`);
  const fire = () => void cb.act("open", item);
  box.addEventListener("click", fire);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
  });
}

/**
 * The picture, or the space where one would be.
 *
 * A tile whose thumbnail has not arrived keeps its box at the same size, so
 * the grid does not reflow as pictures land — 500 tiles reflowing one at a
 * time is the jank the ticket's 60 fps criterion is about, and it costs
 * nothing to avoid by reserving the space up front.
 */
function thumb(item: LibraryItem, cb: LibraryCallbacks): HTMLElement {
  const box = el("div", "libthumb");
  if (item.thumbnail.source === "none") {
    box.classList.add("empty");
    // A duration is a fact about the FILE, not about having a picture of it —
    // shown here (STC-429) so a recording's placeholder box says more than
    // "no thumbnail yet" without needing a poster frame to do it.
    if (item.durationLabel) box.append(el("span", "libdur", item.durationLabel));
    wireOpenOnThumb(box, item, cb);
    return box;
  }
  const img = el("img");
  img.alt = "";
  img.decoding = "async";
  box.append(img);
  // Deferred until the tile is actually on screen — see `painting`.
  painting?.observe(box);
  box.dataset.paint = "pending";
  paintQueue.set(box, () => Promise.resolve(cb.paintThumbnail(item, img)).catch((e) => {
    box.classList.add("empty");
    box.dataset.paint = "failed";
    img.remove();
    // Reported, not swallowed. A tile that cannot draw costs its picture and
    // nothing else — that part is deliberate — but the FAILURE being silent
    // meant a CI run where no thumbnail was ever written looked exactly like
    // one where the tile was simply never scrolled into view, and those are
    // different bugs. CLAUDE.md's own rule: a diagnostic that lies is worse
    // than one that admits ignorance.
    console.error(`[library] could not draw a thumbnail for ${item.id}:`, e);
  }));
  wireOpenOnThumb(box, item, cb);
  return box;
}

/** What each pending tile should do once it is visible. Cleared with the observer. */
const paintQueue = new WeakMap<HTMLElement, () => Promise<void>>();

/**
 * How many tiles paint without waiting to be seen.
 *
 * Laziness must not be load-bearing. `IntersectionObserver` never firing was
 * the CI failure this exists for — the grid drew, the badges were right, and
 * no thumbnail was ever rendered, three tests waiting out twenty-second polls
 * for a `thumb.png` that could not arrive.
 *
 * The first attempt at a fix was a timer that painted any pending tile whose
 * box intersected the viewport, and it was still a heuristic: it sampled
 * geometry ONCE, so a tile whose layout had not settled at that instant was
 * skipped forever. It fixed one of the three failures, which is exactly what a
 * partial heuristic looks like.
 *
 * This does not measure anything. The first screenful of tiles is painted
 * outright — no timer, no geometry, no observer — and the observer handles the
 * rest. Deterministic by construction, and the cost at 500 takes is painting
 * two dozen thumbnails nobody scrolled to, which is the whole point of the
 * deferral preserved.
 */
const EAGER_TILES = 24;

/** Paint one pending tile, exactly once. */
function paintNow(box: HTMLElement): void {
  const run = paintQueue.get(box);
  if (!run) return;
  paintQueue.delete(box);
  box.dataset.paint = "done";
  void run();
}

function titleFor(item: LibraryItem): HTMLElement {
  const title = el("div", "libtitle");
  // Show the label when there is one, but keep the timestamp visible: it is
  // how the take is identified on disk and in every path the app hands out.
  title.textContent = item.label ? item.label : item.id;
  // A tooltip fallback, not a decision (STC-413): the bundle path when there
  // is one, else the finished file's. Widening `LibraryItem.dir` to optional
  // is what forces this line to change at all.
  title.title = item.dir ?? item.file ?? "";
  if (item.label) title.append(el("span", "stamp", ` ${item.id}`));
  return title;
}

function renameInto(title: HTMLElement, item: LibraryItem, cb: LibraryCallbacks): void {
  const input = el("input", "labelinput");
  input.type = "text";
  input.value = item.label ?? "";
  input.placeholder = "Name this take";
  input.maxLength = 120;
  let done = false;
  const commit = () => {
    if (done) return;                 // blur fires again after Enter replaces it
    done = true;
    const v = input.value.trim();
    input.replaceWith(title);
    if (v && v !== item.label) void cb.rename(item, v);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; input.replaceWith(title); }
  });
  input.addEventListener("blur", commit);
  title.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * Which visual weight an action gets, by id alone (STC-429) — never by kind.
 * "open"/"share" are the primary pair (the app's existing bold-border-plus-
 * soft-hover idiom, the same one Record/Shot already use); "delete" keeps its
 * own de-emphasised treatment; everything else (rename/reveal/duplicate) is
 * the quiet tertiary group. All in ONE row, never a collapsed menu — several
 * tests click an action by `data-action` directly, which a closed overflow
 * menu would break.
 */
function actionClass(id: LibraryActionId): string {
  if (id === "delete") return "delete";
  if (id === "open" || id === "share") return "primary";
  return "tertiary";
}

function tile(item: LibraryItem, cb: LibraryCallbacks, view: "grid" | "list"): HTMLElement {
  const card = el("div", view === "list" ? "librow" : "libtile");
  card.dataset.id = item.id;
  // The badge is TEXT, so the tile is drawn the same way whatever it holds.
  // A class derived from it lets CSS colour the two apart without this file
  // knowing there are two.
  const badge = el("span", "libbadge", item.badge);
  badge.dataset.badge = item.badge;
  const badgeRow = el("div", "libbadgerow");
  badgeRow.append(badge);
  // Stubbed data (STC-429): `edited` is always false today, so this never
  // fires yet — the markup exists so real tracking has somewhere to land.
  if (item.edited) {
    const tag = el("span", "libedited");
    tag.append(el("span", "dot"), document.createTextNode("Edited"));
    badgeRow.append(tag);
  }

  const title = titleFor(item);
  // A second door to rename, alongside the button (STC-429) — Finder's own
  // gesture. The button stays, both for discoverability and because it is
  // what several existing tests drive directly.
  if (item.actions.some((a) => a.id === "rename")) {
    title.addEventListener("dblclick", () => renameInto(title, item, cb));
  }
  const body = el("div", "libbody");
  body.append(badgeRow, title, el("div", "meta", item.summary));
  for (const note of item.notes) body.append(el("div", "meta", note));

  const actions = el("div", "libactions");
  for (const a of item.actions) {
    const btn = el("button", actionClass(a.id), a.label);
    btn.dataset.action = a.id;
    btn.addEventListener("click", () => {
      // Rename is the one action the VIEW owns, because it is an edit in
      // place: everything else is a message to the main process.
      if (a.id === "rename") renameInto(title, item, cb);
      else void cb.act(a.id, item);
    });
    actions.append(btn);
  }

  card.append(thumb(item, cb), body, actions);
  return card;
}

/**
 * Draw the whole library into `host`, replacing whatever was there.
 *
 * Broken takes are shown, not hidden: a take that silently disappears from the
 * list is indistinguishable from one that was deleted. They sit below the grid
 * and outside the filter, because a directory that could not be read has no
 * kind to be filtered by — the one place "which kind is this?" genuinely has
 * no answer, and the view handles it by not asking.
 */
export function renderLibrary(host: HTMLElement, list: LibraryList,
                              cb: LibraryCallbacks, view: "grid" | "list" = "grid"): void {
  painting?.disconnect();
  // `rootMargin` paints a screenful ahead, so a tile is ready by the time it
  // arrives rather than popping in after it. IntersectionObserver is absent
  // under some test runners; falling back to painting immediately keeps the
  // pictures correct and only gives up the laziness.
  painting = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const box = e.target as HTMLElement;
          obs.unobserve(box);
          paintNow(box);
        }
      }, { rootMargin: "200px" })
    : undefined;

  host.textContent = "";
  const header = el("div", "libheader");
  header.append(filterBar(list, cb), viewSwitch(view, cb));
  host.append(header);

  if (!list.items.length && !list.invalid.length) {
    const empty = el("div", "libempty", list.filter === "all"
      ? "Nothing here yet."
      : "Nothing of this kind yet.");
    empty.id = "empty";
    host.append(empty);
    return;
  }

  // `view === "grid"` keeps the original `#libgrid`/`.libtile` shape byte for
  // byte — several tests locate a tile that way — and "list" is new ground
  // with no such constraint.
  const container = el("div", view === "list" ? "liblist" : "libgrid");
  container.id = view === "list" ? "liblist" : "libgrid";
  for (const item of list.items) container.append(tile(item, cb, view));
  host.append(container);

  // The first screenful, unconditionally — see EAGER_TILES. With no observer at
  // all in this environment, everything, rather than leaving tiles blank
  // forever.
  const boxes = [...container.querySelectorAll<HTMLElement>(".libthumb")];
  for (const box of painting ? boxes.slice(0, EAGER_TILES) : boxes) paintNow(box);

  for (const b of list.invalid) {
    host.append(el("div", "broken", `${b.name} — ${b.reason}`));
  }
}
