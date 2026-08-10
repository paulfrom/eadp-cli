import type { Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { configureBpmProject } from "../bpm/configure.js";
import { discoverBpmProject, selectBpmFlow } from "../bpm/discovery.js";
import { assertTenantScope } from "../tenant.js";
import type { ConfigStore } from "../config/store.js";
import { resolveEnvironment } from "../config/resolve.js";
import { printValue } from "../io.js";
import { getRuntimeOptions } from "../runtime-options.js";
import type { VerbCommands } from "./verbs.js";

interface InspectOptions {
  project: string;
  flow?: string;
}

interface ApplyOptions {
  project: string;
  flow: string;
  env?: string;
  apply?: boolean;
}

export function registerBpmCommands(
  commands: Pick<VerbCommands, "inspect" | "apply">,
  store: ConfigStore,
  root: Command
): void {
  commands.inspect
    .command("bpm")
    .description("从真实项目代码发现有业务实现的 BPM 流程，不访问远端")
    .requiredOption("--project <path>", "业务项目根目录")
    .option("--flow <code-or-name>", "仅显示指定流程")
    .addHelpText(
      "after",
      `
示例：
  eadp inspect bpm --project D:\\project\\sdh\\sdh-tbs

项目无需 YAML 或 BPM 登记册。CLI 从 Controller、Entity、API PATH、真实 BPM 回调及
startDefaultFlow 调用发现流程；没有业务实现的空回调不会生成配置。`
    )
    .action(async (options: InspectOptions) => {
      const definition = await discoverBpmProject(options.project);
      const output = options.flow
        ? { ...definition, flows: [selectBpmFlow(definition, options.flow)] }
        : definition;
      printValue(output, getRuntimeOptions(root).compact);
    });

  commands.apply
    .command("bpm")
    .description("预览或幂等配置 BPM 基础数据")
    .requiredOption("--project <path>", "业务项目根目录")
    .requiredOption("--flow <code-or-name>", "流程代码、名称或 Entity 全限定名")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply bpm --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT
  eadp apply bpm --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT --apply

安全规则：按业务代码和 URL 查重；已有配置复用，缺失项创建，关系只补差集，最后回查验证。`
    )
    .action(async (options: ApplyOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertTenantScope(resolved.config.tenantCode, "non-global", resolved.name);
      const definition = await discoverBpmProject(options.project);
      const flow = selectBpmFlow(definition, options.flow);
      const runtime = getRuntimeOptions(root);
      const client = new BpmClient({
        baseUrl: resolved.config.baseUrl,
        token: resolved.token,
        timeoutMs: runtime.timeoutMs
      });
      const result = await configureBpmProject({
        client,
        definition,
        flows: [flow],
        environment: resolved.name,
        apply: options.apply === true
      });
      printValue(result, runtime.compact);
    });
}
