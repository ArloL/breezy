/** Writes what `save` saves shortly after the last `schedule`, or at once on `flush`; one write at a time. A failed
 * write is tried again on the next. */
export class Saver {
  save: () => unknown;
  delay: number;
  enabled: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void>;
  /** Whether the last save failed. */
  failed: boolean;
  /** After a save fails. */
  onError: (error: unknown) => void;

  constructor(save: () => unknown, delay = 300) {
    this.save = save;
    this.delay = delay;
    this.enabled = true;
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
    this.failed = false;
    this.onError = () => {};
  }

  schedule(): void {
    this.dirty = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer ?? undefined);
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
