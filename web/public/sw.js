// The console needs the gateway behind it, so nothing is cached: this worker
// exists so that browsers offer to install the console as an app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
