import {
  defineRailway,
  fn,
  github,
  postgres,
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

export default defineRailway((context) => {
  const environment = context.environment ?? "production";
  const database = postgres("postgres");
  const telegramSession = volume("telegram-session");

  const api = service("api", {
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
    networking: {
      serviceDomains: {
        [`hacker-news-indexer-api-${environment}-0bd3afd7.up.railway.app`]: {
          port: 3000,
        },
      },
    },
    env: {
      ...baseEnvironment,
      DATABASE_URL: database.env.DATABASE_URL,
      APP_REVIEW_ACTOR_ID: "owner",
    },
  });

  const worker = service("worker", {
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
      TELEGRAM_SESSION_PATH: "/data/telegram/telegram.session",
      CLASSIFIER_ENABLED: "false",
    },
    volumeMounts: {
      "/data/telegram": telegramSession,
    },
  });

  const scheduler = fn("scheduler", {
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
    resources: [database, telegramSession, api, worker, scheduler],
  });
});
