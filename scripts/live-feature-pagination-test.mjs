import { spawnSync } from "node:child_process";

const environmentName = process.env.EADP_LIVE_ENV ?? "开发全局管理员";
const expectedCount = Number.parseInt(
  process.env.EADP_EXPECTED_FEATURE_COUNT ?? "1855",
  10
);
const executable = process.env.EADP_EXECUTABLE ??
  (process.platform === "win32" ? "eadp.cmd" : "eadp");

if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
  throw new Error("EADP_EXPECTED_FEATURE_COUNT 必须是正整数");
}

const query = spawnSync(
  executable,
  ["--compact", "resource", "query", "feature", "--env", environmentName],
  {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024
  }
);

if (query.status !== 0) {
  throw new Error(
    `开发环境功能项查询失败：${query.stderr || query.stdout || `退出码 ${query.status}`}`
  );
}

const result = JSON.parse(query.stdout.trim());
const items = Array.isArray(result.items) ? result.items : [];
const summary = result;
const uniqueIds = new Set(items.map((item) => item?.id).filter(Boolean));

if (result?.environment !== environmentName) {
  throw new Error(`查询环境不符：期望 ${environmentName}，实际 ${result?.environment}`);
}
if (items.length !== expectedCount) {
  throw new Error(`功能项数量不符：期望 ${expectedCount}，实际 ${items.length}`);
}
if (summary?.total !== expectedCount) {
  throw new Error(`流式总数不符：期望 ${expectedCount}，实际 ${summary?.total}`);
}
if (uniqueIds.size !== expectedCount) {
  throw new Error(`功能项 ID 存在重复：共 ${items.length} 条，唯一 ID ${uniqueIds.size} 个`);
}

process.stdout.write(
  `${JSON.stringify({
    success: true,
    environment: environmentName,
    total: summary.total,
    itemCount: items.length,
    uniqueIds: uniqueIds.size
  }, null, 2)}\n`
);
