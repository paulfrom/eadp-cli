import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    // 这些用例会真实起 mock HTTP 服务并完成多次请求/回查：正常耗时最高的
    // 用例约 2.2s，机器繁忙（构建、杀软扫描、并行任务）时曾超过默认的 5s
    // 而被误判为超时，进而挡住 npm publish 的 prepack 门禁。留足余量。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      include: ["src/**/*.ts"]
    }
  }
});
