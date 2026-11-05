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
  diffGraphDrafts,
  exportGraphDrafts,
  planGraphImport,
  readGraphDraftFile,
  sanitizeImportOutput,
  summarizeImport,
  trimGraphDraftFile,
  validateGraphDrafts,
  verifyGraphImport,
  writeGraphDraftFile
} from "../domains/bpm-flow-graph/draft.js";
import { BPM_GRAPH_GUIDE } from "../domains/bpm-flow-graph/guide.js";
import { BPM_GRAPH_ERROR_CODES } from "../domains/bpm-flow-graph/diagnostics.js";
import {
  EXECUTOR_CODE_FIELDS,
  resolveExecutorBinding
} from "../domains/bpm-flow-graph/executor-resolver.js";
import {
  inspectGraphLayout,
  layoutGraphDraftFile
} from "../domains/bpm-flow-graph/layout.js";
import {
  CONDITION_EXPRESSION_CONTRACT,
  CONDITION_OPERATORS,
  CONDITION_PRIORITY,
  buildConditionExpression,
  loadFlowConditions
} from "../domains/bpm-flow-graph/conditions.js";
import {
  buildAndValidateConditionExpressions,
  readConditionExpressionMatrix,
  validateConditionExpression
} from "../domains/bpm-flow-graph/expression.js";
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
import { CliError, cliErrorDetails } from "../errors.js";

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
    .description("流程图配置：指导、条件、执行人解析、布局、导出、差异、校验与草稿导入")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm graph guide
  eadp bpm graph nodes
  eadp bpm graph nodes --kind Approve
  eadp bpm graph conditions --env dev --flow TBS_PROJECT
  eadp bpm graph expression --env dev --flow TBS_PROJECT --logic '文件类型=="信用-客户"'
  eadp bpm graph expression --env dev --flow TBS_PROJECT --file conditions.json
  eadp bpm graph resolve-executor --env dev --query 张三
  eadp bpm graph export --env dev --flow TBS_PROJECT --out tbs.json --trim
  eadp bpm graph layout --file tbs.json --write --check
  eadp bpm graph diff --file tbs.json --env ead --flow TBS_PROJECT
  eadp bpm graph validate --env ead --file tbs.json --strict
  eadp bpm graph import --env ead --flow TBS_PROJECT --file tbs.json
  eadp bpm graph import --env ead --flow TBS_PROJECT --file tbs.json --strict --apply

从独立业务输入配置时先运行 guide、nodes 和 conditions：conditions 列出目标环境业务实体
发布的系统判定条件字段，网关条件只能使用其中的变量；输入格式不限，但业务语义必须明确。
节点类型、执行人、条件、路径或驳回规则不能唯一确定时必须提问，不得猜测。
节点约束以 eadp bpm graph nodes 为准（能力表随 CLI 发布，不依赖外部源码）。
文件使用规范化图（页面/接口按 URL、人员按 code，不含环境内 ID）；
validate 同时给出 valid 与 designValid，--strict 时 designIssues 也视为失败。`
    );

  graph
    .command("guide")
    .description("输出独立业务输入的流程图配置最佳实践（不访问远端、不读取外部文件）")
    .addHelpText(
      "after",
      `
包含节点选择模式、执行人选择、条件/连线契约、待确认问题、校验与验收步骤。
业务输入不限文件格式；任何语义不确定都必须先提问，不能套用参考实现猜测。`
    )
    .action(() => {
      printValue(BPM_GRAPH_GUIDE, getRuntimeOptions(root).compact);
    });

  graph
    .command("nodes")
    .description("列出 CLI 内置节点约束、适用/不适用场景及待确认问题（不访问远端）")
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
必填配置、出入口规则、执行人要求与跨环境策略；usage 给出适用场景、
不适用场景、选择前所需信息和不确定时的追问，不需要外部源码。`
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
        errorCodes: BPM_GRAPH_ERROR_CODES,
        nodes: nodes.map(describeNodeRule)
      }, getRuntimeOptions(root).compact);
    });

  graph
    .command("conditions")
    .description("列出目标环境业务实体发布的系统判定条件字段（网关条件只能用这些变量）")
    .requiredOption("--env <name>", "环境名称")
    .requiredOption("--flow <code-or-name>", "流程类型 code、名称或 Entity code")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm graph conditions --env dev --flow TBS_PROJECT

