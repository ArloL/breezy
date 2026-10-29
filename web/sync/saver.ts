/** Writes what `save` saves as the task that last called `schedule` ends, or at once on `flush`; one write at a time,
 * what is scheduled during one written once it is done. A failed write is tried again on the next.
 *
 * Not on a timer: Safari on iOS loses a write the page leaves before, and one issued from `pagehide` never lands. */
export class Saver {
  save: () => unknown;
  enabled: boolean;
  dirty: boolean;
  /** A flush is due when the current task ends. */
  queued: boolean;
  writing: Promise<void>;
  /** Whether the last save failed. */
  failed: boolean;
  /** After a save fails. */
  onError: (error: unknown) => void;

  constructor(save: () => unknown) {
    this.save = save;
    this.enabled = true;
    this.dirty = false;
    this.queued = false;
    this.writing = Promise.resolve();
    this.failed = false;
    this.onError = () => {};
  }

  schedule(): void {
    this.dirty = true;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.flush();
    });
  }

  flush(): Promise<void> {
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
