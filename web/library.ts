import { withFreshIDs } from "./sync/store.ts";
import { Spaces } from "./sync/spaces.ts";
import { storage } from "./sync/idb.ts";
import { Binding } from "./binding.ts";
import { sampleBoard } from "./sample.ts";
import { ask } from "./sheet.ts";
import { chip } from "./presence.ts";
import { floated, liveFields, overlaid } from "./sync/overlay.ts";
import { statusLines } from "./sync/engine.ts";
import { encode } from "./sync/base64.ts";
import { Reporter } from "./diag.ts";
import { thrown } from "./flight.ts";
import { GestureHolds } from "./sync/gesture-holds.ts";
import { Collab } from "./sync/collab.ts";
import { inviteLink, parseInvite, validServer } from "./sync/crypto.ts";
import * as R from "./rules.ts";
import type { App } from "./app.ts";
import type { Person } from "./presence.ts";
import type { Board, Point } from "./types.ts";

type Group = ReturnType<Spaces["groups"]>[number];
type Session = ReturnType<Collab["open"]>;

const MORE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

/** The boards on this device: their groups in IndexedDB, the board list and the open board. */
export class Library {
  static async open(app: App) {
    let spaces: Spaces;
    try {
      spaces = await Spaces.open(storage);
    } catch (error) {
      // saving now could overwrite boards that failed to load
      console.warn("boards not loaded", error);
      spaces = new Spaces(storage, {}, { readOnly: true });
    }
    const lib = new Library(app, spaces);
    const link = location.hash.includes("#join=") ? location.href : null;
    if (link) history.replaceState(null, "", location.pathname + location.search);
    if (spaces.fresh && !link) spaces.local.store.createBoard("Sample", withFreshIDs(sampleBoard()));
    lib.showList();
    if (link) lib.join(link);
    spaces.syncAll();
    return lib;
  }

  app: App;
  spaces: Spaces;
  id: string | null;
  group: Group | null;
  binding: Binding | null;
  session: Session | null;
  menuGroup: Group | null;
  holds: GestureHolds;
  collabs: WeakMap<Group, Collab>;
  restack: (b: Board) => void;
  /** Sends what the app recorded to the open board's space, or else the first space with a server. */
  reporter: Reporter;
  liveDirty?: boolean;
  presenceKey?: string;
  overlaySize?: number;
  frame?: number | null;
  touchTimer?: ReturnType<typeof setTimeout>;

  constructor(app: App, spaces: Spaces) {
    this.app = app;
    this.spaces = spaces;
    this.reporter = new Reporter(async () => {
      const g = this.group?.store.state.server ? this.group : this.spaces.spaces.find((s) => s.store.state.server);
      const state = g?.store.state;
      if (!g || !state?.server || !state.space) return null;
      return { server: state.server, space: state.space, token: encode((await g.engine.keysOf(state)).token) };
    }, () => app.flight.recording());
    this.id = null;
    this.group = null;
    this.binding = null;
    /** The open board's Collab session. */
    this.session = null;
    /** The space whose menu was opened last. */
    this.menuGroup = null;
    this.holds = new GestureHolds();
    this.collabs = new WeakMap();
    app.library = this;
    app.space = this;
    spaces.onChange = (group, boards, remote) => this.changed(group, boards, remote);
    spaces.onStatus = () => {
      this.renderStatus();
      app.ui.updateSync();
    };
    // its sync engines' decisions, with the space they are of, for whoever debugs a sync that never settled
    spaces.onSyncNote = (g, what, data) => app.flight.note("sync", what, { space: g.space ?? "local", ...data });
    // the scenarios settle once nothing waits to be pushed: the status says it only offline
    spaces.onDirty = () => (document.body.dataset.waiting = String(spaces.spaces.reduce((n, g) => n + g.store.pending().length, 0)));
    spaces.onSaveError = (error) => {
      console.warn("boards not saved", error);
      app.flight.note("error", "save failed", thrown(error));
      app.ui.updateSync();
    };
    spaces.flushLocal = () => this.binding?.flush();
    setInterval(() => !document.hidden && spaces.syncAll({ polling: true }), 5000);
    setInterval(() => this.tick(), 1000);
    spaces.onLive = () => this.liveChanged();
    app.onSelect = () => this.updateLive();
    document.addEventListener("visibilitychange", () => this.updateLive());
    document.addEventListener("visibilitychange", () => document.hidden || spaces.retryAll());
    addEventListener("online", () => spaces.retryAll(true));
    const change = app.model.onChange;
    app.model.onChange = () => {
      change();
      this.binding?.changed();
      this.session?.edited();
    };
    app.view.shown = () => (this.live && this.id ? overlaid(app.model.board, this.live.overlay(this.id)) : app.model.board);
    spaces.onRefused = (g, ids) => g === this.group && this.app.refused(ids);
    this.restack = (b: Board) => R.gravity(b, (id) => {
      const c = R.card(b, id);
      return c ? app.view.frontHeight(c.text, c.w) : 0;
    });
    const hide = () => {
      this.binding?.flush();
      spaces.flushAll();
    };
    document.addEventListener("visibilitychange", () => document.hidden && hide());
    addEventListener("pagehide", hide);
    document.querySelector<HTMLElement>('[data-act="boards"]')!.hidden = false;
  }