输出条件字段的 code（表达式 groovyUel 使用的引擎变量）、name（logicUel 使用的中文名称）、
initValue 与 remark，并给出网关选型优先级：系统排他网关优先级最高。
条件字段不在此列表中的表达式，设计器保存时会校验失败。
取得字段后使用 eadp bpm graph expression 从 logicUel 生成并校验 groovyUel，不要分别手写。`
    )
    .action(async (options: GraphConditionsOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const catalog = await loadFlowConditions(client, options.flow);
      printValue({
        kind: "eadp.bpm.graph.conditions.v1",
        environment: resolved.name,
        flow: catalog.flow,
        businessEntity: catalog.businessEntity,
        conditions: catalog.conditions,
        operators: CONDITION_OPERATORS,
        expression: CONDITION_EXPRESSION_CONTRACT,
        priority: CONDITION_PRIORITY
      }, runtime.compact);
    });

  graph
    .command("expression")
    .description("根据中文条件生成 groovyUel，并调用目标环境的设计器同款 JUEL 校验")
    .requiredOption("--env <name>", "目标环境名称")
    .requiredOption("--flow <code-or-name>", "流程类型 code、名称或 Entity code")
    .option("--logic <expression>", "单条：使用条件字段 name 的中文表达式，如 文件类型==\"信用-客户\"")
    .option("--file <path>", "批量：JSON 条件矩阵（字符串数组或 { expressions: [{ key, logicUel }] }）")
    .addHelpText(
      "after",
      `
示例：
  eadp bpm graph expression --env dev --flow TBS_PROJECT --logic '文件类型=="信用-客户"'
  eadp bpm graph expression --env dev --flow TBS_PROJECT --logic '文件类型=="信用-客户"&&累计授信金额（客户）>=3000000'
  eadp bpm graph expression --env dev --flow TBS_PROJECT --file conditions.json

批量文件可写为 ["文件类型==\"信用-客户\""]，或
{ "expressions": [{ "key": "信用客户", "logicUel": "文件类型==\"信用-客户\"" }] }。
一次返回全部表达式对；相同 groovyUel 只调用一次服务端校验。--logic 与 --file 必须且只能提供一个。
只维护 logicUel；CLI 按条件字段清单自动生成 #{...} 形式的 groovyUel，再用
conBusinessEntity/validateExpression 和目标条件 initValue 校验。输出可直接作为
process.startUEL 或连线的 uel 字段。字符串字面量中的同名文本不会被替换。`
    )
    .action(async (options: GraphExpressionOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const catalog = await loadFlowConditions(client, options.flow);
      if (Boolean(options.logic) === Boolean(options.file)) {
        throw new CliError("--logic 与 --file 必须且只能提供一个", 1, {
          code: "INVALID_ARGUMENT",
          requiredInput: "logic|file"
        });
      }
      if (options.file) {
        const inputs = await readConditionExpressionMatrix(options.file);
        const batch = await buildAndValidateConditionExpressions(
          client,
          catalog.flowTypeId,
          catalog.conditions,
          inputs
        );
        if (batch.failed > 0) process.exitCode = 1;
        printValue({
          kind: "eadp.bpm.graph.expression.batch.v1",
          environment: resolved.name,
          flow: catalog.flow,
          businessEntity: catalog.businessEntity,
          ...batch,
          valid: batch.failed === 0,
          validatedBy: "conBusinessEntity/validateExpression",
          usage: "将每个 expression 对象用于对应连线的 uel；key 原样保留用于回写条件矩阵。"
        }, runtime.compact);
        return;
      }
      const expression = buildConditionExpression(options.logic!, catalog.conditions);
      await validateConditionExpression(client, catalog.flowTypeId, expression.groovyUel);
      printValue({
        kind: "eadp.bpm.graph.expression.v1",
        environment: resolved.name,
        flow: catalog.flow,
        businessEntity: catalog.businessEntity,
        expression,
        validated: true,
        validatedBy: "conBusinessEntity/validateExpression",
        usage: "将 expression 对象用于 process.startUEL 或系统排他/包容网关连线的 uel；默认路径不要配置表达式。"
      }, runtime.compact);
    });

  graph
    .command("resolve-executor")
    .description("按中文名或 code 唯一解析人员、岗位或岗位类别；0/多候选报错并列出候选")
    .requiredOption("--env <name>", "环境名称")
    .requiredOption("--query <name-or-code>", "人员 userName/name/code、岗位或岗位类别的 name/code")
    .addHelpText("after", `
