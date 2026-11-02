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
import { hydrate, stableStringify, toCanonical, validateCanonicalGraph } from "./graph.js";
import { graphReferences } from "./references.js";
import { readFlowDesign } from "./service.js";

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
  missingDependencies?: MissingDependency[];
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
  blockingIssues: BlockingIssue[];
  missingDependencies: MissingDependency[];
}

export interface GraphValidationResult {
  flow: string;
  flowTypeFound: boolean;
  valid: boolean;
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
  flowSelector: string
): Promise<GraphDraftFile> {
  const refs = graphReferences(client);
  const [flows, entities] = await Promise.all([refs.flowTypes(), refs.businessEntities()]);
  const flow = selectFlow(flows, entities, flowSelector);
  const code = requiredText(flow.code, "源流程类型缺少 code");
  const flowTypeId = requiredText(flow.id, "源流程类型缺少 ID");
  const definitions = (await refs.flowDefinitions())
    .filter((definition) => definition.flowTypeId === flowTypeId);
  if (definitions.length === 0) {
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

/** Resolve a portable file against one environment without writing anything. */
export async function validateGraphDrafts(
  client: ResourceClient,
  file: GraphDraftFile
): Promise<GraphValidationResult> {
  const refs = graphReferences(client);
  const flow = await findFlowType(refs, file.flow);
  const flowTypeId = flow ? requiredText(flow.id, "目标流程类型缺少 ID") : undefined;
  const entries: GraphValidationEntry[] = [];
  for (const draft of file.graphs) {
    const canonical = stableStringify(draft.graph);
    const blockingIssues = validateCanonicalGraph(canonical);
    const missingDependencies: MissingDependency[] = [];
    if (flowTypeId && blockingIssues.length === 0) {
      try {
        await hydrate(canonical, refs, { flowTypeId });
      } catch (error) {
        collectIssues(error, blockingIssues, missingDependencies);
      }
    }
    entries.push({
      name: draft.name,
      nodes: nodeCount(canonical),
      valid: blockingIssues.length === 0 && missingDependencies.length === 0,
      blockingIssues,
      missingDependencies
    });
  }
  return {
    flow: file.flow,
    flowTypeFound: flow !== undefined,
    valid: flow !== undefined && entries.every((entry) => entry.valid),
    graphs: entries
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
  file: GraphDraftFile
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
  for (const draft of file.graphs) {
    const canonical = stableStringify(draft.graph);
    const blockingIssues = validateCanonicalGraph(canonical);
    if (blockingIssues.length > 0) {
      changes.push({ name: draft.name, action: "blocked", changedFields: [], blockingIssues, canonical });
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
        }]
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
            definitionId
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
        missingDependencies
      });
      continue;
    }
    changes.push({
      name: draft.name,
      action: existing ? "update" : "create",
      changedFields: ["graph"],
      canonical,
      hydrated,
      ...(existing ? { definitionId: requiredText(existing.id, "目标流程定义缺少 ID") } : {})
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
    const saved = await client.invoke("defFlowVersion/saveOrDeploy", "POST", {
      defJson: change.hydrated,
      deploy: false
    });
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

/** Re-read every written draft and compare it with the file. */
export async function verifyGraphImport(
  client: ResourceClient,
  plan: GraphImportPlan
): Promise<boolean> {
  const refs = graphReferences(client);
  for (const change of plan.changes) {
    if (change.action === "blocked") continue;
    const definitionId = change.definitionId;
    if (!definitionId) return false;
    const design = await readFlowDesign(client, definitionId);
    const defJson = design?.defJson;
    if (typeof defJson !== "string" || defJson.trim() === "") return false;
    const actual = await canonicalizeTarget(defJson, refs);
    if (actual !== change.canonical) return false;
  }
  return true;
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