  /** Saves what is pending and stops saving and syncing, as another tab takes the boards over. */
  handOver() {
    this.app.endEditing();
    this.binding?.flush();
    return this.spaces.stop();
  }

  changed(group: Group, boards: ReadonlySet<string>, remote: boolean) {
    if (this.id && group === this.group && boards.has(this.id)) {
      if (group.store.title(this.id) === null) return this.showList();
      if (remote) this.binding!.pull();
    }
    if (!this.id) this.renderList();
    this.app.ui.updateSync();
  }

  open(id: string) {
    this.binding?.flush();
    this.binding = null;
    this.session?.close();
    this.session = null;
    const group = this.spaces.groupOf(id);
    if (!group) return this.showList();
    this.id = id;
    this.group = group;
    const b = group.store.board(id);
    this.restack(b);
    document.body.dataset.screen = "board";
    this.app.load(b);
    this.binding = new Binding(group.store, this.app.model, id, this.restack);
    this.binding.typing = () => this.app.state.editing !== null;
    const s = this.app.state;
    this.session = this.collab(group).open(id, this.app.model, this.binding, {
      caret: () => this.app.caret(),
      items: (start, board, mine, id) => floated(liveFields(start, board, mine, id), board, new Set([...s.held].filter((x) => mine.has(x))), s.float),
    });
    this.app.ui.updateSync();
    group.engine.sync();
    this.updateLive();
    this.showPresence(true);
  }

  showList() {
    this.app.endEditing();
    this.binding?.flush();
    this.binding = null;
    this.session?.close();
    this.session = null;
    this.id = null;
    this.group = null;
    document.body.dataset.screen = "boards";
    this.renderList();
    this.app.ui.updateSync();
    this.updateLive();
    this.showPresence(true);
  }

  /** A section per group; On this device only when it has boards or the device is in no space. */
  renderList() {
    const { spaces } = this;
    const shown = spaces.groups().filter((g) => g.space || !spaces.spaces.length || g.store.boards().length);
    document.querySelector(".boards-groups")!.replaceChildren(...shown.map((g) => this.renderGroup(g)));
    this.renderStatus();
    this.renderPeople();
  }

  renderGroup(g: Group) {
    const section = document.createElement("section");
    section.className = "boards-group";
    section.dataset.group = g.key;
    const header = document.createElement("header");
    const titles = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = g.name;
    const status = document.createElement("p");
    status.className = "status";
    titles.append(h2, status);
    header.append(titles);
    if (g.space) {
      const more = document.createElement("button");
      more.className = "edit";
      more.setAttribute("aria-label", `${g.name} options`);
      more.innerHTML = MORE;
      more.addEventListener("pointerdown", () => this.pointMenu(more, g));
      this.app.ui.menus.attach(more, document.querySelector<HTMLElement>(".menu.space")!);
      header.append(more);
    }
    const ul = document.createElement("ul");
    ul.className = "boards-list";
    for (const { id, title } of g.store.boards()) ul.append(this.renderBoard(id, title));
    const li = document.createElement("li");
    const add = document.createElement("button");
    add.className = "new strong";
    add.textContent = "New Board";
    add.addEventListener("click", () => this.newBoard(g));
    li.append(add);
    ul.append(li);
    section.append(header, ul);
    return section;
  }

