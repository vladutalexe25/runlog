// Imported first in main.tsx, before anything else — a no-op if
// VITE_SENTRY_DSN isn't set, so local dev and CI never need a Sentry
// account to run.
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
  });
}
