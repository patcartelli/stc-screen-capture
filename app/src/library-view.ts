import type {
  LibraryAction, LibraryActionId, LibraryItem, LibraryList, LibraryPlaceholder, PlaceholderAction,
} from "./library-items.js";
import { capturedLabel } from "./library-items.js";

/**
 * The library's grid and list. Draws what the adapter hands it and decides
 * nothing (STC-294).
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
 * ## What it therefore may not do
 *
 * No "if this is a still". The type word is text the adapter wrote, the
 * readout and the columns are strings it composed, the actions are a list it
 * chose and placed, and the filter chips are data it supplied. When something
 * here needs a fact this module cannot see, the instruction from the ticket is
 * to widen `LibraryItem` deliberately — never to reach for the kind at the
 * call site.
 *
 * ## STC-584 — one visible action
 *
 * Built to Capture SK 016's "Library" and "Library / List" frames. Each item
 * draws its actions by PLACE (`LibraryAction.place`): the `tile` action is a
 * click anywhere on the tile or row, the `primary` one is the only visible
 * button (Share), and the `menu` ones live behind the overflow button. Delete
 * is red and set apart by a divider, keyed off its id alone, never a kind.
 *
 * Grid and list share every builder (thumbnail, title, alerts, actions); only
 * the arrangement differs, so there is still no second card builder.
 *
 * The title bar's controls (count, Grid/List, the kind filter, search, the
 * gear) live in `index.html` and are filled by `renderControls`: the search
 * box must survive a redraw, or typing into it would lose focus at every key.
 */

/** Everything the view needs done for it. Each is the shared UI's one door. */
export interface LibraryCallbacks {
  /** An action was chosen. Dispatched by action id — never by kind. */
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

/**
 * A segmented control (STC-584): the frames draw the view toggle and the
 * kind filter the same way, a tinted track with the chosen segment lifted.
 *
 * A radio group (STC-587, as Settings' segmented controls are): one Tab stop,
 * on the chosen segment, and the arrow keys, Home and End move AND choose, as
 * native radios do. Choosing is the button's own click, so the keyboard and
 * the pointer take one path.
 */
function segmented<T extends string>(
  className: string, name: string, options: readonly { id: T; label: string }[], on: string,
  pick: (id: T) => void, dataKey: string, repick = false,
): HTMLElement {
  const box = el("div", `libseg ${className}`);
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", name);
  const chosen = options.some((o) => o.id === on) ? on : options[0]?.id;
  for (const o of options) {
    const b = el("button", undefined, o.label);
    b.type = "button";
    b.dataset[dataKey] = o.id;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(o.id === on));
    b.tabIndex = o.id === chosen ? 0 : -1;
    if (o.id === on) b.classList.add("on");
    b.addEventListener("click", () => { if (repick || o.id !== on) pick(o.id); });
    box.append(b);
  }
  box.addEventListener("keydown", (e) => {
    const buttons = [...box.querySelectorAll<HTMLButtonElement>("button")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % buttons.length
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + buttons.length) % buttons.length
        : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
    const to = buttons[next];
    if (!to || to === buttons[i]) return;
    e.preventDefault();
    to.focus();
    to.click();
  });
  return box;
}

const VIEWS = [{ id: "grid", label: "Grid" }, { id: "list", label: "List" }] as const;

/**
 * The title bar's Grid/List toggle and kind filter, redrawn into `host` on
 * every render. A folder that cannot be read has no kinds to filter and no
 * layout to choose, so its controls would be decoration over a lost library.
 */
export function renderControls(host: HTMLElement, list: LibraryList, view: "grid" | "list",
                               cb: LibraryCallbacks, folderLost: boolean): void {
  // Every pick redraws these controls, so a keyboard pick would drop the
  // focus to the page each time (STC-587). Whichever group had it gets it
  // back, on its chosen segment.
  const had = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".libseg");
  const group = had && host.contains(had) ? [...had.classList].find((c) => c !== "libseg") : undefined;
  host.textContent = "";
  if (folderLost) return;
  host.append(
    segmented("libviewtoggle", "View", VIEWS, view, (m) => void cb.setView(m), "view"),
    // The chosen filter re-lists when pressed again: the library has no
    // refresh control, and pressing "All" is the one a person reaches for.
    segmented("libfilters", "Show", list.filters, list.filter, (f) => void cb.setFilter(f), "filter", true),
  );
  if (group) host.querySelector<HTMLButtonElement>(`.${group} button[tabindex="0"]`)?.focus();
}

