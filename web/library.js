import { Store, withFreshIDs } from "./sync/store.js";
import { Saver } from "./sync/saver.js";
import { loadState, saveState } from "./sync/idb.js";
import { Binding } from "./binding.js";
import { sampleBoard } from "./sample.js";
import { ask } from "./sheet.js";
import { SyncEngine, statusLines } from "./sync/engine.js";
import { inviteLink, parseInvite, validServer } from "./sync/crypto.js";
import * as R from "./rules.js";

/** The boards on this device: the store in IndexedDB, the board list and the open board. */
export class Library {
  static async open(app) {
    let state = null, readOnly = false;
    try {
      state = await loadState();
    } catch (error) {
      // saving now could overwrite boards that failed to load
      console.warn("boards not loaded", error);
      readOnly = true;
    }
    const lib = new Library(app, new Store(state ?? undefined), readOnly);
    if (!state) lib.store.createBoard("Sample", withFreshIDs(sampleBoard()));
    lib.showList();
    if (location.hash.includes("#join=")) {
      const text = location.href;
      history.replaceState(null, "", location.pathname + location.search);
      lib.join(text);
    }
    lib.engine.sync();
    return lib;
  }

  constructor(app, store, readOnly) {
    this.app = app;
    this.store = store;
    this.readOnly = readOnly;
    this.id = null;
    this.binding = null;
    app.library = this;
    this.saver = new Saver(() => saveState(this.store.state));
    this.saver.enabled = !readOnly;
    this.saver.onError = (error) => {
      console.warn("boards not saved", error);
      app.ui.updateSync();
    };
    store.onDirty = () => this.saver.schedule();
    store.onChange = (boards, remote) => this.changed(boards, remote);
    this.engine = new SyncEngine(store);
    this.engine.flushLocal = () => this.binding?.flush();
    this.engine.onStatus = () => app.ui.updateSync();
    setInterval(() => !document.hidden && this.engine.sync(), 5000);
    document.addEventListener("visibilitychange", () => document.hidden || this.engine.sync());
    app.ui.updateSync();
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
      this.saver.flush();
    };
    document.addEventListener("visibilitychange", () => document.hidden && hide());
    addEventListener("pagehide", hide);
    document.querySelector('[data-act="boards"]').hidden = false;
  }

  changed(boards, remote) {
    if (this.id && boards.has(this.id)) {
      if (this.store.title(this.id) === null) return this.showList();
      if (remote) this.binding.pull();
    }
    if (!this.id) this.renderList();
    if (!remote) this.engine.changed();
    this.app.ui.updateSync();
  }

  open(id) {
    this.binding?.flush();
    this.binding = null;
    this.id = id;
    const b = this.store.board(id);
    this.restack(b);
    document.body.dataset.screen = "board";
    this.app.load(b);
    this.binding = new Binding(this.store, this.app.model, id, this.restack);
    this.engine.sync();
  }

  showList() {
    this.app.endEditing();
    this.binding?.flush();
    this.binding = null;
    this.id = null;
    document.body.dataset.screen = "boards";
    this.renderList();
  }

  renderList() {
    const ul = document.querySelector(".boards-list");
    ul.replaceChildren(...this.store.boards().map(({ id, title }) => {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.className = "open";
      open.textContent = title || "Untitled";
      open.addEventListener("click", () => this.open(id));
      const edit = document.createElement("button");
      edit.className = "edit";
      edit.setAttribute("aria-label", `Rename or delete ${title || "Untitled"}`);
      edit.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
      edit.addEventListener("click", () => this.edit(id));
      li.append(open, edit);
      return li;
    }));
    ul.hidden = !ul.children.length;
  }

  async newBoard() {
    const r = await ask({ title: "New Board", value: "", placeholder: "Name", ok: "Create" });
    const title = r?.value?.trim();
    if (title) this.open(this.store.createBoard(title));
  }

  async edit(id) {
    const title = this.store.title(id);
    const r = await ask({ title: "Rename Board", value: title, ok: "Rename", danger: "Delete Board" });
    if (r?.value?.trim() && r.value.trim() !== title) return this.store.renameBoard(id, r.value.trim());
    if (!r?.danger) return;
    const sure = await ask({
      title: `Delete “${title}”?`,
      message: this.store.syncing ? "It is deleted on every device in the space." : "This can’t be undone.",
      ok: null, danger: "Delete",
    });
    if (sure?.danger) this.store.deleteBoard(id);
  }

  statusLines() {
    const unsaved = this.readOnly || this.saver.failed;
    return [...(unsaved ? ["Boards can’t be saved on this device"] : []), ...statusLines(this.engine.status)];
  }

  async startSyncing() {
    const r = await ask({
      title: "Start Syncing",
      message: "The address of your Breezy server. Boards are encrypted on this device; the server can’t read them.",
      value: "", placeholder: "https://example.com/breezy/sync.php", ok: "Start",
    });
    const server = r?.value?.trim();
    if (!server) return;
    if (!validServer(server)) return ask({ title: "That isn’t a server address", message: "Use an https:// address ending in sync.php.", cancel: null });
    this.store.startSyncing(server);
    this.engine.reset();
    await this.engine.sync();
  }

  /** Joins the space in `text`, a link opened or pasted, or asks for one; a link opened always asks first. */
  async join(text) {
    const opened = text !== undefined;
    if (!opened) {
      const r = await ask({ title: "Join Space", message: "Paste the invite link from another device.", value: "", placeholder: "Invite link", ok: "Join" });
      if (!r) return;
      text = r.value;
    }
    const invite = parseInvite(text);
    if (!invite) return ask({ title: "That isn’t an invite link", message: "Copy the whole link from Share Invite on the other device.", cancel: null });
    const host = new URL(invite.server).hostname;
    const n = this.store.boards().length;
    if (n) {
      const sure = await ask({
        title: "Replace the boards here?",
        message: `Joining the space on ${host} shows its boards instead of the ${n === 1 ? "board" : `${n} boards`} on this device, which are deleted from it.`,
        ok: null, danger: "Join",
      });
      if (!sure?.danger) return;
    } else if (opened && !(await ask({ title: `Join the space on ${host}?`, ok: "Join" }))) {
      return;
    }
    this.showList();
    this.store.join(invite);
    this.engine.reset();
    await this.engine.sync();
  }

  async share() {
    const link = inviteLink(this.store.invite);
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
