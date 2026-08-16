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

function shutdown() {
  jobLoop.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
