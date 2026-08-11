import type { Command } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import type { ConfigStore } from "../config/store.js";
import { printValue } from "../io.js";
import { rollbackOperation } from "../operations/rollback.js";
import { OperationLogStore } from "../operations/store.js";
import { getRuntimeOptions } from "../runtime-options.js";

export function registerRollbackCommand(program: Command, store: ConfigStore): void {
  program.command("rollback <operation-id>")
    .description("按本地操作日志回滚一次新增或分配操作（日志保留30天）")
    .option("--env <name>", "环境名称；必须与原操作环境一致")
    .addHelpText("after", `
示例：
  eadp rollback 550e8400-e29b-41d4-a716-446655440000

该命令直接执行回滚，不要求 --apply；执行前回查当前状态，冲突或任一接口失败时立即停止。`)
    .action(async (operationId: string, options: { env?: string }) => {
      const runtime = getRuntimeOptions(program);
      const logs = new OperationLogStore(store.directory);
      await logs.cleanup();
      const operation = await logs.load(operationId);
      const environment = resolveEnvironment(await store.load(), options.env ?? operation.environment);
      printValue(await rollbackOperation({ store: logs, operationId, environment, timeoutMs: runtime.timeoutMs }), runtime.compact);
    });
}
