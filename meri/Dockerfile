# syntax=docker/dockerfile:1.7
# Container images for Meri (phase 6, D-098). Build context: this folder (meri/). One file, four targets:
#   docker build --target api     -t meri-api .
#   docker build --target worker  -t meri-worker .
#   docker build --target web     -t meri-web --build-arg API_URL=http://api:4000 .
#   docker build --target migrate -t meri-migrate .
# Secrets never enter the image: no secret ARG/ENV, `.env*` is excluded by .dockerignore, and every runtime value
# comes from the environment at start (docs/runbooks/deploy.md). Images run as the unprivileged `node` user.

# Base image pinned by digest (SEC-M7): bump the tag and its digest together, never use a floating tag.
ARG NODE_IMAGE=node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# Dependencies from the lockfile only, so source changes do not invalidate this layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
# Public, non-secret build input: Next fixes its `/api/v1` rewrite at build time, so the web image is built for the
# API address it will talk to (the internal service URL).
ARG API_URL=http://api:4000
ENV API_URL=${API_URL} \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
RUN pnpm turbo run build --filter=@meri/api --filter=@meri/worker --filter=@meri/web \
 && pnpm --filter @meri/db build:migrate
# Production dependencies only, one folder per runnable package. Workspace packages are bundled by tsup and their
# third-party dependencies stay external, so the install is flat (hoisted) for the bundle to resolve them.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @meri/api --config.node-linker=hoisted deploy --prod /out/api \
 && pnpm --filter @meri/worker --config.node-linker=hoisted deploy --prod /out/worker \
 && pnpm --filter @meri/db --config.node-linker=hoisted deploy --prod /out/db

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
EXPOSE 4000
ENV LISTEN_HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT:-4000}/health || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/worker/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
EXPOSE 4100
ENV LISTEN_HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT:-4100}/ready || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]

# One-off job run before each release (docs/runbooks/deploy.md): applies pending migrations with the owner role.
FROM runtime AS migrate
COPY --from=build --chown=node:node /out/db/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/db/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/db/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/packages/db/dist ./dist
CMD ["node", "dist/migrate-cli.js"]

FROM runtime AS web
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/privacy || exit 1
CMD ["node", "apps/web/server.js"]
