import { Command } from "commander";
import { CliError } from "../errors.js";
import { ConfigStore } from "../config/store.js";
import { printValue } from "../io.js";

export function registerEnvironmentCommands(program: Command, store: ConfigStore): void {
  const env = program.command("env").description("管理 EADP 环境");

  env
    .command("add")
    .argument("<name>", "环境名称")
    .requiredOption("--url <url>", "环境基础 URL")
    .option("--token <token>", "该环境使用的 x-api-token")
    .option("--token-env <variable>", "从环境变量读取 Token")
    .option("--default", "添加后设为默认环境")
    .description("新增或更新环境")
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
      await store.update((config) => {
        config.environments[name] = {
          baseUrl,
          ...(options.token ? { token: options.token } : { tokenEnv: options.tokenEnv! })
        };
        if (options.default || !config.currentEnvironment) {
          config.currentEnvironment = name;
        }
      });
      printValue({ success: true, environment: name, baseUrl });
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
          default: config.currentEnvironment === name,
          tokenSource: item.tokenEnv ? `env:${item.tokenEnv}` : "config:***"
        }))
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
      printValue({ success: true, defaultEnvironment: name });
    });
}
