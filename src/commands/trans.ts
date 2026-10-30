import type { Command } from "commander";
import { ConfigStore } from "../config/store.js";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { executeTransLifecycle } from "../domains/trans/lifecycle.js";
import { transContract } from "../domains/trans/contract.js";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import { createResourceClient, type ResourceClient } from "../resource/core/client.js";
import { assertResourceTenant } from "../resource/core/engine.js";
import { getRuntimeOptions } from "../runtime-options.js";

interface TransLifecycleOptions {
  env: string;
  select: string;
  apply?: boolean;
}

export function registerTransCommands(root: Command, store: ConfigStore): void {
  const trans = root.command("trans").description("执行 EAI 通道发布与冻结；配置读写和迁移使用 resource trans");
  registerLifecycleCommand(trans, "publish", store, root);
  registerLifecycleCommand(trans, "freeze", store, root);
}

function registerLifecycleCommand(
  trans: Command,
  action: "publish" | "freeze",
  store: ConfigStore,
  root: Command
): void {
  trans
    .command(action)
    .description(`${action === "publish" ? "发布" : "冻结"}一个现有通道；默认预览，--apply 才执行并回查`)
    .requiredOption("--env <env>", "目标环境名称")
    .requiredOption("--select <code=value>", "通道选择器，格式 code=<code>")
    .option("--apply", `执行${action === "publish" ? "发布" : "冻结"}；默认预览`)
    .action(async (options: TransLifecycleOptions) => {
      const code = parseCodeSelector(options.select);
      const environment = resolveEnvironment(await store.load(), options.env);
      assertResourceTenant(transContract, environment.config.tenantCode, environment.name, "write");
      const runtime = getRuntimeOptions(root);
      const result = await executeTransLifecycle({
        environment,
        client: createClient(environment, runtime.timeoutMs),
        code,
        action,
        apply: options.apply === true,
        timeoutMs: runtime.timeoutMs
      });
      printValue(result, runtime.compact);
    });
}

function parseCodeSelector(value: string): string {
  const match = /^code=(.+)$/.exec(value);
  if (!match || !match[1]!.trim()) {
    throw new CliError("--select 格式无效，应为 code=<code>", 1, {
      code: "INVALID_ARGUMENT",
      requiredInput: "selector"
    });
  }
  return match[1]!.trim();
}

function createClient(environment: ResolvedEnvironment, timeoutMs: number): ResourceClient {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service: "sei-eai",
    timeoutMs
  });
}