/**
 * A library with nothing to draw (STC-521): the sentence, the folder it is
 * about, and whatever the user can do. Wording is `placeholderFor`'s; this
 * only lays it out. `#empty` stays the id the existing tests look for.
 */
function placeholderCard(p: LibraryPlaceholder, act: (a: PlaceholderAction) => void): HTMLElement {
  const card = el("div", "libplaceholder");
  card.id = p.state === "empty" || p.state === "filtered" ? "empty" : "libstate";
  card.dataset.state = p.state;
  // Only a problem interrupts a screen reader; loading and empty are polite.
  card.setAttribute("role", p.state === "missing" || p.state === "unreadable" ? "alert" : "status");
  if (p.state === "loading") card.append(el("div", "libspinner"));
  card.append(el("div", "libplacetitle", p.title), el("div", "libplacebody", p.body));
  if (p.path) card.append(el("code", "libplacepath", p.path));
  if (p.actions.length) {
    const row = el("div", "libplaceactions");
    for (const a of p.actions) {
      const b = el("button", a === "choose-folder" ? "primary" : "", PLACEHOLDER_LABELS[a]);
      b.dataset.placeholder = a;
      b.addEventListener("click", () => act(a));
      row.append(b);
    }
    card.append(row);
  }
  return card;
}

const PLACEHOLDER_LABELS: Record<PlaceholderAction, string> = {
  "retry": "Try again",
  "choose-folder": "Choose folder…",
};

/** Just a placeholder, before there is any list to draw around it. */
export function renderPlaceholderOnly(host: HTMLElement, p: LibraryPlaceholder): void {
  closeOverflow();
  host.textContent = "";
  host.setAttribute("aria-busy", String(p.state === "loading"));
  host.append(placeholderCard(p, () => {}));
}

/**
 * The library is catching up (STC-521): the grid on screen is stale, so say
 * so without taking it away. Shown only by the caller's delay, never here.
 */
export function showUpdating(host: HTMLElement, text: string): void {
  host.setAttribute("aria-busy", "true");
  if (host.querySelector(".libupdating")) return;
  const note = el("div", "libupdating", text);
  note.setAttribute("role", "status");
  host.prepend(note);
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
  // The label when there is one, else the timestamped name the take is found
  // by on disk. The full id is the tooltip either way, with the path.
  title.textContent = item.label ? item.label : item.id;
  // A tooltip fallback, not a decision (STC-413): the bundle path when there
  // is one, else the finished file's.
  title.title = item.label ? `${item.id}\n${item.dir ?? item.file ?? ""}` : item.dir ?? item.file ?? "";
  return title;
}

function renameInto(title: HTMLElement, item: LibraryItem, cb: LibraryCallbacks,
                    back?: HTMLElement): void {
  const input = el("input", "labelinput");
  input.type = "text";
  input.value = item.label ?? "";
  input.placeholder = "Name this capture";
  input.maxLength = 120;
  let done = false;
  // The item's •••, looked up in the page as it is NOW (STC-595): the one
  // held from when the rename started is gone if the list redrew meanwhile,
  // and focusing a detached button leaves the focus nowhere (on the Mac,
  // Escape then left Tab starting from the name, before Share).
  const backNow = (): HTMLElement | undefined => (back?.isConnected ? back : undefined)
    ?? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(item.id)}"] .libmore`) ?? undefined;
  const commit = (refocus: boolean) => {
    if (done) return;                 // blur fires again after Enter replaces it
    done = true;
    const v = input.value.trim();
    input.replaceWith(title);
    // From the keyboard, back where the rename was asked for (STC-587), not
    // on the page. A blur commit leaves the focus wherever it went.
    if (refocus) backNow()?.focus();
    if (v && v !== item.label) void cb.rename(item, v);
  };
  // A key or a click in the field is the field's, not the tile's Open.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // The key ends here: focus has moved on to More by the time Enter would
    // activate something, and it would reopen the menu.
    if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
    if (e.key === "Enter") commit(true);
    if (e.key === "Escape") { done = true; input.replaceWith(title); backNow()?.focus(); }
  });
  input.addEventListener("blur", () => commit(false));
  title.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * The amber badges (STC-529, STC-584): "Stopped early"'s short cause, "No mic
 * signal". The full sentence is the hover text, so a badge never has to be
 * long enough to explain itself.
 */
