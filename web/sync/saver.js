/** Writes what `save` saves shortly after the last `schedule`, or at once on `flush`; one write at a time. */
export class Saver {
  constructor(save, delay = 300) {
    this.save = save;
    this.delay = delay;
    this.enabled = true;
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  schedule() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.enabled) return this.writing;
    this.dirty = false;
    this.writing = this.writing.then(() => this.save()).catch((error) => console.warn("boards not saved", error));
    return this.writing;
  }
}
