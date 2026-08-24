import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/evaluation/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