function alerts(item: LibraryItem): HTMLElement | undefined {
  if (!item.alerts.length) return undefined;
  const box = el("div", "libalerts");
  for (const a of item.alerts) {
    const badge = el("span", "libalert", a.label);
    badge.title = a.detail;
    box.append(badge);
  }
  return box;
}

// ── the overflow menu ─────────────────────────────────────────────────────

/** The one overflow menu on screen, and the button that opened it. */
let openMenu: { menu: HTMLElement; trigger: HTMLButtonElement } | undefined;

/** Close the overflow menu, if one is open. Safe to call at any time. */
export function closeOverflow(focusTrigger = false): void {
  if (!openMenu) return;
  const { menu, trigger } = openMenu;
  openMenu = undefined;
  menu.remove();
  trigger.setAttribute("aria-expanded", "false");
  trigger.classList.remove("on");
  if (focusTrigger) trigger.focus();
}

/**
 * Open `actions` as a menu under `trigger` (Capture SK 016's "Overflow
 * menu"): one at a time, below the trigger's right edge, or above it when the
 * window's bottom is too close. Closed by a pick, Escape, a press outside it,
 * a scroll, or the window losing focus (`installOverflowDismissal`).
 */
function openOverflow(trigger: HTMLButtonElement, actions: LibraryAction[],
                      choose: (a: LibraryAction) => void): void {
  const wasThis = openMenu?.trigger === trigger;
  closeOverflow();
  if (wasThis) return;
  const menu = el("div", "liboverflow-menu");
  menu.setAttribute("role", "menu");
  for (const a of actions) {
    // The divider sets Delete apart: by its id, never by a kind.
    if (a.id === "delete" && menu.childElementCount) menu.append(el("div", "libmenu-divider"));
    const b = el("button", a.id === "delete" ? "delete" : undefined, a.label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.dataset.action = a.id;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      // The focus goes back to ••• BEFORE the action runs (STC-595). Removing
      // the menu while its row had the focus dropped it to the page, so a
      // Delete's confirm sheet came back to nothing and the redraw after it
      // had no item to keep the focus on (the ring landed on the title bar).
      closeOverflow(true);
      choose(a);
    });
    menu.append(b);
  }
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeOverflow(true); }
    // Tab closes the menu too, with the focus back on the button that
    // opened it, rather than walking out of a menu left open behind it.
    else if (e.key === "Tab") { e.preventDefault(); closeOverflow(true); }
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(menu);
  const r = trigger.getBoundingClientRect();
  const h = menu.offsetHeight;
  const below = r.bottom + 6 + h <= window.innerHeight - 8;
  menu.style.top = `${Math.max(8, below ? r.bottom + 6 : r.top - 6 - h)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("on");
  openMenu = { menu, trigger };
  menu.querySelector<HTMLButtonElement>("button")?.focus();
}

/** The document-level ways an overflow menu closes. Installed once. */
export function installOverflowDismissal(scroller: HTMLElement): void {
  document.addEventListener("pointerdown", (e) => {
    if (openMenu && !openMenu.menu.contains(e.target as Node) && e.target !== openMenu.trigger) closeOverflow();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOverflow(true); });
  scroller.addEventListener("scroll", () => closeOverflow(), { passive: true });
  window.addEventListener("blur", () => closeOverflow());
}

/**
 * The visible action (Share) and the overflow button, as the frames draw them
 * at a tile's or a row's trailing edge. A press on either is the button's,
 * never the tile's Open.
 */
function actionButtons(item: LibraryItem, title: () => HTMLElement, cb: LibraryCallbacks): HTMLElement {
  const box = el("div", "libactions");
  const run = (a: LibraryAction) => {
    // Rename is the one action the VIEW owns, because it is an edit in
    // place: everything else is a message to the main process.
    if (a.id === "rename") renameInto(title(), item, cb, box.querySelector<HTMLElement>(".libmore") ?? undefined);
    else void cb.act(a.id, item);
  };
  for (const a of item.actions.filter((x) => x.place === "primary")) {
    const b = el("button", "libshare", a.label);
    b.type = "button";
    b.dataset.action = a.id;
    // "primary", not the action's id: a recording's Share and a shot's are
    // different actions in the same place, and the arrow keys (STC-595) and
    // a redraw keep the focus by place.
    b.dataset.focus = "primary";
    b.addEventListener("click", (e) => { e.stopPropagation(); run(a); });
    box.append(b);
  }
  const menu = item.actions.filter((x) => x.place === "menu");
  if (menu.length) {
    const more = el("button", "libmore");
    more.type = "button";
    more.setAttribute("aria-label", `More for ${item.label ?? item.id}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.title = "More";
    more.dataset.focus = "more";
    more.append(el("span", undefined, "•••"));
    more.addEventListener("click", (e) => { e.stopPropagation(); openOverflow(more, menu, run); });
    box.append(more);
  }
  return box;
}

