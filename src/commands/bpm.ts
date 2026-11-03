import type { Command } from "commander";
import { resolve } from "node:path";
import { BpmClient } from "../domains/bpm/client.js";
import { configureBpmProject } from "../domains/bpm/configure.js";
import {
  discoverBpmProject,
  resolveBpmEntityCode,
  selectBpmFlow
} from "../domains/bpm/discovery.js";
import {
  applyGraphImport,
  exportGraphDrafts,
  planGraphImport,
  readGraphDraftFile,
  sanitizeImportOutput,
  summarizeImport,
  validateGraphDrafts,
  verifyGraphImport,
  writeGraphDraftFile
} from "../domains/bpm-flow-graph/draft.js";
import {
  CATALOG_VERSION,
  describeNodeRule,
  listNodeRules
} from "../domains/bpm-flow-graph/node-catalog.js";
import { createResourceClient } from "../resource/core/client.js";
import { assertTenantScope } from "../tenant.js";
import type { ConfigStore } from "../config/store.js";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { printValue } from "../io.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import { getRuntimeOptions } from "../runtime-options.js";
import { CliError } from "../errors.js";

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
  store: ConfigStore,
  root: Command
): void {
  const bpm = root
    .command("bpm")
    .description("从项目代码发现并配置 BPM 流程基础数据");

  bpm
    .command("inspect")
    .description("从真实项目代码发现 BPM 流程骨架及可选集成回调，不访问远端")
    .requiredOption("--project <path>", "业务项目根目录")
    .option("--flow <entity-class>", "仅按 Entity 全限定名显示指定流程")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm inspect --project D:\\project\\sdh\\sdh-tbs

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

  bpm
    .command("configure")
    .description("预览或幂等配置 BPM 基础数据")
    .requiredOption("--project <path>", "业务项目根目录")
    .requiredOption("--flow <entity-or-code>", "Entity 全限定名或远端 BPM 流程类型 code")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出预览")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm configure --project D:\\project\\sdh\\sdh-tbs --flow com.sdh.tbs.project.entity.Project
  eadp bpm configure --project D:\\project\\sdh\\sdh-tbs --flow TBS_PROJECT --apply

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
            "eadp bpm configure",
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

  const graph = bpm
    .command("graph")
    .description("流程图文件通道：节点能力、导出、校验、导入（只写草稿，不发布）")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm graph nodes
  eadp bpm graph export --env dev --flow TBS_PROJECT --out tbs.json
  eadp bpm graph validate --env ead --file tbs.json
  eadp bpm graph validate --env ead --file tbs.json --strict
  eadp bpm graph import --env ead --flow TBS_PROJECT --file tbs.json
  eadp bpm graph import --env ead --flow TBS_PROJECT --file tbs.json --apply

节点约束以 eadp bpm graph nodes 为准（能力表随 CLI 发布，不依赖外部源码）。
导出的文件是规范化图（页面/接口按 URL、人员按 code，不含环境内 ID），
可以直接在另一个环境导入；validate 同时给出 valid（能否搬运）与
designValid（设计器能否保存），--strict 时 designIssues 也视为失败。`
    );

  graph
    .command("nodes")
    .description("列出 CLI 内置的 BPM 节点能力表（不访问远端、不读取外部源码）")
    .option("--group <group>", "仅显示 task、event 或 gateway")
    .option("--kind <kind>", "仅显示指定节点，如 Approve、ManualExclusiveGateway")
    .option("--include-legacy", "同时显示 MailTask 等历史节点")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm graph nodes
  eadp bpm graph nodes --group task
  eadp bpm graph nodes --kind Approve

节点能力表随 CLI 一起发布，包含引擎 type、nodeType/busType 存放位置、
必填配置、出入口规则、执行人要求与跨环境策略，不需要外部源码。`
    )
    .action((options: GraphNodesOptions) => {
      if (options.group && !["task", "event", "gateway"].includes(options.group)) {
        throw new CliError(`未知节点分组：${options.group}`, 1, {
          code: "INVALID_ARGUMENT",
          candidates: ["task", "event", "gateway"]
        });
      }
      const nodes = listNodeRules({
        ...(options.group ? { group: options.group } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        includeLegacy: options.includeLegacy === true
      });
      if (options.kind && nodes.length === 0) {
        throw new CliError(`未知节点类型：${options.kind}`, 1, {
          code: "INVALID_ARGUMENT",
          requiredInput: "kind"
        });
      }
      printValue({
        kind: "eadp.bpm.graph.nodes.v1",
        catalogVersion: CATALOG_VERSION,
        nodes: nodes.map(describeNodeRule)
      }, getRuntimeOptions(root).compact);
    });

  graph
    .command("export")
    .description("把一个流程类型下的最新设计稿导出为可移植 JSON 文件")
    .requiredOption("--env <name>", "源环境名称")
    .requiredOption("--flow <code-or-name>", "流程类型 code、名称或 Entity code")
    .requiredOption("--out <path>", "输出文件路径")
    .action(async (options: GraphExportOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const file = await exportGraphDrafts(client, options.flow);
      const out = resolve(options.out);
      await writeGraphDraftFile(out, file);
      printValue({
        kind: "eadp.bpm.graph.export.v1",
        environment: resolved.name,
        flow: file.flow,
        graphs: file.graphs.map((draft) => draft.name),
        out
      }, runtime.compact);
    });

  graph
    .command("validate")
    .description("校验流程图文件的节点结构、设计器规则与目标依赖；不写入")
    .requiredOption("--env <name>", "目标环境名称")
    .requiredOption("--file <path>", "流程图文件路径")
    .option("--strict", "把设计器无法保存的图（designIssues）也视为校验失败")
    .action(async (options: GraphValidateOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const file = await readGraphDraftFile(options.file);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const result = await validateGraphDrafts(client, file, { strict: options.strict === true });
      printValue({
        kind: "eadp.bpm.graph.validation.v1",
        environment: resolved.name,
        ...result
      }, runtime.compact);
    });

  graph
    .command("import")
    .description("把流程图文件导入目标环境草稿；默认预览，--apply 写入并回查")
    .requiredOption("--env <name>", "目标环境名称")
    .requiredOption("--flow <code-or-name>", "目标流程类型 code、名称或 Entity code")
    .requiredOption("--file <path>", "流程图文件路径")
    .option("--apply", "写入草稿；不提供时仅输出变更计划")
    .option("--strict", "设计器无法保存的图（designIssues）也拒绝导入")
    .action(async (options: GraphImportOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const file = await readGraphDraftFile(options.file);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const plan = await planGraphImport(client, options.flow, file, {
        strict: options.strict === true
      });
      const apply = options.apply === true;
      const result = {
        kind: "eadp.bpm.graph.import.v1",
        environment: resolved.name,
        flow: plan.flow,
        applied: false,
        verified: apply ? false : undefined,
        changes: plan.changes,
        summary: summarizeImport(plan)
      };
      if (!apply) {
        printValue(sanitizeImportOutput(result), runtime.compact);
        return;
      }
      const recorder = new OperationRecorder(
        new OperationLogStore(store.directory),
        "eadp bpm graph import",
        resolved.name
      );
      try {
        await applyGraphImport(client, plan, recorder);
        const verified = await verifyGraphImport(client, plan);
        if (!verified) throw new CliError("流程图导入后回查失败");
        const operationId = await recorder.complete();
        printValue(sanitizeImportOutput({
          ...result,
          applied: plan.changes.some((change) => change.action === "create" || change.action === "update"),
          verified,
          ...(operationId === undefined ? {} : { operationId })
        }), runtime.compact);
      } catch (error) {
        await recorder.fail(error);
        throw error;
      }
    });
}

interface GraphExportOptions {
  env: string;
  flow: string;
  out: string;
}

interface GraphNodesOptions {
  group?: string;
  kind?: string;
  includeLegacy?: boolean;
}

interface GraphValidateOptions {
  env: string;
  file: string;
  strict?: boolean;
}

interface GraphImportOptions {
  env: string;
  flow: string;
  file: string;
  apply?: boolean;
  strict?: boolean;
}

async function requireBpmEnvironment(
  store: ConfigStore,
  name: string
): Promise<ResolvedEnvironment> {
  const resolved = resolveEnvironment(await store.load(), name);
  assertTenantScope(resolved.config.tenantCode, "non-global", resolved.name);
  return resolved;
}

function createGraphClient(environment: ResolvedEnvironment, timeoutMs: number) {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service: "sei-bpm",
    timeoutMs
  });
}
