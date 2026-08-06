let waitingWorker: ServiceWorker | null = null;

/**
 * Registers the offline shell and announces safely waiting updates.
 * @returns Nothing after registration listeners are installed.
 */
export async function registerPwa(): Promise<void> {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
  const announce = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    waitingWorker = worker;
    window.dispatchEvent(new CustomEvent("notemarkdown:update-available"));
  };
  announce(registration.waiting);
  registration.addEventListener("updatefound", () => {
    registration.installing?.addEventListener("statechange", () => {
      if (registration.installing?.state === "installed" && navigator.serviceWorker.controller) announce(registration.waiting);
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload());
}

/**
 * Activates a waiting shell only after callers have persisted active work.
 * @returns Nothing after activation is requested.
 */
export function activatePwaUpdate(): void {
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
}