/**
 * Make the whole tile or row its `tile` action's door (STC-584): a click
 * anywhere on it, and Enter or Space on its focusable thumbnail. Driven by
 * whether THIS item has a tile action, never by kind, so a loose file that
 * has none is not clickable at all.
 */
function wireTile(card: HTMLElement, focusable: HTMLElement, item: LibraryItem, cb: LibraryCallbacks): void {
  const open = item.actions.find((a) => a.place === "tile");
  if (!open) return;
  card.classList.add("clickable");
  focusable.setAttribute("role", "button");
  focusable.tabIndex = 0;
  focusable.dataset.focus = "open";
  focusable.setAttribute("aria-label", `${open.label} ${item.label ?? item.id}`);
  card.dataset.open = open.id;
  const fire = () => void cb.act(open.id, item);
  card.addEventListener("click", fire);
  focusable.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
  });
}

/** One grid tile: the thumbnail with its chip and badges, then name, readout and actions. */
function tile(item: LibraryItem, cb: LibraryCallbacks): HTMLElement {
  const card = el("div", "libtile");
  card.dataset.id = item.id;
  card.dataset.type = item.badge;
  if (item.notes.length) card.title = item.notes.join("\n");
  const pic = thumb(item, cb);
  if (item.chip) pic.append(el("span", "libchip", item.chip));
  const badges = alerts(item);
  if (badges) pic.append(badges);

  const title = titleFor(item);
  const text = el("div", "libtext");
  text.append(title, el("div", "libreadout", item.readout));
  const meta = el("div", "libmeta");
  meta.append(text, actionButtons(item, () => title, cb));
  card.append(pic, meta);
  wireTile(card, pic, item, cb);
  return card;
}

/** The list's column header (Capture SK 016, "Library / List"). */
function listHeader(): HTMLElement {
  const head = el("div", "librow libhead");
  head.setAttribute("aria-hidden", "true");
  head.append(el("span", "col-name", "Name"), el("span", "col-type", "Type"),
              el("span", "col-length", "Length"), el("span", "col-size", "Size"),
              el("span", "col-file", "File"), el("span", "col-captured", "Captured"),
              el("span", "col-actions"));
  return head;
}

