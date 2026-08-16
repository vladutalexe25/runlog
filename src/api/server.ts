import { createApp } from "./app.js";
import { startJobLoop } from "../jobs/processor.js";

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
