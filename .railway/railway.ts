import {
  defineRailway,
  fn,
  github,
  postgres,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

const repository = "pavelivanov/hacker-news-indexer";
const watchPatterns = [
  "/Dockerfile",
  "/.dockerignore",
  "/.npmrc",
  "/package.json",
  "/package-lock.json",
  "/apps/api/**",
  "/apps/worker/**",
  "/packages/**",
];

const source = () => github(repository, { branch: "main" });
const build = {
  builder: "DOCKERFILE" as const,
  dockerfilePath: "Dockerfile",
  watchPatterns,
};
const baseEnvironment = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
};

export default defineRailway((ctx) => {
  // Railway service names are project-global even though each environment has
  // isolated instances. Keep the established staging names while giving the
  // separately managed production graph unique service identities.
  const production = ctx.environment === "production";
  const resourceName = (name: string) =>
    production ? `${name}-production` : name;

  const database = postgres(resourceName("postgres"));
  // Retained in staging until the serialized-session rollout is verified and
  // its separate, destructive removal is approved. Production never creates
  // or mounts this obsolete volume.
  const telegramSession =
    ctx.environment === "staging" ? volume("telegram-session") : null;

  const api = service(resourceName("api"), {
    source: source(),
    build,
    start: "node --enable-source-maps apps/api/dist/server.js",
    preDeploy: "npm run db:migrate:deploy",
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: 15,
    },
    env: {
      ...baseEnvironment,
      DATABASE_URL: database.env.DATABASE_URL,
      APP_API_TOKEN: preserve(),
      APP_REVIEW_ACTOR_ID: "owner",
    },
  });

  const worker = service(resourceName("worker"), {
    source: source(),
    build,
    start: "node --enable-source-maps apps/worker/dist/index.js",
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: 15,
    },
    env: {
      ...baseEnvironment,
      DATABASE_URL: database.env.DATABASE_URL,
      TELEGRAM_ENABLED: "false",
      CLASSIFIER_ENABLED: "false",
    },
    ...(telegramSession === null
      ? {}
      : {
          volumeMounts: {
            "/data/telegram": telegramSession,
          },
        }),
  });

  const scheduler = fn(resourceName("scheduler"), {
    source: source(),
    build,
    start: "node --enable-source-maps apps/worker/dist/schedule-once.js",
    deploy: {
      cronSchedule: "17 3 * * *",
      restartPolicyType: "NEVER",
    },
    env: {
      ...baseEnvironment,
      DATABASE_URL: database.env.DATABASE_URL,
    },
  });

  return project("hacker-news-indexer", {
    environments: ["staging", "production"],
    resources: [
      database,
      ...(telegramSession === null ? [] : [telegramSession]),
      api,
      worker,
      scheduler,
    ],
  });
});
