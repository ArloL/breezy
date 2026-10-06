const SAVE_DELAY = 500;
const RETRY_DELAY = 5000;

class Store {
  constructor(board, view) {
    this.board = board;
    this.view = view;
    this.readOnly = location.protocol === "file:";
    this.timer = null;
    this.saving = false;
    this.dirty = false;
    this.stopped = false;
    view.setStatus(this.readOnly ? "read-only: run breezy.py to edit" : "saved");
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty || this.saving) e.preventDefault();
    });
  }

  schedule(delay = SAVE_DELAY) {
    if (this.readOnly) return;
    this.dirty = true;
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (this.saving) return;
    this.saving = true;
    this.dirty = false;
    this.view.setStatus("saving…");
    let failed = false;
    try {
      const res = await fetch("/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.board.data),
      });
      if (res.status === 409) {
        this.stopped = true;
        this.dirty = true;
        this.view.setStatus("changed elsewhere — reload", true);
        return;
      }
      if (!res.ok) throw new Error(`server error ${res.status}`);
      this.board.data.rev = (await res.json()).rev;
      if (!this.dirty) this.view.setStatus("saved");
    } catch (err) {
      failed = true;
      const reason = err.message.startsWith("server error") ? err.message : "server unreachable";
      this.view.setStatus(`not saving: ${reason}`, true);
    } finally {
      this.saving = false;
      if (failed) this.schedule(RETRY_DELAY);
      else if (this.dirty) this.schedule();
    }
  }
}
