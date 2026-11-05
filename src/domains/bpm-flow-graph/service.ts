import { CliError } from "../../errors.js";
import { isRecord, type ResourceClient, type ResourceRecord } from "../../resource/core/client.js";
import {
  DependencyResolutionError,
  RecordMappingError,
  type BlockingIssue,
  type MissingDependency
} from "../../resource/core/errors.js";
import type {
  ResourceAggregatePlan,
  ResourceAggregatePlanContext,
  ResourceApplyContext,
  ResourcePhaseHooks,
  ResourcePlanChange,
  ResourceVerifyContext
} from "../../resource/core/engine.js";
import { selectFlow } from "../bpm/selection.js";
import { inspectCanonicalGraph } from "./analysis.js";
import { hydrate, toCanonical } from "./graph.js";
import { graphReferences, type BpmGraphReferences } from "./references.js";
import { mapGraphServerError } from "./server-errors.js";

type RecordValue = Record<string, unknown>;

/** BPM graph migration hooks: aggregate planning, draft write, draft read-back. */
export const bpmFlowGraphPhaseHooks: ResourcePhaseHooks = {
  aggregatePlan: planFlowGraphs,
  apply: applyFlowGraphs,
  verify: verifyFlowGraphs
};

async function planFlowGraphs(
  context: ResourceAggregatePlanContext
): Promise<ResourceAggregatePlan> {
  const selector = context.selectors.flow?.trim();
  if (!selector) {
    throw new CliError(
      "resource bpm-flow-graph compare/sync 必须提供 --select flow=<流程类型 code/名称/Entity code>",
      1,
      { code: "REQUIRED_SELECTOR_MISSING", requiredInput: "selector" }
    );
  }

  const sourceRefs = graphReferences(context.sourceClient);
  const targetRefs = graphReferences(context.targetClient);
  const sourceFlows = await sourceRefs.flowTypes();
  const sourceEntities = await sourceRefs.businessEntities();
  const sourceFlow = selectFlow(sourceFlows, sourceEntities, selector);
  const flowCode = requiredMappedText(sourceFlow.code, "源流程类型缺少 code");
  const sourceFlowId = requiredMappedText(sourceFlow.id, "源流程类型缺少 ID");

  const sourceDefinitions = (await sourceRefs.flowDefinitions())
    .filter((definition) => definition.flowTypeId === sourceFlowId);
  if (sourceDefinitions.length === 0) {
    return {
      changes: [blockedChange(`${flowCode}`, [{
        resource: "defFlowDefinition",
        field: "flowTypeId",
        reason: "invalid",
        value: sourceFlowId,
        message: `源流程类型 ${flowCode} 下没有流程图定义`
      }])],
      details: {
        graphReadiness: {
          flow: flowCode,
          sourceDefinitions: 0,
          targetDefinitions: 0,
          definitions: [],
          state: "source-empty"
        },
        nextActions: [{
          action: "DRAW_IN_DESIGNER",
          message: "源环境没有设计稿，无法从零建图；请先在 BPM 设计器落稿，或使用 bpm graph import 导入文件"
        }]
      }
    };
  }

  const targetFlows = await targetRefs.flowTypes();
  const targetFlowMatches = targetFlows.filter((flow) => sameText(flow.code, flowCode));
  const targetFlow = targetFlowMatches.length === 1 ? targetFlowMatches[0]! : undefined;
  const targetFlowDependency = targetFlowMatches.length === 1
    ? undefined
    : dependency("conFlowType", flowCode, targetFlowMatches.length);
  const targetDefinitions = targetFlow
    ? (await targetRefs.flowDefinitions()).filter((definition) => definition.flowTypeId === targetFlow.id)
    : [];

  const nameCounts = new Map<string, number>();
  for (const definition of sourceDefinitions) {
    const name = textValue(definition.name);
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const changes: ResourcePlanChange[] = [];
  const graphWarnings: BlockingIssue[] = [];
  for (const sourceDefinition of sourceDefinitions) {
    const name = textValue(sourceDefinition.name);
    const key = name ? `${flowCode}/${name}` : `${flowCode}/<缺少名称>`;
    if (!name) {
      changes.push(blockedChange(key, [{
        resource: "defFlowDefinition",
        field: "name",
        reason: "invalid",
        value: textValue(sourceDefinition.id) ?? null,
        message: "源流程定义缺少名称"
      }]));
      continue;
    }
    if ((nameCounts.get(name) ?? 0) > 1) {
      changes.push(blockedChange(key, [{
        resource: "defFlowDefinition",
        field: "name",
        reason: "ambiguous",
        value: name,
        message: `源流程类型 ${flowCode} 下存在同名流程定义：${name}`
      }]));
      continue;
    }

    const beforeMatches = targetDefinitions.filter((definition) => sameText(definition.name, name));
    if (beforeMatches.length > 1) {
      changes.push(blockedChange(key, [{
        resource: "defFlowDefinition",
        field: "name",
        reason: "ambiguous",
        value: name,
        message: `目标流程类型 ${flowCode} 下存在同名流程定义：${name}`
      }]));
      continue;
    }
    const targetDefinition = beforeMatches[0];
    const before = targetDefinition
      ? { flow: flowCode, name, graph: await readTargetGraph(context.targetClient, targetRefs, targetDefinition) }
      : null;

    if (targetFlowDependency) {
      changes.push(blockedChange(key, [], [targetFlowDependency], before));
      continue;
    }

    try {
      const sourceDefinitionId = requiredMappedText(sourceDefinition.id, "源流程定义缺少 ID");
      const sourceDesign = await readFlowDesign(context.sourceClient, sourceDefinitionId);
      const sourceJson = designJson(sourceDesign, `源流程定义 ${name} 没有设计稿`);
      const graph = await toCanonical(sourceJson, sourceRefs);
      graphWarnings.push(...inspectCanonicalGraph(graph).warnings);
      const beforeGraph = before && typeof before.graph === "string" ? before.graph : null;

      if (beforeGraph !== null && graph === beforeGraph) {
        changes.push({
          key,
          action: "unchanged",
          changedFields: [],
          before,
          desired: { flow: flowCode, name, graph },
          id: targetDefinition ? textValue(targetDefinition.id) ?? null : null
        });
        continue;
      }

      try {
        await hydrate(graph, targetRefs, {
          flowTypeId: requiredMappedText(targetFlow!.id, "目标流程类型缺少 ID"),
          ...(targetDefinition ? { targetDefinition } : {})
        });
      } catch (error) {
        if (error instanceof DependencyResolutionError) {
          changes.push(blockedChange(key, [], error.missingDependencies, before));
          continue;
        }
        if (error instanceof RecordMappingError) {
          changes.push(blockedChange(key, error.blockingIssues, [], before));
          continue;
        }
        throw error;
      }

      changes.push({
        key,
        action: targetDefinition ? "update" : "create",
        changedFields: ["graph"],
        before,
        desired: { flow: flowCode, name, graph },
        id: targetDefinition ? textValue(targetDefinition.id) ?? null : null
      });
    } catch (error) {
      if (error instanceof RecordMappingError) {
        changes.push(blockedChange(key, error.blockingIssues, [], before));
        continue;
      }
      if (error instanceof DependencyResolutionError) {
        changes.push(blockedChange(key, [], error.missingDependencies, before));
        continue;
      }
      throw error;
    }
  }

  return {
    changes,
    details: {
      ...buildGraphDetails({
        flowCode,
        sourceDefinitions,
        targetDefinitions,
        changes
      }),
      ...(graphWarnings.length === 0 ? {} : { graphWarnings: dedupeIssues(graphWarnings) })
    }
  };
}

function buildGraphDetails(options: {
  flowCode: string;
  sourceDefinitions: ResourceRecord[];
  targetDefinitions: ResourceRecord[];
  changes: ResourcePlanChange[];
}): Record<string, unknown> {
  const definitions = options.sourceDefinitions
    .map((definition) => textValue(definition.name))
    .filter((name): name is string => name !== undefined);
  const state = options.sourceDefinitions.length === 0
    ? "source-empty"
    : options.targetDefinitions.length === 0
      ? "source-only"
      : "ready";
  const nextActions: Record<string, unknown>[] = [];
  const blocked = options.changes.filter((change) => change.action === "blocked");
  const missing = new Set<string>();
  for (const change of blocked) {
    for (const dependency of change.missingDependencies ?? []) missing.add(dependency.resource);
  }
  if (missing.size > 0) {
    nextActions.push({
      action: "CREATE_DEPENDENCIES",
      resources: [...missing].sort(),
      message: "目标环境缺少图引用的页面/接口/人员/岗位等；补齐后重新预览"
    });
  }
  if (blocked.some((change) =>
    (change.blockingIssues ?? []).some((issue) => issue.message.includes("CallActivity")))) {
    nextActions.push({
      action: "REMOVE_CALL_ACTIVITY",
      message: "v1 不支持子流程；请在 BPM 设计器中展开子流程或移除该节点"
    });
  }
  if (blocked.some((change) =>
    (change.blockingIssues ?? []).some((issue) => issue.message.includes("ProjectPosition")))) {
    nextActions.push({
      action: "REPLACE_PROJECT_POSITION",
      message: "v1 不支持项目岗位；请改用可跨环境映射的岗位/岗位类别/人员"
    });
  }
  if (blocked.some((change) =>
    (change.blockingIssues ?? []).some((issue) => issue.message.includes("智能审核")))) {
    nextActions.push({
      action: "REMOVE_SMART_AUDIT",
      message: "v1 不支持智能审核/规则检查；请在 BPM 设计器中移除相关配置"
    });
  }
  if (options.changes.some((change) => change.action === "create" || change.action === "update")) {
    nextActions.push({
      action: "PUBLISH_IN_DESIGNER",
      message: "同步只写草稿；需要生效时在 BPM 设计器发布该流程"
    });
  }
  return {
    graphReadiness: {
      flow: options.flowCode,
      sourceDefinitions: options.sourceDefinitions.length,
      targetDefinitions: options.targetDefinitions.length,
      definitions,
      state
    },
    nextActions
  };
}

async function applyFlowGraphs(
  writable: ResourcePlanChange[],
  client: ResourceClient,
  context: ResourceApplyContext
): Promise<void> {
  const refs = graphReferences(client);
  for (const change of writable) {
    if (change.action !== "create" && change.action !== "update") continue;
    if (!change.desired) throw new CliError(`流程图变更 ${change.key} 缺少待写入数据`);
    const flow = requiredField(change.desired, "flow", `流程图变更 ${change.key} 缺少 flow`);
    const name = requiredField(change.desired, "name", `流程图变更 ${change.key} 缺少 name`);
    const graph = requiredField(change.desired, "graph", `流程图变更 ${change.key} 缺少 graph`);
    const targetFlow = await resolveTargetFlowType(refs, flow);
    const flowTypeId = requiredField(targetFlow, "id", "目标流程类型缺少 ID");
    const targetDefinition = change.action === "update"
      ? await findTargetDefinition(refs, flowTypeId, name)
      : undefined;
    if (change.action === "update" && !targetDefinition) {
      throw new CliError(`目标流程定义 ${flow}/${name} 不存在，不能执行更新`);
    }

    const defJson = await hydrate(graph, refs, {
      flowTypeId,
      ...(targetDefinition ? { targetDefinition } : {})
    });
    let saved: unknown;
    try {
      saved = await client.invoke("defFlowVersion/saveOrDeploy", "POST", {
        defJson,
        deploy: false
      });
    } catch (error) {
      throw mapGraphServerError(error, { name, canonical: graph });
    }
    if (!isRecord(saved)) {
      throw new CliError("defFlowVersion/saveOrDeploy 返回格式无效");
    }
    const definitionId = requiredField(saved, "flowDefinitionId",
      "defFlowVersion/saveOrDeploy 未返回 flowDefinitionId");
    change.id = definitionId;
    refs.invalidateFlowDefinitions();

    if (change.action === "create" && context.recorder) {
      await context.recorder.recordAction({
        type: "create-entity",
        service: "sei-bpm",
        resource: "defFlowDefinition",
        entityId: definitionId,
        expected: { id: definitionId, name, flowTypeId },
        deleteMethod: "DELETE",
        remove: {
          path: "defFlowDefinition/delete/{id}",
          method: "DELETE",
          idField: "id",
          idPlacement: "path"
        },
        tenantPolicy: "non-global"
      });
    }
  }
}

async function verifyFlowGraphs(
  client: ResourceClient,
  context: ResourceVerifyContext
): Promise<boolean> {
  const refs = graphReferences(client);
  for (const change of context.plan.changes) {
    if (change.action === "blocked" || change.action === "delete") continue;
    if (!change.desired) return false;
    const flow = textValue(change.desired.flow);
    const name = textValue(change.desired.name);
    const graph = textValue(change.desired.graph);
    if (!flow || !name || !graph) return false;

    let definitionId = textValue(change.id);
    if (!definitionId) {
      const targetFlows = await refs.flowTypes();
      const targetFlowMatches = targetFlows.filter((item) => sameText(item.code, flow));
      if (targetFlowMatches.length !== 1) return false;
      const flowTypeId = textValue(targetFlowMatches[0]!.id);
      if (!flowTypeId) return false;
      const definitions = (await refs.flowDefinitions())
        .filter((definition) => definition.flowTypeId === flowTypeId && sameText(definition.name, name));
      if (definitions.length !== 1) return false;
      definitionId = textValue(definitions[0]!.id);
      if (!definitionId) return false;
    }
    const design = await readFlowDesign(client, definitionId);
    const defJson = design?.defJson;
    if (typeof defJson !== "string" || defJson.trim() === "") return false;
    const actual = await canonicalizeTarget(defJson, refs);
    if (actual !== graph) return false;
  }
  return true;
}

/** Keep terminal output small: only graph size is shown, never the whole draft. */
export function sanitizeBpmFlowGraphOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBpmFlowGraphOutput);
  if (!isRecord(value)) return value;
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === "before" || key === "desired") && isRecord(child)) {
      const sanitized = { ...child };
      if (typeof sanitized.graph === "string") {
        sanitized.graph = summarizeGraph(sanitized.graph);
      }
      result[key] = sanitizeBpmFlowGraphOutput(sanitized);
      continue;
    }
    result[key] = sanitizeBpmFlowGraphOutput(child);
  }
  return result;
}

