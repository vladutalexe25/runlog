# --- build ---
# Compiles the backend (tsc) and builds the frontend (vite build into
# web/dist) using the exact same `npm run build` as local dev and CI.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_SENTRY_DSN is embedded into the frontend bundle at build time (Vite
# reads it when `vite build` runs inside `npm run build` below) — unlike
# every other env var here, it has to come in as a build-arg, not something
# passed to `docker run` at container start.
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN

RUN npm run build

# --- runtime ---
# Only the compiled output + production deps land here — no TypeScript, no
# dev tooling, no .ts source, no web/node_modules (web/dist is static files
# served by express.static, nothing there needs Node at runtime).
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

EXPOSE 4000
CMD ["node", "--import", "./dist/instrument.js", "dist/api/server.js"]
