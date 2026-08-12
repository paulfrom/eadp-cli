import type { Command } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import type { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import { preflightRollbackOperation, rollbackOperation } from "../operations/rollback.js";
import { isValidCompletedAt, OperationLogStore, type OperationRecord } from "../operations/store.js";
import { getRuntimeOptions } from "../runtime-options.js";

export function registerRollbackCommand(program: Command, store: ConfigStore): void {
  program.command("rollback <operation-id...>")
    .description("按本地操作日志回滚一个或多个新增或分配操作（日志保留1天）")
    .option("--env <name>", "环境名称；必须与原操作环境一致")
    .addHelpText("after", `
示例：
  eadp rollback 550e8400-e29b-41d4-a716-446655440000
  eadp rollback operation-new operation-old

该命令直接执行回滚，不要求 --apply；多个 operation-id 按 completedAt 从新到旧执行。
执行前读取并校验全部日志；环境不一致、completedAt 无效、冲突或任一接口失败时立即停止。`)
    .action(async (operationIds: string[], options: { env?: string }) => {
      const runtime = getRuntimeOptions(program);
      const logs = new OperationLogStore(store.directory);
      await logs.cleanup();
      if (new Set(operationIds).size !== operationIds.length) {
        throw new CliError("批量回滚不允许重复 operation-id");
      }
      const operations = await Promise.all(operationIds.map((operationId) => logs.load(operationId)));
      const environmentName = validateBatchEnvironment(operations, options.env);
      const environment = resolveEnvironment(await store.load(), environmentName);
      for (const operation of operations) {
        preflightRollbackOperation(operation, environment);
      }
      if (operations.length === 1) {
        printValue(await rollbackOperation({
          store: logs,
          operationId: operations[0]!.id,
          environment,
          timeoutMs: runtime.timeoutMs
        }), runtime.compact);
        return;
      }

      const ordered = [...operations].sort(compareCompletedAt);
      const results: Record<string, unknown>[] = [];
      for (const operation of ordered) {
        results.push(await rollbackOperation({
          store: logs,
          operationId: operation.id,
          environment,
          timeoutMs: runtime.timeoutMs
        }));
      }
      printValue({
        kind: "eadp.rollback.batch.v1",
        environment: environment.name,
        operationIds: ordered.map((operation) => operation.id),
        status: "rolled-back",
        operations: results
      }, runtime.compact);
    });
}

function validateBatchEnvironment(operations: OperationRecord[], requestedEnvironment?: string): string {
  const first = operations[0];
  // Commander guarantees at least one variadic argument, but keep this guard
  // explicit in case the command is invoked programmatically in the future.
  if (!first) throw new CliError("至少需要一个 operation-id");
  const environmentName = first.environment;
  if (operations.some((operation) => operation.environment !== environmentName)) {
    throw new CliError("批量回滚的操作日志环境不一致");
  }
  if (requestedEnvironment !== undefined && requestedEnvironment !== environmentName) {
    throw new CliError(`操作日志绑定环境 ${environmentName}，不能使用 ${requestedEnvironment} 回滚`);
  }
  if (operations.length > 1 && operations.some((operation) => !isValidCompletedAt(operation.completedAt))) {
    throw new CliError("批量回滚要求每条操作日志具有有效 completedAt");
  }
  if (operations.length > 1) {
    const completedAt = operations.map((operation) => operation.completedAt!);
    if (new Set(completedAt).size !== completedAt.length) {
      throw new CliError("批量回滚要求每条操作日志的 completedAt 唯一");
    }
  }
  return requestedEnvironment ?? environmentName;
}

function compareCompletedAt(left: OperationRecord, right: OperationRecord): number {
  const rightTime = Date.parse(right.completedAt!);
  const leftTime = Date.parse(left.completedAt!);
  return rightTime - leftTime;
}