async function readTargetGraph(
  client: ResourceClient,
  refs: BpmGraphReferences,
  definition: ResourceRecord
): Promise<string | null> {
  const definitionId = textValue(definition.id);
  if (!definitionId) return null;
  const design = await readFlowDesign(client, definitionId);
  const defJson = design?.defJson;
  if (typeof defJson !== "string" || defJson.trim() === "") return null;
  return canonicalizeTarget(defJson, refs);
}

async function canonicalizeTarget(
  defJson: string,
  refs: BpmGraphReferences
): Promise<string> {
  try {
    return await toCanonical(defJson, refs);
  } catch (error) {
    // A target draft may still contain unsupported content that the next
    // update is about to replace. It is only a "before" value, so fall back to
    // its raw JSON instead of blocking the migration.
    if (error instanceof RecordMappingError || error instanceof DependencyResolutionError) {
      return defJson;
    }
    throw error;
  }
}

export async function readFlowDesign(
  client: ResourceClient,
  definitionId: string
): Promise<ResourceRecord | null> {
  const data = await client.invoke("defFlowVersion/getFlowDesign", "POST", {
    flowDefinitionId: definitionId,
    versionCode: -1
  });
  if (data === null || data === undefined) return null;
  if (!isRecord(data)) throw new CliError("defFlowVersion/getFlowDesign 返回格式无效");
  return data;
}

