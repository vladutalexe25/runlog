// Sentry is loaded via `node --import` (see the "dev"/"start" scripts in
// package.json), not a regular import here — for ESM, that's what lets its
// auto-instrumentation (e.g. Express) patch modules before they're
// resolved. A plain top-level import here runs too late for that; it would
// still call Sentry.init() successfully, just without full auto-instrumentation.
import { createApp } from "./app.js";
import { startJobLoop } from "../jobs/processor.js";

// On Windows, Node's stdout/stderr can be non-blocking when piped to a file
// or another process (not a real console) — sparse writes from a
// long-running process (exactly what this is: infrequent request/job logs)
// can sit in the OS pipe buffer indefinitely instead of flushing. Forcing
// blocking mode is the standard workaround; it's a no-op on platforms/
// destinations where it isn't needed.
for (const stream of [process.stdout, process.stderr]) {
  const handle = (stream as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
  handle?.setBlocking?.(true);
}

// 3000 is taken by something else on dev machines often enough that it's
// not worth the friction; pick a less contested default.
const port = Number(process.env.PORT ?? 4000);
const app = createApp();

const jobLoop = startJobLoop();

const server = app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
});

// Without this, a failed listen() (e.g. EADDRINUSE) leaves the job loop
// above running forever in an orphaned process with no HTTP server — it
// never crashes, never shows up as "the server on this port", and keeps
// claiming and executing runs from the same database as whatever process
// actually did bind the port. That's silent double-processing, not just a
// wasted process. Fail loudly instead.
server.on("error", (err) => {
  console.error(`failed to start server: ${err instanceof Error ? err.message : err}`);
  jobLoop.stop();
  process.exit(1);
});

function shutdown() {
  jobLoop.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
