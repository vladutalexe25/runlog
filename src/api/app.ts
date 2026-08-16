import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import * as Sentry from "@sentry/node";
import { workflowsRouter } from "./routes/workflows.js";
import { runsRouter } from "./routes/runs.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file compiles to dist/api/app.js; the frontend build lands at web/dist.
const webDist = path.join(__dirname, "../../web/dist");

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // /api prefix keeps these distinct from the frontend's own /workflows/:id
  // SPA routes — without it, a hard navigation or refresh on the frontend's
  // workflow detail page hits this JSON endpoint instead of the app shell.
  app.use("/api", workflowsRouter);
  app.use("/api", runsRouter);
  // Webhook URLs are handed to external services, so keep them short and
  // unprefixed — no frontend route collides with /webhooks/*.
  app.use(webhooksRouter);

  // Serve the built frontend from the same origin so it never needs a
  // configurable API base URL or CORS beyond the default — only present
  // after `npm run build` runs the frontend build too. In local dev the
  // frontend runs separately under Vite, so this is a no-op there.
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // Registered after routes, before the JSON error handler below, per
  // Sentry's Express integration contract — a no-op if SENTRY_DSN isn't set.
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    logger.error("unhandled request error", {
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  };
  app.use(onError);

  return app;
}
