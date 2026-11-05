import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    // 这些用例会真实启动 mock HTTP 服务并完成多次请求/回查，默认 5s 容易
    // 在构建、杀软扫描或并行任务期间误判超时。大多数用例使用 30s；
    // bpm-migration 的两次完整组合迁移单独设置 60s，不放宽其他测试。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      include: ["src/**/*.ts"]
    }
  }
});
