/** Writes what `save` saves shortly after the last `schedule`, or at once on `flush`; one write at a time. A failed
 * write is tried again on the next. */
export class Saver {
  constructor(save, delay = 300) {
    this.save = save;
    this.delay = delay;
    this.enabled = true;
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
    /** Whether the last save failed. */
    this.failed = false;
    /** After a save fails. */
    this.onError = () => {};
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
    this.writing = this.writing.then(() => this.save()).then(() => {
      this.failed = false;
    }, (error) => {
      this.dirty = true;
      this.failed = true;
      this.onError(error);
    });
    return this.writing;
  }
}
