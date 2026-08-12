import { Command } from "commander";
import { CliError } from "../errors.js";
import { ConfigStore } from "../config/store.js";
import { printValue } from "../io.js";
import { getRuntimeOptions } from "../runtime-options.js";
import { fetchTenantCode } from "../tenant.js";

export function registerEnvironmentCommands(program: Command, store: ConfigStore): void {
  const env = program.command("env").description("管理 EADP 环境");

  env
    .command("add")
    .argument("<name>", "环境名称")
    .requiredOption("--url <url>", "环境基础 URL")
    .option("--token <token>", "该环境使用的 x-api-token")
    .option("--token-env <variable>", "从环境变量读取 Token")
    .option("--default", "添加后设为默认环境")
    .description("新增或更新环境并验证 Token")
    .action(
      async (
        name: string,
        options: {
          url: string;
          token?: string;
          tokenEnv?: string;
          default?: boolean;
        }
      ) => {
      if (Boolean(options.token) === Boolean(options.tokenEnv)) {
        throw new CliError("必须且只能指定 --token 或 --token-env");
      }
      const baseUrl = new URL(options.url).toString().replace(/\/$/, "");
      const token = options.token ?? process.env[options.tokenEnv!];
      if (!token) {
        throw new CliError(
          options.tokenEnv
            ? `环境变量未设置：${options.tokenEnv}`
            : "Token 不能为空"
        );
      }
      const runtime = getRuntimeOptions(program);
      const tenantCode = await fetchTenantCode({
        baseUrl,
        token,
        timeoutMs: runtime.timeoutMs
      });
      await store.update((config) => {
        config.environments[name] = {
          baseUrl,
          tenantCode,
          ...(options.token ? { token: options.token } : { tokenEnv: options.tokenEnv! })
        };
        if (options.default || !config.currentEnvironment) {
          config.currentEnvironment = name;
        }
      });
      printValue(
        { success: true, environment: name, baseUrl, tenantCode },
        runtime.compact
      );
    });

  env
    .command("list")
    .description("列出环境")
    .action(async () => {
      const config = await store.load();
      printValue(
        Object.entries(config.environments).map(([name, item]) => ({
          name,
          baseUrl: item.baseUrl,
          tenantCode: item.tenantCode ?? null,
          default: config.currentEnvironment === name,
          tokenSource: item.authorization
            ? "config:authorization"
            : item.tokenEnv
              ? `env:${item.tokenEnv}`
              : item.token
                ? "config:token"
                : "unconfigured"
        })),
        getRuntimeOptions(program).compact
      );
    });

  env
    .command("use")
    .argument("<name>", "环境名称")
    .description("切换默认环境")
    .action(async (name: string) => {
      await store.update((config) => {
        if (!config.environments[name]) {
          throw new CliError(`环境不存在：${name}`);
        }
        config.currentEnvironment = name;
      });
      printValue(
        { success: true, defaultEnvironment: name },
        getRuntimeOptions(program).compact
      );
    });

  env
    .command("remove")
    .argument("<name>", "环境名称")
    .description("移除环境及其本地 URL 和 Token 配置")
    .action(async (name: string) => {
      const config = await store.update((current) => {
        if (!current.environments[name]) {
          throw new CliError(`环境不存在：${name}`);
        }
        delete current.environments[name];
        if (current.currentEnvironment === name) {
          delete current.currentEnvironment;
        }
      });
      printValue(
        {
          success: true,
          removedEnvironment: name,
          defaultEnvironment: config.currentEnvironment ?? null
        },
        getRuntimeOptions(program).compact
      );
    });
}
