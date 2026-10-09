import { withFreshIDs } from "./sync/store.js";
import { Spaces } from "./sync/spaces.js";
import { storage } from "./sync/idb.js";
import { Binding } from "./binding.js";
import { sampleBoard } from "./sample.js";
import { ask } from "./sheet.js";
import { chip } from "./presence.js";
import { statusLines } from "./sync/engine.js";
import { inviteLink, parseInvite, validServer } from "./sync/crypto.js";
import * as R from "./rules.js";

const MORE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

/** The boards on this device: their groups in IndexedDB, the board list and the open board. */
export class Library {
  static async open(app) {
    let spaces;
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

  constructor(app, spaces) {
    this.app = app;
    this.spaces = spaces;
    this.id = null;
    this.group = null;
    this.binding = null;
    /** The space whose menu was opened last. */
    this.menuGroup = null;
    app.library = this;
    spaces.onChange = (group, boards, remote) => this.changed(group, boards, remote);
    spaces.onStatus = () => {
      this.renderStatus();
      app.ui.updateSync();
    };
    spaces.onSaveError = (error) => {
      console.warn("boards not saved", error);
      app.ui.updateSync();
    };
    spaces.flushLocal = () => this.binding?.flush();
    setInterval(() => !document.hidden && spaces.syncAll({ polling: true }), 5000);
    setInterval(() => this.spaces.spaces.forEach((g) => g.live?.tick()), 1000);
    spaces.onLive = (g) => this.liveChanged(g);
    app.onSelect = () => this.updateLive();
    document.addEventListener("visibilitychange", () => this.updateLive());
    document.addEventListener("visibilitychange", () => document.hidden || spaces.syncAll());
    const change = app.model.onChange;
    app.model.onChange = () => {
      change();
      this.binding?.changed();
    };
    this.restack = (b) => R.gravity(b, (id) => {
      const c = R.card(b, id);
      return c ? app.view.frontHeight(c.text, c.w) : 0;
    });
    const hide = () => {
      this.binding?.flush();
      spaces.flushAll();
    };
    document.addEventListener("visibilitychange", () => document.hidden && hide());
    addEventListener("pagehide", hide);
    document.querySelector('[data-act="boards"]').hidden = false;
  }

  changed(group, boards, remote) {
    if (this.id && group === this.group && boards.has(this.id)) {
      if (group.store.title(this.id) === null) return this.showList();
      if (remote) this.binding.pull();
    }
    if (!this.id) this.renderList();
    this.app.ui.updateSync();
  }

  open(id) {
    this.binding?.flush();
    this.binding = null;
    const group = this.spaces.groupOf(id);
    if (!group) return this.showList();
    this.id = id;
    this.group = group;
    const b = group.store.board(id);
    this.restack(b);
    document.body.dataset.screen = "board";
    this.app.load(b);
    this.binding = new Binding(group.store, this.app.model, id, this.restack);
    this.app.ui.updateSync();
    group.engine.sync();
    this.updateLive();
    this.showPresence();
  }

  showList() {
    this.app.endEditing();
    this.binding?.flush();
    this.binding = null;
    this.id = null;
    this.group = null;
    document.body.dataset.screen = "boards";
    this.renderList();
    this.app.ui.updateSync();
    this.updateLive();
    this.showPresence();
  }

  /** A section per group; On this device only when it has boards or the device is in no space. */
  renderList() {
    const { spaces } = this;
    const shown = spaces.groups().filter((g) => g.space || !spaces.spaces.length || g.store.boards().length);
    document.querySelector(".boards-groups").replaceChildren(...shown.map((g) => this.renderGroup(g)));
    this.renderStatus();
    this.renderPeople();
  }

  renderGroup(g) {
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
      this.app.ui.menus.attach(more, document.querySelector(".menu.space"));
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

  renderBoard(id, title) {
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
      g.live.setPresence({ board: here ? this.id : null, selection: here ? [...this.app.state.selection].sort() : [] });
    }
  }

  liveChanged(g) {
    this.updateLive();
    if (g === this.group) this.showPresence();
    if (!this.id) this.renderPeople();
  }

  /** Others on the open board: what they hold and have selected, their cursors, and their initials. */
  showPresence() {
    const { live, id } = this;
    const s = this.app.state;
    s.taken = new Map();
    s.seen = new Map();
    if (live && id) {
      for (const [item, p] of live.selections(id)) s.seen.set(item, p.colour);
      for (const item of live.taken()) s.taken.set(item, live.holderOf(item));
    }
    if ([...s.selection].some((x) => s.taken.has(x))) this.app.select(s.selection);
    this.app.view.invalidate();
    this.app.presence.show({ cursors: live && id ? live.cursors(id) : [], people: live && id ? live.people(id) : [] });
  }

  /** Each board row's initials of whoever is on it, in place. */
  renderPeople() {
    for (const g of this.spaces.spaces) {
      for (const { id } of g.store.boards()) {
        const span = document.querySelector(`.boards-list li[data-board="${id}"] .people`);
        span?.replaceChildren(...(g.live?.people(id) ?? []).map(chip));
      }
    }
  }

  /** This device's pointer or last touch, in screen points, for the open board's cursor; null when it left. */
  pointerAt(p) {
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
  pointMenu(button, group) {
    this.menuGroup = group;
    const r = button.getBoundingClientRect();
    const menu = document.querySelector(".menu.space");
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${innerWidth - r.right}px`;
  }

  reveal(group) {
    document.querySelector(`.boards-group[data-group="${group.key}"]`)?.scrollIntoView({ block: "nearest" });
  }

  async newBoard(group) {
    const r = await ask({ title: "New Board", value: "", placeholder: "Name", ok: "Create" });
    const title = r?.value?.trim();
    if (title && this.spaces.groups().includes(group)) this.open(group.store.createBoard(title));
  }

  async edit(id) {
    const group = this.spaces.groupOf(id);
    const title = group?.store.title(id);
    if (title == null) return;
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

  async move(id, group, others) {
    const title = group.store.title(id);
    const r = await ask({ title: `Move “${title}” to`, choices: others.map((g) => g.name), ok: null });
    const target = others[r?.choice];
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
    return [...(unsaved ? ["Boards can’t be saved on this device"] : []), ...(this.group?.space ? statusLines(this.group.engine.status) : [])];
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
  async join(text) {
    if (!this.spaces.me.name && !(await this.askName())) return;
    const opened = text !== undefined;
    if (!opened) {
      const r = await ask({ title: "Join Space", message: "Paste the invite link from another device.", value: "", placeholder: "Invite link", ok: "Join" });
      if (!r) return;
      text = r.value;
    }
    const invite = parseInvite(text);
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
      if (error?.name === "AbortError") return;
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