/** One list row: thumbnail and name (with badges under it), the columns, the actions. */
function row(item: LibraryItem, cb: LibraryCallbacks, now: number): HTMLElement {
  const card = el("div", "librow");
  card.dataset.id = item.id;
  card.dataset.type = item.badge;
  if (item.notes.length) card.title = item.notes.join("\n");
  const pic = thumb(item, cb);
  const title = titleFor(item);
  const text = el("div", "libtext");
  text.append(title);
  const badges = alerts(item);
  if (badges) text.append(badges);
  const name = el("div", "col-name");
  name.append(pic, text);
  const c = item.columns;
  card.append(name, el("span", "col-type", c.type), el("span", "col-length", c.length),
              el("span", "col-size", c.size), el("span", "col-file", c.file),
              el("span", "col-captured", capturedLabel(item.createdAt, now)));
  const actions = actionButtons(item, () => title, cb);
  actions.classList.add("col-actions");
  card.append(actions);
  wireTile(card, pic, item, cb);
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
                              cb: LibraryCallbacks, view: "grid" | "list" = "grid",
                              placeholder: LibraryPlaceholder | null = null,
                              onPlaceholderAction: (a: PlaceholderAction) => void = () => {},
                              now: number = Date.now()): void {
  const keep = focusAnchor(host);
  closeOverflow();
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
  host.removeAttribute("aria-busy");
  host.dataset.view = view;

  if (placeholder) {
    host.append(placeholderCard(placeholder, onPlaceholderAction));
    return;
  }

  // `#libgrid`/`.libtile` and `#liblist`/`.librow` are the shapes the tests
  // locate an item by.
  const container = el("div", view === "list" ? "liblist" : "libgrid");
  container.id = view === "list" ? "liblist" : "libgrid";
  if (view === "list") container.append(listHeader());
  for (const item of list.items) container.append(view === "list" ? row(item, cb, now) : tile(item, cb));
  container.addEventListener("keydown", (e) => arrowBetweenItems(e, container, view));
  host.append(container);

  // The first screenful, unconditionally — see EAGER_TILES. With no observer at
  // all in this environment, everything, rather than leaving tiles blank
  // forever.
  const boxes = [...container.querySelectorAll<HTMLElement>(".libthumb")];
  for (const box of painting ? boxes.slice(0, EAGER_TILES) : boxes) paintNow(box);

  for (const b of list.invalid) {
    host.append(el("div", "broken", `${b.name} — ${b.reason}`));
  }
  if (keep) restoreFocus(container, keep);
}

/**
 * The arrow keys move between items (STC-595, Patrick 2026-10-28), on top of
 * Tab, which still walks every control. In the list ↑/↓ go to the item above
 * or below; in the grid ←/→ go to the previous or next item and ↑/↓ to the
 * one a row away, the row being however many columns the window fits now.
 * The focus lands on the same control of the new item (its picture, Share or
 * •••), or its first when it has no such control. At either end nothing
 * happens: no wrap, so holding a key stops at the last item.
 */
function arrowBetweenItems(e: KeyboardEvent, container: HTMLElement, view: "grid" | "list"): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const from = e.target as HTMLElement;
  const part = from.closest<HTMLElement>("[data-focus]")?.dataset.focus;
  const card = from.closest<HTMLElement>("[data-id]");
  if (!part || !card) return;                       // not on an item's control (the rename field stops its own keys)
  const cards = [...container.querySelectorAll<HTMLElement>("[data-id]")];
  const at = cards.indexOf(card);
  const columns = view === "list" ? 1 : cards.filter((c) => c.offsetTop === cards[0]!.offsetTop).length;
  const step = view === "list"
    ? { ArrowUp: -1, ArrowDown: 1 }[e.key]
    : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key];
  if (step === undefined) return;
  e.preventDefault();                               // the arrows would scroll the window otherwise
  const next = cards[at + step];
  if (!next) return;
  (next.querySelector<HTMLElement>(`[data-focus="${part}"]`) ?? next.querySelector<HTMLElement>("[data-focus]"))?.focus();
}

/**
 * Which item's control had the keyboard before a redraw (STC-587), and where
 * it sat. Every refresh (a rename, a delete, a filter, Show in Finder's
 * return) rebuilds every tile, and without this the focus fell to the page.
 */
interface FocusAnchor { id: string; part: string; index: number }

function focusAnchor(host: HTMLElement): FocusAnchor | undefined {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !host.contains(active)) return undefined;
  const card = active.closest<HTMLElement>("[data-id]");
  const part = active.closest<HTMLElement>("[data-focus]")?.dataset.focus;
  if (!card?.dataset.id || !part) return undefined;
  const cards = [...host.querySelectorAll<HTMLElement>("[data-id]")];
  return { id: card.dataset.id, part, index: cards.indexOf(card) };
}

/**
 * The same control on the same item, or, when the item has gone (a delete,
 * a filter that drops it), the one now in its place: the next, else the last.
 */
function restoreFocus(container: HTMLElement, keep: FocusAnchor): void {
  const cards = [...container.querySelectorAll<HTMLElement>("[data-id]")];
  const same = cards.find((c) => c.dataset.id === keep.id);
  const card = same ?? cards[Math.min(keep.index, cards.length - 1)];
  if (!card) return;
  const target = (same && card.querySelector<HTMLElement>(`[data-focus="${keep.part}"]`))
    ?? card.querySelector<HTMLElement>("[data-focus]");
  target?.focus();
}