async function resolveTargetFlowType(
  refs: BpmGraphReferences,
  flowCode: string
): Promise<ResourceRecord> {
  const flows = await refs.flowTypes();
  const matches = flows.filter((flow) => sameText(flow.code, flowCode));
  if (matches.length !== 1) {
    throw new CliError(
      `目标环境流程类型 ${flowCode} ${matches.length === 0 ? "不存在" : "不唯一"}`
    );
  }
  return matches[0]!;
}

async function findTargetDefinition(
  refs: BpmGraphReferences,
  flowTypeId: string,
  name: string
): Promise<ResourceRecord | undefined> {
  const matches = (await refs.flowDefinitions())
    .filter((definition) => definition.flowTypeId === flowTypeId && sameText(definition.name, name));
  if (matches.length > 1) throw new CliError(`目标流程定义 ${name} 不唯一`);
  return matches[0];
}

function designJson(design: ResourceRecord | null, message: string): string {
  const defJson = design?.defJson;
  if (typeof defJson !== "string" || defJson.trim() === "") {
    throw new RecordMappingError([{
      resource: "defFlowVersion",
      field: "defJson",
      reason: "invalid",
      message
    }]);
  }
  return defJson;
}

function blockedChange(
  key: string,
  blockingIssues: BlockingIssue[],
  missingDependencies: MissingDependency[] = [],
  before: RecordValue | null = null
): ResourcePlanChange {
  return {
    key,
    action: "blocked",
    changedFields: [],
    before,
    desired: null,
    ...(blockingIssues.length > 0 ? { blockingIssues } : {}),
    ...(missingDependencies.length > 0 ? { missingDependencies } : {})
  };
}

function dependency(resource: string, value: string, matches: number): MissingDependency {
  return {
    resource,
    identityField: "code",
    value,
    reason: matches > 1 ? "ambiguous" : "missing"
  };
}

function summarizeGraph(graph: string): RecordValue {
  let nodes = 0;
  try {
    const parsed = JSON.parse(graph) as unknown;
    if (isRecord(parsed) && isRecord(parsed.process) && isRecord(parsed.process.nodes)) {
      nodes = Object.keys(parsed.process.nodes).length;
    }
  } catch {
    nodes = 0;
  }
  return { nodes, chars: graph.length };
}

function requiredMappedText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RecordMappingError([{
      resource: "bpm-flow-graph",
      field: "graph",
      reason: "invalid",
      message
    }]);
  }
  return value;
}

function requiredField(record: RecordValue, field: string, message: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") throw new CliError(message);
  return value;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function sameText(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim() === expected.trim();
}

function dedupeIssues(issues: BlockingIssue[]): BlockingIssue[] {
  const seen = new Set<string>();
  const result: BlockingIssue[] = [];
  for (const item of issues) {
    const key = `${item.code ?? ""}:${item.nodeId ?? ""}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
