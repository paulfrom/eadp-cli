import { readFile, writeFile } from "node:fs/promises";
import { CliError } from "../../errors.js";
import type { OperationRecorder } from "../../operations/recorder.js";
import type { ResourceClient, ResourceRecord } from "../../resource/core/client.js";
import {
  DependencyResolutionError,
  RecordMappingError,
  type BlockingIssue,
  type MissingDependency
} from "../../resource/core/errors.js";
import { selectFlow } from "../bpm/selection.js";
import { inspectCanonicalGraph } from "./analysis.js";
import {
  analyzeGraphConditions,
  analyzeRemoteGraphConditions,
  readConditionProperties,
  type ConditionExpressionValidationCache,
  type ConditionProperty
} from "./conditions.js";
import { hydrate, stableStringify, toCanonical } from "./graph.js";
import { graphReferences } from "./references.js";
import { readFlowDesign } from "./service.js";
import { mapGraphServerError } from "./server-errors.js";
import { diffCanonicalGraphs, graphSize, type CanonicalGraphDiff, type GraphSize } from "./diff.js";

export const GRAPH_DRAFT_KIND = "eadp.bpm.graph.v1" as const;

export interface GraphDraft {
  name: string;
  graph: ResourceRecord;
}

export interface GraphDraftFile {
  kind: typeof GRAPH_DRAFT_KIND;
  flow: string;
  graphs: GraphDraft[];
}

export type GraphImportAction = "create" | "update" | "unchanged" | "blocked";

export interface GraphImportChange {
  name: string;
  action: GraphImportAction;
  changedFields: string[];
  blockingIssues?: BlockingIssue[];
  designIssues?: BlockingIssue[];
  warnings?: BlockingIssue[];
  missingDependencies?: MissingDependency[];
  /** Designer-compatible server validation counts for this graph. */
  conditionExpressions?: {
    attempted: number;
    validated: number;
    failed: number;
  };
  /** Canonical string used for comparison and verification. */
  canonical: string;
  /** Design payload for the target environment; only for writable changes. */
  hydrated?: string;
  /** Target definition ID when one already exists. */
  definitionId?: string;
}

export interface GraphImportPlan {
  flow: string;
  changes: GraphImportChange[];
}

export interface GraphValidationEntry {
  name: string;
  nodes: number;
  valid: boolean;
  designValid: boolean;
  blockingIssues: BlockingIssue[];
  designIssues: BlockingIssue[];
  warnings: BlockingIssue[];
  missingDependencies: MissingDependency[];
}

export interface GraphValidationResult {
  flow: string;
  flowTypeFound: boolean;
  valid: boolean;
  designValid: boolean;
  /** Condition fields the target business entity publishes for gateway decisions. */
  conditions: {
    checked: boolean;
    businessEntity?: string;
    propertyCount?: number;
    expressionValidation?: {
      attempted: number;
      validated: number;
      failed: number;
    };
  };
  graphs: GraphValidationEntry[];
}

