// A test file on real devices ends within 10 s of its last test, or fails naming what kept it running: a Firefox for
// Android left open once kept node --test waiting an hour after every case had passed.
import { after } from "node:test";

/** After the file's last test, `close` what it kept, then exit within 10 s, failing if anything still holds node. */
export function exitsAfter(close: () => Promise<unknown> = async () => {}) {
  after(async () => {
    await Promise.race([close(), new Promise((r) => setTimeout(r, 10_000).unref())]);
    setTimeout(() => {
      console.error(`still running 10 s after the last test, held by ${process.getActiveResourcesInfo().join(", ")}`);
      process.exit(1);
    }, 10_000).unref();
  });
}
