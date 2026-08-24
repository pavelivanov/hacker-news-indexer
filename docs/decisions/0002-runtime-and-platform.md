# ADR 0002: Runtime and platform

- Status: accepted
- Date: 2026-08-24

## Decision

Use Node.js 24 LTS, npm workspaces, strict TypeScript, Hono on the Node adapter, Prisma with PostgreSQL, Docker, and Railway. Keep API and worker roles independently startable from the same repository and container image.

## Consequences

The repository pins the Node patch release and exact package versions. Runtime upgrades must pass local, database, and container gates. Bun is rejected for v1 because it adds compatibility risk across Prisma, Telegram clients, deployment tooling, and observability without a demonstrated project benefit.

At implementation time, Prisma 7.9.1's development CLI transitively includes `deepmerge-ts` under [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Prisma config is trusted local input, and the production image explicitly removes the Prisma CLI, `@prisma/config`, and `deepmerge-ts` after generating the client. Reassess the pruning when Prisma publishes an upstream fix; do not force an unsupported dependency override or downgrade silently.