/** Read and validate a portable graph file. */
export async function readGraphDraftFile(path: string): Promise<GraphDraftFile> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(`读取流程图文件失败：${path}：${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new CliError(`流程图文件不是有效 JSON：${errorMessage(error)}`);
  }
  return parseGraphDraftFile(parsed);
}

export async function writeGraphDraftFile(path: string, file: GraphDraftFile): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new CliError(`写入流程图文件失败：${path}：${errorMessage(error)}`);
  }
}

export function parseGraphDraftFile(value: unknown): GraphDraftFile {
  if (!isRecord(value)) throw new CliError("流程图文件必须是 JSON 对象");
  if (value.kind !== undefined && value.kind !== GRAPH_DRAFT_KIND) {
    throw new CliError(`流程图文件类型不支持：${String(value.kind)}`);
  }
  const flow = typeof value.flow === "string" ? value.flow.trim() : "";
  if (value.defJson !== undefined && value.graph === undefined && !Array.isArray(value.graphs)) {
    throw new CliError(
      "流程图文件使用了 defJson；请使用 bpm graph export 生成的 graph（规范化图），不要直接放设计器原始 defJson"
    );
  }
  const rawGraphs = Array.isArray(value.graphs)
    ? value.graphs
    : Array.isArray(value.items)
      ? value.items
      : value.graph !== undefined
        ? [{ name: value.name, graph: value.graph }]
        : [];
  if (rawGraphs.length === 0) {
    throw new CliError("流程图文件缺少 graphs（或单个 graph）");
  }
  const graphs: GraphDraft[] = [];
  for (const [index, raw] of rawGraphs.entries()) {
    if (!isRecord(raw)) throw new CliError(`流程图文件 graphs[${index}] 不是对象`);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) throw new CliError(`流程图文件 graphs[${index}] 缺少 name（流程定义名称）`);
    const graphValue = raw.graph;
    const graph = normalizeGraphValue(graphValue, index);
    graphs.push({ name, graph });
  }
  return { kind: GRAPH_DRAFT_KIND, flow, graphs };
}

/** Export every design draft of one flow type in portable canonical form. */
export async function exportGraphDrafts(
  client: ResourceClient,
  flowSelector: string,
  options: { allowEmpty?: boolean } = {}
): Promise<GraphDraftFile> {
  const refs = graphReferences(client);
  const [flows, entities] = await Promise.all([refs.flowTypes(), refs.businessEntities()]);
  const flow = selectFlow(flows, entities, flowSelector);
  const code = requiredText(flow.code, "源流程类型缺少 code");
  const flowTypeId = requiredText(flow.id, "源流程类型缺少 ID");
  const definitions = (await refs.flowDefinitions())
    .filter((definition) => definition.flowTypeId === flowTypeId);
  if (definitions.length === 0 && !options.allowEmpty) {
    throw new CliError(
      `流程类型 ${code} 下没有流程图定义，无法导出；请先在 BPM 设计器落稿`,
      1,
      { code: "GRAPH_SOURCE_EMPTY" }
    );
  }
  const graphs: GraphDraft[] = [];
  for (const definition of definitions) {
    const name = requiredText(definition.name, "源流程定义缺少名称");
    const id = requiredText(definition.id, `源流程定义 ${name} 缺少 ID`);
    const design = await readFlowDesign(client, id);
    const defJson = design?.defJson;
    if (typeof defJson !== "string" || defJson.trim() === "") {
      throw new CliError(`流程定义 ${name} 没有设计稿，无法导出`);
    }
    const canonical = await toCanonical(defJson, refs);
    graphs.push({ name, graph: JSON.parse(canonical) as ResourceRecord });
  }
  return { kind: GRAPH_DRAFT_KIND, flow: code, graphs };
}

/** Keep only portable business flow content: nodes, edges, conditions and executors. */
export function trimGraphDraftFile(file: GraphDraftFile): GraphDraftFile {
  return {
    kind: GRAPH_DRAFT_KIND,
    flow: file.flow,
    graphs: file.graphs.map((draft) => {
      const process = isRecord(draft.graph.process) ? draft.graph.process : {};
      const nodes = isRecord(process.nodes) ? process.nodes : {};
      const trimmedNodes: ResourceRecord = {};
      for (const [nodeId, value] of Object.entries(nodes)) {
        if (!isRecord(value)) continue;
        const config = isRecord(value.nodeConfig) ? value.nodeConfig : {};
        const targets = Array.isArray(value.target) ? value.target : [];
        trimmedNodes[nodeId] = {
          id: value.id,
          type: value.type,
          ...(value.nodeType === undefined ? {} : { nodeType: value.nodeType }),
          ...(value.busType === undefined ? {} : { busType: value.busType }),
          name: value.name,
          target: targets.filter(isRecord).map((target) => ({
            ...(target.id === undefined ? {} : { id: target.id }),
            ...(target.edgeId === undefined ? {} : { edgeId: target.edgeId }),
            targetId: target.targetId,
            uel: trimUel(target.uel)
          })),
          nodeConfig: {
            executor: cloneJson(config.executor ?? [])
          }
        };
      }
      return {
        name: draft.name,
        graph: {
          process: {
            startUEL: cloneJson(process.startUEL ?? {}),
            nodes: trimmedNodes
          }
        }
      };
    })
  };
}

function trimUel(value: unknown): unknown {
  const uel = isRecord(value) ? value : {};
  const result: ResourceRecord = {};
  for (const field of ["name", "logicUel", "groovyUel", "agree", "isDefault", "isReverse"]) {
    if (uel[field] !== undefined) result[field] = cloneJson(uel[field]);
  }
  return result;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export interface GraphDraftDiffEntry extends CanonicalGraphDiff {
  name: string;
  action: "create" | "update" | "unchanged" | "remote-only";
}

/** Read-only canonical diff between a local file and the latest remote drafts. */
export async function diffGraphDrafts(
  client: ResourceClient,
  flowSelector: string,
  file: GraphDraftFile
): Promise<{
  flow: string;
  equal: boolean;
  summary: Record<string, number>;
  graphs: GraphDraftDiffEntry[];
}> {
  const remote = await exportGraphDrafts(client, flowSelector, { allowEmpty: true });
  if (file.flow && !sameText(file.flow, remote.flow)) {
    throw new CliError(`流程图文件属于流程类型 ${file.flow}，与环境流程类型 ${remote.flow} 不一致`, 1, {
      code: "INVALID_ARGUMENT"
    });
  }
  const remoteByName = new Map<string, GraphDraft>();
  for (const draft of remote.graphs) {
    const key = draft.name.toLowerCase();
    if (remoteByName.has(key)) {
      throw new CliError(`环境中存在同名流程定义，无法唯一比较：${draft.name}`, 1, {
        code: "INVALID_ARGUMENT"
      });
    }
    remoteByName.set(key, draft);
  }
  const graphs: GraphDraftDiffEntry[] = [];
  const localNames = new Set<string>();
  for (const draft of file.graphs) {
    const key = draft.name.toLowerCase();
    if (localNames.has(key)) throw new CliError(`流程图文件中存在同名流程定义：${draft.name}`);
    localNames.add(key);
    const match = remoteByName.get(key);
    const localCanonical = stableStringify(draft.graph);
    const diff = diffCanonicalGraphs(localCanonical, match ? stableStringify(match.graph) : "{}");
    graphs.push({
      name: draft.name,
      action: !match ? "create" : diff.equal ? "unchanged" : "update",
      ...diff
    });
  }
  for (const draft of remote.graphs) {
    if (localNames.has(draft.name.toLowerCase())) continue;
    graphs.push({
      name: draft.name,
      action: "remote-only",
      ...diffCanonicalGraphs("{}", stableStringify(draft.graph))
    });
  }
  const summary: Record<string, number> = { create: 0, update: 0, unchanged: 0, "remote-only": 0 };
  for (const entry of graphs) summary[entry.action] = (summary[entry.action] ?? 0) + 1;
  return {
    flow: remote.flow,
    equal: graphs.every((entry) => entry.action === "unchanged"),
    summary,
    graphs
  };
}

export interface GraphValidationOptions {
  /** Treat designer-invalid graphs as validation failures. */
  strict?: boolean;
}

/** Resolve a portable file against one environment without writing anything. */
export async function validateGraphDrafts(
  client: ResourceClient,
  file: GraphDraftFile,
  options: GraphValidationOptions = {}
): Promise<GraphValidationResult> {
  const refs = graphReferences(client);
  const flow = await findFlowType(refs, file.flow);
  const flowTypeId = flow ? requiredText(flow.id, "目标流程类型缺少 ID") : undefined;
  const conditions = await loadFlowConditionProperties(client, refs, flow);
  const expressionCache: ConditionExpressionValidationCache = new Map();
  const expressionValidation = { attempted: 0, validated: 0, failed: 0 };
  const entries: GraphValidationEntry[] = [];
  for (const draft of file.graphs) {
    const canonical = stableStringify(draft.graph);
    const verdict = inspectCanonicalGraph(canonical);
    const blockingIssues = [...verdict.blockingIssues];
    const designIssues = [...verdict.designIssues];
    const warnings = [...verdict.warnings];
    const missingDependencies: MissingDependency[] = [];
    if (conditions.warning) warnings.push(conditions.warning);
    if (flowTypeId && blockingIssues.length === 0) {
      try {
        await hydrate(canonical, refs, { flowTypeId });
      } catch (error) {
        collectIssues(error, blockingIssues, missingDependencies);
      }
    }
    if (conditions.properties.length > 0) {
      const conditionVerdict = analyzeGraphConditions(canonical, conditions.properties);
      designIssues.push(...conditionVerdict.designIssues);
      warnings.push(...conditionVerdict.warnings);
      if (flowTypeId) {
        const remote = await analyzeRemoteGraphConditions(
          client,
          flowTypeId,
          canonical,
          conditions.properties,
          expressionCache
        );
        designIssues.push(...remote.designIssues);
        warnings.push(...remote.warnings);
        expressionValidation.attempted += remote.attempted;
        expressionValidation.validated += remote.validated;
        expressionValidation.failed += remote.failed;
      }
    }
    const designValid = designIssues.length === 0;
    entries.push({
      name: draft.name,
      nodes: nodeCount(canonical),
      valid: blockingIssues.length === 0 &&
        missingDependencies.length === 0 &&
        (!options.strict || designValid),
      designValid,
      blockingIssues,
      designIssues,
      warnings,
      missingDependencies
    });
  }
  return {
    flow: file.flow,
    flowTypeFound: flow !== undefined,
    valid: flow !== undefined && entries.every((entry) => entry.valid),
    designValid: flow !== undefined && entries.every((entry) => entry.designValid),
    conditions: {
      checked: conditions.properties.length > 0,
      ...(conditions.businessEntity === undefined
        ? {}
        : { businessEntity: conditions.businessEntity }),
      ...(conditions.properties.length === 0
        ? {}
        : { propertyCount: conditions.properties.length, expressionValidation })
    },
    graphs: entries
  };
}

interface FlowConditionProperties {
  properties: ConditionProperty[];
  businessEntity?: string;
  warning?: BlockingIssue;
}

/**
 * Load the condition fields the target business entity publishes. A failure is
 * reported as a warning so the graph verdict stays visible; the message keeps
 * the original error so nothing is hidden.
 */
async function loadFlowConditionProperties(
  client: ResourceClient,
  refs: ReturnType<typeof graphReferences>,
  flow: ResourceRecord | undefined
): Promise<FlowConditionProperties> {
  if (!flow) return { properties: [] };
  const entityId = typeof flow.businessEntityId === "string"
    ? flow.businessEntityId.trim()
    : "";
  if (entityId === "") {
    return {
      properties: [],
      warning: conditionWarning("目标流程类型未绑定业务实体，无法读取系统判定条件")
    };
  }
  const entities = await refs.businessEntities();
  const entity = entities.find((item) => item.id === entityId);
  const entityCode = typeof entity?.code === "string" ? entity.code.trim() : "";
  if (entityCode === "") {
    return {
      properties: [],
      warning: conditionWarning("目标流程类型的业务实体缺少 code，无法读取系统判定条件")
    };
  }
  try {
    const properties = await readConditionProperties(client, entityCode);
    if (properties.length === 0) {
      return {
        properties,
        businessEntity: entityCode,
        warning: conditionWarning(
          `目标业务实体 ${entityCode} 未发布任何判定条件字段，无法校验网关条件`
        )
      };
    }
    return { properties, businessEntity: entityCode };
  } catch (error) {
    return {
      properties: [],
      businessEntity: entityCode,
      warning: conditionWarning(`读取系统判定条件失败：${errorMessage(error)}`)
    };
  }
}

function conditionWarning(message: string): BlockingIssue {
  return {
    resource: "bpm-flow-graph",
    field: "graph",
    reason: "invalid",
    message,
    code: "CONDITION_CATALOG_UNAVAILABLE",
    severity: "warning",
    scope: "graph",
    fix: "确认目标环境的业务实体已发布条件属性，并检查 conBusinessEntity/getConditionPropertiesExplain 是否可用"
  };
}

/**
 * Plan an import of a portable file into one environment. `unchanged` entries
 * are compared against the target's latest draft; only create/update entries
 * receive a hydrated payload.
 */
export async function planGraphImport(
  client: ResourceClient,
  flowSelector: string,
  file: GraphDraftFile,
  options: GraphValidationOptions = {}
): Promise<GraphImportPlan> {
  const refs = graphReferences(client);
  const [flows, entities] = await Promise.all([refs.flowTypes(), refs.businessEntities()]);
  const flow = selectTargetFlow(flows, entities, flowSelector);
  const code = requiredText(flow.code, "目标流程类型缺少 code");
  if (file.flow && !sameText(file.flow, code)) {
    throw new CliError(`流程图文件属于流程类型 ${file.flow}，与目标流程类型 ${code} 不一致`);
  }
  const flowTypeId = requiredText(flow.id, "目标流程类型缺少 ID");
  const definitions = (await refs.flowDefinitions())
    .filter((definition) => definition.flowTypeId === flowTypeId);
  const names = new Map<string, number>();
  for (const draft of file.graphs) {
    names.set(draft.name, (names.get(draft.name) ?? 0) + 1);
  }
  for (const [name, count] of names) {
    if (count > 1) throw new CliError(`流程图文件中存在同名流程定义：${name}`);
  }

  const changes: GraphImportChange[] = [];
  const conditions = await loadFlowConditionProperties(client, refs, flow);
  const expressionCache: ConditionExpressionValidationCache = new Map();
  for (const draft of file.graphs) {
    const canonical = stableStringify(draft.graph);
    const verdict = inspectCanonicalGraph(canonical);
    const designIssues = [...verdict.designIssues];
    const warnings = [...verdict.warnings];
    let conditionExpressions: GraphImportChange["conditionExpressions"];
    if (conditions.warning) warnings.push(conditions.warning);
    if (conditions.properties.length > 0) {
      const conditionVerdict = analyzeGraphConditions(canonical, conditions.properties);
      designIssues.push(...conditionVerdict.designIssues);
      warnings.push(...conditionVerdict.warnings);
      const remote = await analyzeRemoteGraphConditions(
        client,
        flowTypeId,
        canonical,
        conditions.properties,
        expressionCache
      );
      designIssues.push(...remote.designIssues);
      warnings.push(...remote.warnings);
      conditionExpressions = {
        attempted: remote.attempted,
        validated: remote.validated,
        failed: remote.failed
      };
    }
    const blockingIssues = options.strict
      ? [...verdict.blockingIssues, ...designIssues]
      : [...verdict.blockingIssues];
    const extra = {
      ...(designIssues.length === 0 ? {} : { designIssues }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(conditionExpressions === undefined ? {} : { conditionExpressions })
    };
    if (blockingIssues.length > 0) {
      changes.push({
        name: draft.name,
        action: "blocked",
        changedFields: [],
        blockingIssues,
        canonical,
        ...extra
      });
      continue;
    }
    const matches = definitions.filter((definition) => sameText(definition.name, draft.name));
    if (matches.length > 1) {
      changes.push({
        name: draft.name,
        action: "blocked",
        changedFields: [],
        canonical,
        blockingIssues: [{
          resource: "defFlowDefinition",
          field: "name",
          reason: "ambiguous",
          value: draft.name,
          message: `目标流程类型 ${code} 下存在同名流程定义：${draft.name}`
        }],
        ...extra
      });
      continue;
    }
    const existing = matches[0];
    if (existing) {
      const definitionId = requiredText(existing.id, `目标流程定义 ${draft.name} 缺少 ID`);
      const design = await readFlowDesign(client, definitionId);
      const before = design?.defJson;
      if (typeof before === "string" && before.trim() !== "") {
        const beforeCanonical = await canonicalizeTarget(before, refs);
        if (beforeCanonical === canonical) {
          changes.push({
            name: draft.name,
            action: "unchanged",
            changedFields: [],
            canonical,
            definitionId,
            ...extra
          });
          continue;
        }
      }
    }
    const missingDependencies: MissingDependency[] = [];
    let hydrated: string | undefined;
    try {
      hydrated = await hydrate(canonical, refs, {
        flowTypeId,
        ...(existing ? { targetDefinition: existing } : {})
      });
    } catch (error) {
      collectIssues(error, blockingIssues, missingDependencies);
    }
    if (!hydrated) {
      changes.push({
        name: draft.name,
        action: "blocked",
        changedFields: [],
        canonical,
        blockingIssues,
        missingDependencies,
        ...extra
      });
      continue;
    }
    changes.push({
      name: draft.name,
      action: existing ? "update" : "create",
      changedFields: ["graph"],
      canonical,
      hydrated,
      ...(existing ? { definitionId: requiredText(existing.id, "目标流程定义缺少 ID") } : {}),
      ...extra
    });
  }
  return { flow: code, changes };
}

/** Apply a planned import; only drafts are written, never a publish. */
export async function applyGraphImport(
  client: ResourceClient,
  plan: GraphImportPlan,
  recorder?: OperationRecorder
): Promise<void> {
  for (const change of plan.changes) {
    if (change.action !== "create" && change.action !== "update") continue;
    if (!change.hydrated) throw new CliError(`流程图变更 ${change.name} 缺少待写入内容`);
    let saved: unknown;
    try {
      saved = await client.invoke("defFlowVersion/saveOrDeploy", "POST", {
        defJson: change.hydrated,
        deploy: false
      });
    } catch (error) {
      throw mapGraphServerError(error, change);
    }
    if (!isRecord(saved)) throw new CliError("defFlowVersion/saveOrDeploy 返回格式无效");
    const definitionId = requiredText(saved.flowDefinitionId,
      "defFlowVersion/saveOrDeploy 未返回 flowDefinitionId");
    change.definitionId = definitionId;
    if (change.action === "create" && recorder) {
      await recorder.recordAction({
        type: "create-entity",
        service: "sei-bpm",
        resource: "defFlowDefinition",
        entityId: definitionId,
        expected: { id: definitionId, name: change.name },
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

export interface GraphVerificationEntry {
  name: string;
  definitionId?: string;
  verified: boolean;
  expected: GraphSize;
  actual: GraphSize;
  differenceCount: number;
  differences: CanonicalGraphDiff["differences"];
  error?: string;
}

export interface GraphVerificationReport {
  verified: boolean;
  readBack: GraphSize;
  graphs: GraphVerificationEntry[];
}

/** Re-read every non-blocked draft and retain detailed evidence on mismatch. */
export async function verifyGraphImport(
  client: ResourceClient,
  plan: GraphImportPlan
): Promise<GraphVerificationReport> {
  const refs = graphReferences(client);
  const graphs: GraphVerificationEntry[] = [];
  for (const change of plan.changes) {
    if (change.action === "blocked") continue;
    const expected = graphSize(JSON.parse(change.canonical) as unknown);
    const entry: GraphVerificationEntry = {
      name: change.name,
      ...(change.definitionId === undefined ? {} : { definitionId: change.definitionId }),
      verified: false,
      expected,
      actual: { nodes: 0, edges: 0 },
      differenceCount: 0,
      differences: []
    };
    try {
      if (!change.definitionId) throw new CliError("写入结果缺少 flowDefinitionId，无法回读");
      const design = await readFlowDesign(client, change.definitionId);
      const defJson = design?.defJson;
      if (typeof defJson !== "string" || defJson.trim() === "") {
        throw new CliError("回读结果没有 defJson 设计稿");
      }
      const actualCanonical = await canonicalizeTarget(defJson, refs);
      const actualParsed = JSON.parse(actualCanonical) as unknown;
      entry.actual = graphSize(actualParsed);
      const diff = diffCanonicalGraphs(change.canonical, actualCanonical);
      entry.differenceCount = diff.differenceCount;
      entry.differences = diff.differences;
      entry.verified = diff.equal;
      if (!diff.equal) {
        entry.error = `回读图与本地文件存在 ${diff.differenceCount} 处差异`;
      }
    } catch (error) {
      entry.error = errorMessage(error);
      if (entry.differenceCount === 0 && entry.differences.length === 0) {
        const diff = diffCanonicalGraphs(change.canonical, "{}");
        entry.differenceCount = diff.differenceCount;
        entry.differences = diff.differences;
      }
    }
    graphs.push(entry);
  }
  return {
    verified: graphs.every((entry) => entry.verified),
    readBack: graphs.reduce((total, entry) => ({
      nodes: total.nodes + entry.actual.nodes,
      edges: total.edges + entry.actual.edges
    }), { nodes: 0, edges: 0 }),
    graphs
  };
}

export function summarizeImport(plan: GraphImportPlan): Record<string, number> {
  const summary: Record<string, number> = {
    create: 0, update: 0, unchanged: 0, blocked: 0
  };
  for (const change of plan.changes) {
    summary[change.action] = (summary[change.action] ?? 0) + 1;
  }
  return summary;
}

/** Strip graph payloads from terminal output. */
export function sanitizeImportOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeImportOutput);
  if (!isRecord(value)) return value;
  const result: ResourceRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "canonical" || key === "hydrated") continue;
    result[key] = sanitizeImportOutput(child);
  }
  return result;
}

function selectTargetFlow(
  flows: ResourceRecord[],
  entities: ResourceRecord[],
  selector: string
): ResourceRecord {
  try {
    return selectFlow(flows, entities, selector);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(
        `${error.message.replace("源环境", "目标环境")}；请先运行 resource sync bpm 或 bpm-migration 建立流程类型`,
        1,
        { code: error.code }
      );
    }
    throw error;
  }
}

async function findFlowType(
  refs: ReturnType<typeof graphReferences>,
  flowCode: string
): Promise<ResourceRecord | undefined> {  if (!flowCode) return undefined;
  const flows = await refs.flowTypes();
  const matches = flows.filter((flow) => sameText(flow.code, flowCode));
  return matches.length === 1 ? matches[0] : undefined;
}

async function canonicalizeTarget(
  defJson: string,
  refs: ReturnType<typeof graphReferences>
): Promise<string> {
  try {
    return await toCanonical(defJson, refs);
  } catch (error) {
    if (error instanceof RecordMappingError || error instanceof DependencyResolutionError) {
      return defJson;
    }
    throw error;
  }
}

function normalizeGraphValue(value: unknown, index: number): ResourceRecord {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the explicit error below.
    }
  }
  throw new CliError(`流程图文件 graphs[${index}] 缺少合法的 graph（JSON 对象或字符串）`);
}

function collectIssues(
  error: unknown,
  blockingIssues: BlockingIssue[],
  missingDependencies: MissingDependency[]
): void {
  if (error instanceof DependencyResolutionError) {
    missingDependencies.push(...error.missingDependencies);
    return;
  }
  if (error instanceof RecordMappingError) {
    blockingIssues.push(...error.blockingIssues);
    return;
  }
  if (error instanceof CliError) {
    blockingIssues.push({
      resource: "bpm-flow-graph",
      field: "graph",
      reason: "invalid",
      message: error.message
    });
    return;
  }
  throw error;
}

function nodeCount(canonical: string): number {
  const graph = JSON.parse(canonical) as ResourceRecord;
  const process = isRecord(graph.process) ? graph.process : undefined;
  return process && isRecord(process.nodes) ? Object.keys(process.nodes).length : 0;
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CliError(message);
  return value.trim();
}

function sameText(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === expected.trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