示例：
  eadp bpm graph resolve-executor --env dev --query 张三
  eadp bpm graph resolve-executor --env dev --query P1001

返回 bindingType=Person/Position/PositionType 及可直接放入 executor 的 code 字段。
只使用已声明的 employee/findByPage、getPositionFindByPage 和 getListPositionCategory 接口，不执行写入。`)
    .action(async (options: GraphResolveExecutorOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const binding = await resolveExecutorBinding(client, options.query);
      const codeField = EXECUTOR_CODE_FIELDS[binding.bindingType];
      printValue({
        kind: "eadp.bpm.graph.executor.v1",
        environment: resolved.name,
        query: options.query.trim(),
        binding,
        codeField,
        executor: {
          type: binding.bindingType,
          userType: binding.bindingType,
          name: binding.name,
          [codeField]: [binding.code]
        }
      }, runtime.compact);
    });

  graph
    .command("export")
    .description("把一个流程类型下的最新设计稿导出为可移植 JSON 文件")
    .requiredOption("--env <name>", "源环境名称")
    .requiredOption("--flow <code-or-name>", "流程类型 code、名称或 Entity code")
    .requiredOption("--out <path>", "输出文件路径")
    .option("--trim", "只输出节点、边、条件与执行人，省略坐标、页面、接口和其他配置")
    .action(async (options: GraphExportOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const exported = await exportGraphDrafts(client, options.flow);
      const file = options.trim ? trimGraphDraftFile(exported) : exported;
      const out = resolve(options.out);
      await writeGraphDraftFile(out, file);
      printValue({
        kind: "eadp.bpm.graph.export.v1",
        environment: resolved.name,
        flow: file.flow,
        graphs: file.graphs.map((draft) => draft.name),
        trimmed: options.trim === true,
        out
      }, runtime.compact);
    });

  graph
    .command("layout")
    .description("检查流程图布局，或按拓扑分层自动布点；仅修改本地文件，不访问远端")
    .requiredOption("--file <path>", "流程图文件路径")
    .option("--check", "输出穿节点边数、交叉边数、重叠节点数和图总宽高")
    .option("--write", "按拓扑分层自动布点并覆盖本地文件；驳回边不参与前向分层")
    .addHelpText("after", `
示例：
  eadp bpm graph layout --file tbs.json --check
  eadp bpm graph layout --file tbs.json --write --check

不写 --check/--write 时默认 --check。--write 只修改节点已有 x/y 字段；
同层网关与审批节点水平排列，显式 isReverse 驳回边不改变前向拓扑层级。
同时提供 --write --check 时先写布局再检查，目标为穿节点/交叉/重叠均为 0。`)
    .action(async (options: GraphLayoutOptions) => {
      const runtime = getRuntimeOptions(root);
      const input = await readGraphDraftFile(options.file);
      const write = options.write === true;
      const check = options.check === true || !write;
      const file = write ? layoutGraphDraftFile(input) : input;
      if (write) await writeGraphDraftFile(options.file, file);
      const inspection = inspectGraphLayout(file);
      const clean = inspection.graphs.every((graph) =>
        graph.throughNodeEdges === 0 && graph.crossingEdges === 0 && graph.overlappingNodes === 0
      );
      if (check && !clean) process.exitCode = 1;
      printValue({
        kind: "eadp.bpm.graph.layout.v1",
        file: resolve(options.file),
        written: write,
        checked: check,
        clean,
        ...inspection
      }, runtime.compact);
    });

  graph
    .command("validate")
    .description("校验流程图文件的节点结构、设计器规则与目标依赖；不写入")
    .requiredOption("--env <name>", "目标环境名称")
    .requiredOption("--file <path>", "流程图文件路径")
    .option("--strict", "把设计器无法保存的图（designIssues）也视为校验失败并非零退出")
    .addHelpText("after", `
