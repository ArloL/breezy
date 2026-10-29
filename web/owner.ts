// One tab on a device owns its boards: it alone loads, saves, syncs and joins the relay. Another tab may ask for them.

const LOCK = "breezy-boards";
/** How long a tab that handed the boards over waits for the asking tab to take the lock before letting it go anyway. */
const TAKE_MS = 2000;

interface Message {
  want?: string;
  take?: string;
}

/**
 * Resolves once this tab owns the boards, holding the lock until the tab closes or another asks for them: then
 * `handOver` saves what is pending and stops, the other tab takes the lock, and `handedOver` follows. If another tab
 * owns them, calls `waiting` first with a function that asks it for them. Without Web Locks every tab owns them.
 *
 * Safari lets a tab's lock go while the tab sits in the back-forward cache, and another tab may take the boards and
 * write meanwhile; so a tab it shows again on Back follows `handedOver` at once, before anything can be edited, rather
 * than when its lost lock fails a moment later.
 */
export function ownBoards({
  locks,
  channel,
  page,
  waiting,
  handOver,
  handedOver,
}: {
  locks: Pick<LockManager, "request"> | undefined;
  channel: Pick<BroadcastChannel, "onmessage" | "postMessage">;
  page: Pick<EventTarget, "addEventListener">;
  waiting: (useHere: () => void) => unknown;
  handOver: () => Promise<unknown>;
  handedOver: () => void;
}): Promise<void> {
  if (!locks) return Promise.resolve();
  const me = crypto.randomUUID();
  return new Promise<void>((owned) => {
    let owns = false, left = false;
    const leave = () => {
      if (!left) handedOver();
      left = true;
    };
    // a queued request given up is no loss
    const lost = () => owns && leave();
    page.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && leave());
    const hold = () => {
      owns = true;
      owned();
      let handing = false;
      channel.onmessage = async ({ data }: MessageEvent<Message>) => {
        if (!data.want || handing) return;
        handing = true;
        await handOver();
        channel.postMessage({ take: data.want });
        setTimeout(leave, TAKE_MS);
      };
      return new Promise(() => {});
    };
    locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (lock) return hold();
      const queued = new AbortController();
      locks.request(LOCK, { signal: queued.signal }, hold).catch(lost);
      channel.onmessage = ({ data }: MessageEvent<Message>) => {
        if (data.take !== me) return;
        queued.abort();
        // ahead of any tab that waited longer
        locks.request(LOCK, { steal: true }, hold).catch(lost);
      };
      waiting(() => channel.postMessage({ want: me }));
    }).catch(lost);
  });
}
