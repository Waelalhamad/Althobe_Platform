# Production image: one service serves the API (/api/v1) and the built warehouse app (ADR-007).
# Build:  docker build -t althobe .
# Run:    docker run -p 3000:3000 -e DATABASE_URL=… -e DIRECT_URL=… althobe

FROM node:22-bookworm-slim AS base
# Prisma's query engine needs OpenSSL on Linux.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS build
# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
COPY apps/warehouse/package.json apps/warehouse/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile
COPY . .
# Generation only reads the schema; the real URLs are given at runtime.
RUN DATABASE_URL=postgresql://build:build@localhost/build \
    DIRECT_URL=postgresql://build:build@localhost/build \
    pnpm --filter @althobe/backend db:generate
RUN pnpm build

FROM base AS run
ENV NODE_ENV=production
# The whole built workspace: the migration step runs through tsx (a dev dependency).
COPY --from=build /app /app
EXPOSE 3000
# Migrations run on start, before the server: Railway ignored railway.json's preDeployCommand on
# 2026-10-12, which left a release running on the old schema. A failed migration stops the start,
# so the new release never goes live. Migrations are idempotent; a restart re-checks in seconds.
CMD ["sh", "-c", "pnpm --filter @althobe/backend db:migrate && exec node backend/dist/main.js"]
