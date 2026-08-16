// Imported first, before anything else, in server.ts — Sentry's Node SDK
// needs to initialize before other modules (http, pg, etc.) are required
// to auto-instrument them. A no-op if SENTRY_DSN isn't set, so local dev
// and CI never need a Sentry account to run.
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.1,
  });
}
