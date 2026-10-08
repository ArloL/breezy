import { Store, withFreshIDs } from "./sync/store.js";
import { Saver } from "./sync/saver.js";
import { loadState, saveState } from "./sync/idb.js";
import { Binding } from "./binding.js";
import { sampleBoard } from "./sample.js";
import { ask } from "./sheet.js";
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
    store.onDirty = () => this.saver.schedule();
    store.onChange = (boards, remote) => this.changed(boards, remote);
    const change = app.model.onChange;
    app.model.onChange = () => {
      change();
      this.binding?.changed();
    };
    this.restack = (b) => R.gravity(b, (id) => {
      const c = R.card(b, id);
      return c ? app.view.frontHeight(c.text, c.w) : 0;
    });
    document.addEventListener("visibilitychange", () => document.hidden && this.saver.flush());
    addEventListener("pagehide", () => this.saver.flush());
    document.querySelector('[data-act="boards"]').hidden = false;
  }

  changed(boards, remote) {
    if (this.id && boards.has(this.id)) {
      if (this.store.title(this.id) === null) return this.showList();
      if (remote) this.binding.pull();
    }
    if (!this.id) this.renderList();
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
}
