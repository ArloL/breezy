// One tab on a device owns its boards: it alone loads, saves, syncs and joins the relay.

const LOCK = "breezy-boards";

/** Resolves once this tab owns the boards, holding the lock for its lifetime; calls `waiting` first if another tab
 * owns them. Without Web Locks every tab owns them. */
export function ownBoards(locks, waiting) {
  if (!locks) return Promise.resolve();
  return new Promise((owned) => {
    const hold = () => {
      owned();
      return new Promise(() => {});
    };
    locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (lock) return hold();
      waiting();
      locks.request(LOCK, hold);
    });
  });
}
