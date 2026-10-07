// The page's side of sw.js: registers it, asks it to check for updates, and reloads into a downloaded version.

export const RELOAD_AFTER_MS = 5 * 60 * 1000;

/** Whether coming back from the background should reload into the latest downloaded version. */
export function shouldReload({ running, latest, hiddenFor, editing }) {
  return !!latest && latest !== running && !editing && hiddenFor >= RELOAD_AFTER_MS;
}

/** Asks the worker; resolves to null when it does not answer in time. */
function ask(type, ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
    navigator.serviceWorker.ready.then((reg) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      reg.active?.postMessage({ type }, [channel.port2]);
    }, () => resolve(null));
  });
}

export function startUpdates(app) {
  const button = document.querySelector('[data-act="version"]');
  const running = button.dataset.version;
  if (running === "dev" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((error) => console.warn("service worker not registered", error));
  navigator.storage?.persist?.().catch(() => {});

  const latest = (s) => s && (s.next ?? s.current);
  const check = async () => {
    const v = latest(await ask("check", 120_000));
    button.dataset.next = v && v !== running ? v : "";
  };
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const editing = !!(app.state.editing || app.state.renaming);
    if (shouldReload({ running, latest: latest(await ask("status", 2000)), hiddenFor: Date.now() - hiddenAt, editing })) {
      location.reload();
      return;
    }
    check();
  });
  check();
}
