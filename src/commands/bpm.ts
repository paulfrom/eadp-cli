import type { Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { configureBpmProject } from "../bpm/configure.js";
import { discoverBpmProject, selectBpmFlow } from "../bpm/discovery.js";
import { assertTenantScope } from "../tenant.js";
import type { ConfigStore } from "../config/store.js";
import { resolveEnvironment } from "../config/resolve.js";
import { printValue } from "../io.js";

interface InspectOptions {
  project: string;
  flow?: string;
  compact?: boolean;
}

interface ConfigureOptions {
  project: string;
  flow: string;
  env?: string;
  apply?: boolean;
  compact?: boolean;
  timeout?: string;
}

export function registerBpmCommands(program: Command, store: ConfigStore): void {
  const bpm = program
    .command("bpm")
    .description("从真实项目发现并配置 EADP BPM 基础数据")
    .addHelpText(
      "after",
      `
全新上下文推荐流程：
  1. eadp bpm inspect --project <项目路径>
  2. eadp bpm configure --project <项目路径> --flow <流程代码>
  3. 确认预览后追加 --apply；命令会自动查重、关联并回查

项目无需 YAML。CLI 读取现有 BPM 登记册，并结合 Gradle 与前端项目元数据识别业务模块。`
    );

  bpm
    .command("inspect")
    .description("从真实项目登记册发现可配置流程，不访问远端")
    .requiredOption("--project <path>", "业务项目根目录")
    .option("--flow <code-or-name>", "仅显示指定流程")
    .option("--compact", "输出单行 JSON")
    .action(async (options: InspectOptions) => {
      const definition = await discoverBpmProject(options.project);
      const output = options.flow
        ? { ...definition, flows: [selectBpmFlow(definition, options.flow)] }
        : definition;
      printValue(output, options.compact);
    });

  bpm
    .command("configure")
    .description("幂等配置业务模块、实体、页面、接口、关联关系和流程类型")
    .requiredOption("--project <path>", "业务项目根目录")
    .requiredOption("--flow <code-or-name>", "流程代码、名称或 Entity 全限定名")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出预览")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm configure --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT
  eadp bpm configure --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT --apply

安全规则：按业务代码和 URL 查重；已有配置复用，缺失项创建，关系只补差集，最后回查验证。`
    )
    .action(async (options: ConfigureOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertTenantScope(resolved.config.tenantCode, "non-global", resolved.name);
      const definition = await discoverBpmProject(options.project);
      const flow = selectBpmFlow(definition, options.flow);
      const timeoutMs = Number(options.timeout);
      const client = new BpmClient({
        baseUrl: resolved.config.baseUrl,
        token: resolved.token,
        timeoutMs
      });
      const result = await configureBpmProject({
        client,
        definition,
        flows: [flow],
        environment: resolved.name,
        apply: options.apply === true
      });
      printValue(result, options.compact);
    });
}