语义检查包括：排他网关条件重叠/全集覆盖、不可达节点、悬空边、非预期环、
重复 edge id、表达式边缺少 uel.name。问题计入 designIssues；--strict 时 valid=false。`)
    .action(async (options: GraphValidateOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const file = await readGraphDraftFile(options.file);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const result = await validateGraphDrafts(client, file, { strict: options.strict === true });
      if (!result.valid) process.exitCode = 1;
      printValue({
        kind: "eadp.bpm.graph.validation.v1",
        environment: resolved.name,
        ...result
      }, runtime.compact);
    });

  graph
    .command("diff")
    .description("只读比较本地规范化图与环境最新草稿；不执行写入")
    .requiredOption("--file <path>", "本地流程图文件 a.json")
    .requiredOption("--env <name>", "环境名称")
    .requiredOption("--flow <code>", "流程类型 code、名称或 Entity code")
    .action(async (options: GraphDiffOptions) => {
      const resolved = await requireBpmEnvironment(store, options.env);
      const runtime = getRuntimeOptions(root);
      const file = await readGraphDraftFile(options.file);
      const client = createGraphClient(resolved, runtime.timeoutMs);
      const result = await diffGraphDrafts(client, options.flow, file);
      printValue({
        kind: "eadp.bpm.graph.diff.v1",
        environment: resolved.name,
        file: resolve(options.file),
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
    .addHelpText("after", `
--apply 仍只调用 saveOrDeploy(deploy=false)，不会发布。
write 与 verify 独立输出 status/exitCode：回读失败时 write.status 仍为 success，
verify 输出回读节点/边数和本地差异摘要，命令退出码为 2；写入失败时 verify=skipped。`)
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
      const hasBlocked = plan.changes.some((change) => change.action === "blocked");
      if (hasBlocked) {
        process.exitCode = 1;
        printValue(sanitizeImportOutput({
          ...result,
          write: { status: "blocked", exitCode: 1, written: 0 },
          verify: { status: "skipped", exitCode: 1, reason: "存在 blocked 变更，未执行写入" }
        }), runtime.compact);
        return;
      }
      const recorder = new OperationRecorder(
        new OperationLogStore(store.directory),
        "eadp bpm graph import",
        resolved.name
      );
      try {
        await applyGraphImport(client, plan, recorder);
      } catch (error) {
        await recorder.fail(error);
        if (error instanceof CliError) {
          const details = cliErrorDetails(error);
          throw new CliError(error.message, error.exitCode, {
            ...details,
            detail: {
              write: { status: "failed", exitCode: error.exitCode },
              verify: { status: "skipped", exitCode: error.exitCode },
              server: details.detail
            }
          });
        }
        throw error;
      }
      // Writing and verification are deliberately separate operation states:
      // a read-back mismatch must never turn an already successful draft write
      // into a reported write failure.
      const operationId = await recorder.complete();
      const written = plan.changes.filter((change) =>
        change.action === "create" || change.action === "update"
      ).length;
      const verification = await verifyGraphImport(client, plan);
      process.exitCode = verification.verified ? 0 : 2;
      printValue(sanitizeImportOutput({
        ...result,
        applied: written > 0,
        verified: verification.verified,
        write: { status: written > 0 ? "success" : "skipped", exitCode: 0, written },
        verify: {
          status: verification.verified ? "success" : "failed",
          code: verification.verified ? undefined : "GRAPH_IMPORT_VERIFY_FAILED",
          exitCode: verification.verified ? 0 : 2,
          ...verification
        },
        ...(operationId === undefined ? {} : { operationId })
      }), runtime.compact);
    });
}

interface GraphResolveExecutorOptions {
  env: string;
  query: string;
}

interface GraphExportOptions {
  env: string;
  flow: string;
  out: string;
  trim?: boolean;
}

interface GraphNodesOptions {
  group?: string;
  kind?: string;
  includeLegacy?: boolean;
}

interface GraphConditionsOptions {
  env: string;
  flow: string;
}

interface GraphExpressionOptions extends GraphConditionsOptions {
  logic?: string;
  file?: string;
}

interface GraphLayoutOptions {
  file: string;
  check?: boolean;
  write?: boolean;
}

interface GraphValidateOptions {
  env: string;
  file: string;
  strict?: boolean;
}

interface GraphDiffOptions {
  env: string;
  flow: string;
  file: string;
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
