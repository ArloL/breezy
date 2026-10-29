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
 * write meanwhile. A tab going into the cache calls `away`, to save what is pending and then save and sync nothing;
 * shown again on Back, it asks for the lock again, through `waiting` if another tab holds it, and once it holds it
 * `back` follows, `changed` if another tab took the boards since this one last held them, as the `stamp` each tab
 * writes on taking them says.
 */
export function ownBoards({
  locks,
  channel,
  page,
  stamp,
  waiting,
  handOver,
  handedOver,
  away,
  back,
}: {
  locks: Pick<LockManager, "request"> | undefined;
  channel: Pick<BroadcastChannel, "onmessage" | "postMessage">;
  page: Pick<EventTarget, "addEventListener">;
  /** Who took the boards last, kept where every tab reads it. */
  stamp: { write: (id: string) => unknown; read: () => Promise<unknown> };
  waiting: (useHere: () => void) => unknown;
  handOver: () => Promise<unknown>;
  handedOver: () => void;
  away: () => void;
  back: (changed: boolean) => void;
}): Promise<void> {
  if (!locks) return Promise.resolve();
  const me = crypto.randomUUID();
  return new Promise<void>((owned) => {
    let left = false, ever = false, shows = 0;
    /** The request whose lock this tab holds. */
    let holding: object | null = null;
    const leave = () => {
      if (!left) handedOver();
      left = true;
    };
    const ask = () => {
      const show = shows;
      const request = (options: LockOptions) => {
        const mine = {};
        locks.request(LOCK, options, (lock) => (lock ? hold(mine, show) : free(show)))
          // a queued request given up, or one Safari failed as the tab froze, is no loss
          .catch(() => holding === mine && leave());
      };
      const free = (show: number) => {
        if (show !== shows) return;
        const queued = new AbortController();
        request({ signal: queued.signal });
        channel.onmessage = ({ data }: MessageEvent<Message>) => {
          if (data.take !== me) return;
          queued.abort();
          // ahead of any tab that waited longer
          request({ steal: true });
        };
        waiting(() => channel.postMessage({ want: me }));
      };
      request({ ifAvailable: true });
    };
    const hold = (mine: object, show: number) => {
      // asked for before Safari showed the tab again
      if (show !== shows || left) return;
      holding = mine;
      let handing = false;
      channel.onmessage = async ({ data }: MessageEvent<Message>) => {
        if (!data.want || handing) return;
        handing = true;
        await handOver();
        channel.postMessage({ take: data.want });
        setTimeout(leave, TAKE_MS);
      };
      if (!ever) {
        ever = true;
        stamp.write(me);
        owned();
      } else {
        void stamp.read().then((last) => {
          if (holding !== mine || handing) return;
          stamp.write(me);
          back(last !== me);
        });
      }
      return new Promise(() => {});
    };
    // still holding the lock; the page shows visible again before its pageshow, which would sync
    page.addEventListener("pagehide", (e) => (e as PageTransitionEvent).persisted && holding && !left && away());
    page.addEventListener("pageshow", (e) => {
      if (!(e as PageTransitionEvent).persisted || left) return;
      shows++;
      holding = null;
      ask();
    });
    ask();
  });
}