  renderBoard(id: string, title: string) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.className = "open";
    open.textContent = title || "Untitled";
    open.addEventListener("click", () => this.open(id));
    const edit = document.createElement("button");
    edit.className = "edit";
    edit.setAttribute("aria-label", `Rename, move or delete ${title || "Untitled"}`);
    edit.innerHTML = MORE;
    edit.addEventListener("click", () => this.edit(id));
    li.dataset.board = id;
    const people = document.createElement("span");
    people.className = "people";
    li.append(open, people, edit);
    return li;
  }

  /** The live layer of the open board's space, if it has one. */
  get live() {
    return this.group?.live ?? null;
  }

  /** Connects each space's live layer while the app shows it, its board or the list, and says what is open. */
  updateLive() {
    for (const g of this.spaces.spaces) {
      if (!g.live) continue;
      if (!document.hidden && (!this.id || this.group === g)) g.live.connect();
      else g.live.close();
      const here = this.group === g;
      const board = here ? this.id : null;
      g.live.setPresence({ board, boards: board ? [board] : [], selection: here ? [...this.app.state.selection].sort() : [] });
    }
  }

  /** A live layer changed: its effects follow at the next frame, however many messages came meanwhile. */
  liveChanged() {
    this.liveDirty = true;
    this.animate();
  }

  /** Others on the open board: what they hold and have selected, their cursors, and their initials. The board draws
   * again only when what they hold or have selected changed, or while they edit it; `force` after it was opened. In a
   * frame already (`inFrame`), it draws in that frame rather than the next. */
  showPresence(force = false, inFrame = false) {
    const { live, id } = this;
    const s = this.app.state;
    const taken = new Map<string, Person>(), seen = new Map<string, string>();
    if (live && id) {
      for (const [item, p] of live.selections(id)) seen.set(item, p.colour);
      for (const item of live.taken()) taken.set(item, live.holderOf(item)!);
    }
    const key = JSON.stringify([[...seen], [...taken].map(([item, p]) => [item, p.device, p.name])]);
    const overlay = live && id ? live.overlay(id).size : 0;
    if (force || key !== this.presenceKey || overlay || this.overlaySize) {
      this.presenceKey = key;
      [s.taken, s.seen] = [taken, seen];
      if ([...s.selection].some((x) => s.taken.has(x))) this.app.select(s.selection);
      if (inFrame) this.app.view.render();
      else this.app.view.invalidate();
    }
    this.overlaySize = overlay;
    this.app.presence.show({ cursors: live && id ? live.cursors(id) : [], carets: live && id ? live.carets(id) : [], people: live && id ? live.people(id) : [] });
  }

  /** At most once a frame: what changed in the live layers, and others' cursors and live edits while they still play
   * back. */
  animate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.liveDirty) {
        this.liveDirty = false;
        this.updateLive();
        this.app.ui.updateSync();
        if (!this.id) this.renderPeople();
      }
      if (!this.live || !this.id) return;
      this.showPresence(false, true);
      if (this.live.animating(this.id)) this.animate();
    });
  }

  /** Asks the open board's space to hold `ids` for the gesture starting. */
  hold(ids: Iterable<string>) {
    this.session?.hold(ids);
  }

  edited() {
    this.session?.edited();
  }

  /** `g`'s Collab, made on first use. */
  collab(g: Group) {
    if (!this.collabs.has(g)) this.collabs.set(g, new Collab(g, this.holds));
    return this.collabs.get(g)!;
  }

  /** About once a second, each space's Collab tick. */
  tick() {
    for (const g of this.spaces.spaces) this.collab(g).tick();
  }

  /** Each board row's initials of whoever is on it, in place, and only where they changed. */
  renderPeople() {
    for (const g of this.spaces.spaces) {
      for (const { id } of g.store.boards()) {
        const span = document.querySelector<HTMLElement>(`.boards-list li[data-board="${id}"] .people`);
        const people = g.live?.people(id) ?? [];
        const key = people.map((p) => `${p.device} ${p.name}`).join("\n");
        if (!span || span.dataset.people === key) continue;
        span.dataset.people = key;
        span.replaceChildren(...people.map(chip));
      }
    }
  }

  /** This device's pointer or last touch, in screen points, for the open board's cursor; null when it left. */
  pointerAt(p: Point | null) {
    clearTimeout(this.touchTimer);
    if (!this.live || !this.id) return;
    if (!p) return this.live.sendCursor(this.id, null, null);
    const w = this.app.view.toWorld(p);
    this.live.sendCursor(this.id, w.x, w.y);
  }

  /** A phone's cursor is its last touch, hidden 3 s after the finger lifts. */
  touchEnded() {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => this.pointerAt(null), 3000);
  }

  /** Asks for this device's name; true once it has one. */
  /** Sends what the app recorded, for whoever debugs what its owner saw go wrong, and says whether it went. */
  async reportProblem() {
    const sent = await this.reporter.report("asked");
    await ask(sent
      ? { title: "Sent", message: "Tell Claude what looked wrong.", cancel: null }
      : { title: "Not Sent", message: "Breezy couldn’t reach the server of a shared space. Try again once it can.", cancel: null });
  }

  async askName() {
    const r = await ask({ title: "Your Name", message: "Others in your spaces see it beside your cursor.", value: this.spaces.me.name, placeholder: "Name", ok: "OK" });
    const name = r?.value?.trim();
    if (name) await this.spaces.setName(name);
    return !!this.spaces.me.name;
  }

  /** Each space's first status line under its name, in place, so a tap under way isn't lost to a new list. */
  renderStatus() {
    for (const g of this.spaces.spaces) {
      const p = document.querySelector(`.boards-group[data-group="${g.key}"] .status`);
      if (p) p.textContent = statusLines(g.engine.status)[0];
    }
  }

  /** Puts the space menu under `button`, for `group`. */
  pointMenu(button: HTMLElement, group: Group) {
    this.menuGroup = group;
    const r = button.getBoundingClientRect();
    const menu = document.querySelector<HTMLElement>(".menu.space")!;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${innerWidth - r.right}px`;
  }

  reveal(group: Group) {
    document.querySelector(`.boards-group[data-group="${group.key}"]`)?.scrollIntoView({ block: "nearest" });
  }

  async newBoard(group: Group) {
    const r = await ask({ title: "New Board", value: "", placeholder: "Name", ok: "Create" });
    const title = r?.value?.trim();
    if (title && this.spaces.groups().includes(group)) this.open(group.store.createBoard(title));
  }

  async edit(id: string) {
    const group = this.spaces.groupOf(id);
    const title = group?.store.title(id);
    if (title == null || !group) return;
    const others = this.spaces.groups().filter((g) => g !== group);
    const r = await ask({ title: "Rename Board", value: title, ok: "Rename", danger: "Delete Board", choices: others.length ? ["Move to…"] : [] });
    if (r?.choice === 0) return this.move(id, group, others);
    if (r?.value?.trim() && r.value.trim() !== title) return group.store.renameBoard(id, r.value.trim());
    if (!r?.danger) return;
    const sure = await ask({
      title: `Delete “${title}”?`,
      message: group.space ? `It is deleted on every device in “${group.name}”.` : "This can’t be undone.",
      ok: null, danger: "Delete",
    });
    if (sure?.danger) group.store.deleteBoard(id);
  }

  async move(id: string, group: Group, others: Group[]) {
    const title = group.store.title(id);
    const r = await ask({ title: `Move “${title}” to`, choices: others.map((g) => g.name), ok: null });
    const target = others[r?.choice ?? -1];
    if (!target || !this.spaces.groups().includes(target)) return;
    if (group.space) {
      const sure = await ask({ title: `Move “${title}” to “${target.name}”?`, message: `It is removed from “${group.name}” on every device.`, ok: "Move" });
      if (!sure) return;
    }
    if (await this.spaces.move(id, target)) return;
    await ask({ title: "Boards can’t be saved on this device", message: `“${title}” stays in “${group.name}”.`, cancel: null });
  }

  /** The ⋯ menu's lines: whether boards can be saved, and the open board's space status. */
  statusLines() {
    const unsaved = this.spaces.readOnly || this.spaces.saveFailed;
    return [...(unsaved ? ["Boards can’t be saved on this device"] : []), ...(this.group?.space ? statusLines(this.group.engine.status) : []), ...(this.group?.live?.directStatus() ? [this.group.live.directStatus()] : [])];
  }

  async newSpace() {
    if (!this.spaces.me.name && !(await this.askName())) return;
    const named = await ask({ title: "New Space", message: "Its boards are shared with whoever you send its invite.", value: "", placeholder: "Name", ok: "Next" });
    const name = named?.value?.trim();
    if (!name) return;
    const r = await ask({
      title: "Server",
      message: "The address of your Breezy server. Boards are encrypted on this device; the server can’t read them.",
      value: this.spaces.lastServer ?? "", placeholder: "https://example.com/breezy/sync.php", ok: "Create",
    });
    const server = r?.value?.trim();
    if (!server) return;
    if (!validServer(server)) return ask({ title: "That isn’t a server address", message: "Use an https:// address ending in sync.php.", cancel: null });
    const g = this.spaces.newSpace(server, name);
    this.showList();
    this.reveal(g);
    await g.engine.sync();
  }

  /** Joins the space in `text`, a link opened or pasted, or asks for one; a link opened asks first. */
  async join(text?: string) {
    if (!this.spaces.me.name && !(await this.askName())) return;
    const opened = text !== undefined;
    if (!opened) {
      const r = await ask({ title: "Join Space", message: "Paste the invite link from another device.", value: "", placeholder: "Invite link", ok: "Join" });
      if (!r) return;
      text = r.value;
    }
    const invite = parseInvite(text!);
    if (!invite) return ask({ title: "That isn’t an invite link", message: "Copy the whole link from Share Invite on the other device.", cancel: null });
    const known = this.spaces.groupFor(invite.space);
    if (!known) {
      const host = new URL(invite.server).hostname;
      const title = invite.name ? `Join “${invite.name}” on ${host}?` : `Join the space on ${host}?`;
      if (opened && !(await ask({ title, ok: "Join" }))) return;
    }
    const g = known ?? this.spaces.join(invite);
    this.showList();
    this.reveal(g);
    await g.engine.sync();
  }

  async renameSpace(g = this.menuGroup) {
    if (!g?.space) return;
    const r = await ask({ title: "Rename Space", message: "The new name shows on every device in the space.", value: g.name, ok: "Rename" });
    const name = r?.value?.trim();
    if (name && name !== g.name) g.store.rename(name);
  }

  async leaveSpace(g = this.menuGroup) {
    if (!g?.space) return;
    const n = g.store.pending().length;
    const lost = n ? `, but ${n === 1 ? "1 change that hasn’t" : `${n} changes that haven’t`} reached the server yet ${n === 1 ? "is" : "are"} lost` : "";
    const sure = await ask({ title: `Leave “${g.name}”?`, message: `Its boards are removed from this device. Others in the space keep them${lost}.`, ok: null, danger: "Leave" });
    if (!sure?.danger) return;
    if (this.group === g) this.showList();
    try {
      await this.spaces.leave(g);
    } finally {
      this.renderList();
    }
  }

  async share(g = this.menuGroup) {
    const invite = g?.store.invite;
    if (!invite) return;
    const link = inviteLink(invite);
    try {
      await navigator.share({ url: link });
      return;
    } catch (error) {
      if ((error as Error | undefined)?.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return ask({
        title: "Share Invite",
        message: "Copy this link and paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.",
        value: link, ok: "OK", cancel: null,
      });
    }
    await ask({
      title: "Invite link copied",
      message: "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.",
      cancel: null,
    });
  }
}
