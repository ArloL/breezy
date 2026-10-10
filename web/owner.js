// One tab on a device owns its boards: it alone loads, saves, syncs and joins the relay. Another tab may ask for them.

const LOCK = "breezy-boards";
/** How long a tab that handed the boards over waits for the asking tab to take the lock before letting it go anyway. */
const TAKE_MS = 2000;

/**
 * Resolves once this tab owns the boards, holding the lock until the tab closes or another asks for them: then
 * `handOver` saves what is pending and stops, the other tab takes the lock, and `handedOver` follows. If another tab
 * owns them, calls `waiting` first with a function that asks it for them. Without Web Locks every tab owns them.
 */
export function ownBoards({ locks, channel, waiting, handOver, handedOver }) {
  if (!locks) return Promise.resolve();
  const me = crypto.randomUUID();
  return new Promise((owned) => {
    let owns = false, left = false;
    const leave = () => {
      if (!left) handedOver();
      left = true;
    };
    // a queued request given up is no loss
    const lost = () => owns && leave();
    const hold = () => {
      owns = true;
      owned();
      let handing = false;
      channel.onmessage = async ({ data }) => {
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
      channel.onmessage = ({ data }) => {
        if (data.take !== me) return;
        queued.abort();
        // ahead of any tab that waited longer
        locks.request(LOCK, { steal: true }, hold).catch(lost);
      };
      waiting(() => channel.postMessage({ want: me }));
    }).catch(lost);
  });
}
