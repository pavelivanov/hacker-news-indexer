# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim AS base
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ports/package.json packages/ports/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tests/tsconfig.json tests/tsconfig.json
COPY tests/fixtures/manual-review tests/fixtures/manual-review
RUN npm run build

FROM base AS runtime-dependencies
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ports/package.json packages/ports/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci --omit=dev --omit=peer --ignore-scripts \
  && npm cache clean --force

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=runtime-dependencies --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=runtime-dependencies --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=runtime-dependencies --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/ports/dist ./packages/ports/dist
COPY --from=build --chown=node:node /app/packages/application/dist ./packages/application/dist
COPY --from=build --chown=node:node /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/prisma ./packages/db/prisma
COPY --from=build --chown=node:node /app/packages/db/prisma.config.ts ./packages/db/prisma.config.ts

USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]
