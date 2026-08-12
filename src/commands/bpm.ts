import type { Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { configureBpmProject } from "../bpm/configure.js";
import {
  discoverBpmProject,
  resolveBpmEntityCode,
  selectBpmFlow
} from "../bpm/discovery.js";
import { assertTenantScope } from "../tenant.js";
import type { ConfigStore } from "../config/store.js";
import { resolveEnvironment } from "../config/resolve.js";
import { printValue } from "../io.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
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
    .description("从真实项目代码发现 BPM 流程骨架及可选集成回调，不访问远端")
    .requiredOption("--project <path>", "业务项目根目录")
    .option("--flow <entity-class>", "仅按 Entity 全限定名显示指定流程")
    .addHelpText(
      "after",
      `
示例：
  eadp inspect bpm --project D:\\project\\sdh\\sdh-tbs

项目无需 YAML 或 BPM 登记册。CLI 从 BaseFlowController、Entity 和 API PATH 发现流程；
BPM 回调和 startDefaultFlow 均为可选，真实回调仅用于生成集成接口配置。`
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
    .requiredOption("--flow <entity-or-code>", "Entity 全限定名或远端 BPM 流程类型 code")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply bpm --project D:\\project\\sdh\\sdh-tbs --flow com.sdh.tbs.project.entity.Project
  eadp apply bpm --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT --apply

选择器只接受 Entity 全限定名或远端 BPM 流程类型 code，不按流程名称匹配。
安全规则：Entity 按全限定名唯一定位，页面和集成接口只按各自 URL 查重及关联；
已有配置复用，缺失项创建，关系只补差集，最后回查验证。`
    )
    .action(async (options: ApplyOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertTenantScope(resolved.config.tenantCode, "non-global", resolved.name);
      const runtime = getRuntimeOptions(root);
      const client = new BpmClient({
        baseUrl: resolved.config.baseUrl,
        token: resolved.token,
        authorization: resolved.authorization,
        timeoutMs: runtime.timeoutMs
      });
      const remote = {
        flowTypes: await client.findByPage("conFlowType"),
        entities: await client.findByPage("conBusinessEntity")
      };
      const requestedEntityCode = resolveBpmEntityCode(options.flow, remote);
      const definition = await discoverBpmProject(options.project, requestedEntityCode);
      const flow = selectBpmFlow(definition, options.flow, remote);
      const recorder = options.apply
        ? new OperationRecorder(
            new OperationLogStore(store.directory),
            "eadp apply bpm",
            resolved.name
          )
        : undefined;
      const result = await configureBpmProject({
        client,
        definition,
        flows: [flow],
        environment: resolved.name,
        apply: options.apply === true,
        ...(recorder ? { recorder } : {})
      });
      const operationId = await recorder?.complete();
      printValue(operationId ? { ...result, operationId } : result, runtime.compact);
    });
}
