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
# The whole built workspace: the pre-deploy migration step runs through tsx (a dev dependency).
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "backend/dist/main.js"]
