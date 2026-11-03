import { RecordMappingError, type BlockingIssue } from "../../resource/core/errors.js";
import {
  resolveNodeKind,
  type NodeIssue,
  type NodeRule
} from "./node-catalog.js";

type RecordValue = Record<string, unknown>;

const GRAPH_RESOURCE = "bpm-flow-graph";

export interface GraphValidation {
  /** Issues that prevent a safe cross-environment write. */
  blockingIssues: BlockingIssue[];
  /** Issues that the BPM designer would reject (or where it would ask for confirmation). */
  designIssues: BlockingIssue[];
  /** Non-blocking fidelity/legacy risks. */
  warnings: BlockingIssue[];
}

interface NodeMeta {
  key: string;
  name: string;
  rule?: NodeRule;
  out: number;
  agree: number;
  defaultEdge: number;
  reverse: number;
}

/**
 * Analyze one canonical graph. `blockingIssues` keeps the historical migration
 * contract; `designIssues` mirrors the designer's save-time rules; `warnings`
 * carry fidelity/legacy risks. Everything is computed from the graph itself;
 * no external source or remote call is involved.
 */
export function inspectCanonicalGraph(canonical: string): GraphValidation {
  return analyzeGraph(parseGraph(canonical));
}

export function analyzeGraph(graph: RecordValue): GraphValidation {
  const blocking: BlockingIssue[] = [];
  const design: BlockingIssue[] = [];
  const warnings: BlockingIssue[] = [];

  const process = isRecord(graph.process) ? graph.process : undefined;
  if (!process) {
    blocking.push(issue("GRAPH_PROCESS_MISSING", "流程图缺少 process 对象"));
    return { blockingIssues: blocking, designIssues: design, warnings };
  }
  const nodes = isRecord(process.nodes) ? process.nodes : undefined;
  if (!nodes) {
    blocking.push(issue("GRAPH_NODES_MISSING", "流程图缺少 process.nodes 对象"));
    return { blockingIssues: blocking, designIssues: design, warnings };
  }

  const keys = new Set(Object.keys(nodes));
  const inDegree = new Map<string, number>();
  const metaList: NodeMeta[] = [];
  let startCount = 0;
  let endCount = 0;

  for (const [key, value] of Object.entries(nodes)) {
    if (!isRecord(value)) {
      blocking.push(issue("NODE_TYPE_MISSING", `节点 ${key} 不是对象`, key));
      continue;
    }
    const name = text(value.name) ?? key;
    const resolution = resolveNodeKind(value);
    for (const nodeIssue of resolution.issues) {
      blocking.push(fromNodeIssue(nodeIssue, key, name));
    }
    const rule = resolution.rule;
    if (!rule) {
      metaList.push({ key, name, out: 0, agree: 0, defaultEdge: 0, reverse: 0 });
      continue;
    }
    if (rule.legacy) {
      warnings.push(warning(
        "NODE_LEGACY_KIND",
        `节点 ${name} 使用历史类型 ${rule.kind}；当前设计器不再产出该类型`,
        key,
        name,
        "尽量在设计器中改为当前支持的节点类型"
      ));
    }
    if (rule.migration.policy === "blocked") {
      blocking.push(issue(
        rule.kind === "CallActivity" ? "CALL_ACTIVITY_BLOCKED" : "NODE_TYPE_UNSUPPORTED",
        rule.migration.reason ?? `节点 ${name} 的 ${rule.kind} 不支持跨环境迁移`,
        key,
        name
      ));
      metaList.push({ key, name, rule, out: 0, agree: 0, defaultEdge: 0, reverse: 0 });
      continue;
    }

    const id = text(value.id);
    if (!id) {
      blocking.push(issue("NODE_ID_MISSING", `节点 ${key} 缺少 id`, key, name));
    } else if (id !== key) {
      blocking.push(issue("NODE_ID_MISMATCH", `节点 ${key} 的 id 与键不一致`, key, name));
    }
    if (!text(value.name)) {
      blocking.push(issue("NODE_NAME_MISSING", `节点 ${key} 缺少 name`, key, name));
    }
    if (rule.kind === "StartEvent") startCount += 1;
    if (rule.kind === "EndEvent" || rule.kind === "TerminateEndEvent") endCount += 1;

    const targets = value.target;
    const meta: NodeMeta = { key, name, rule, out: 0, agree: 0, defaultEdge: 0, reverse: 0 };
    if (!Array.isArray(targets)) {
      blocking.push(issue("EDGE_TARGET_MISSING", `节点 ${key} 缺少 target 数组`, key, name));
    } else {
      for (const target of targets) {
        if (!isRecord(target)) {
          blocking.push(issue("EDGE_TARGET_MISSING", `节点 ${key} 的连线不是对象`, key, name));
          continue;
        }
        const targetId = text(target.targetId);
        if (!targetId) {
          blocking.push(issue("EDGE_TARGET_MISSING", `节点 ${key} 的连线缺少 targetId`, key, name));
          continue;
        }
        if (!keys.has(targetId)) {
          blocking.push(issue(
            "EDGE_TARGET_UNKNOWN",
            `节点 ${key} 的连线目标不存在：${targetId}`,
            key,
            name
          ));
          continue;
        }
        meta.out += 1;
        inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
        const uel = normalizeUel(target.uel);
        if (uel.agree === true) meta.agree += 1;
        if (uel.isDefault === true) meta.defaultEdge += 1;
        if (uel.isReverse === true || uel.isReverse === "true") meta.reverse += 1;
      }
    }
    metaList.push(meta);
    inspectNodeConfig(value, meta, design, blocking, warnings);
  }

  if (startCount !== 1) {
    blocking.push(issue(
      "START_COUNT",
      `流程图必须且只能有 1 个 StartEvent（实际 ${startCount} 个）`
    ));
  }
  if (endCount < 1) {
    blocking.push(issue("END_COUNT", "流程图至少需要 1 个 EndEvent"));
  }

  let hasReverse = false;
  for (const meta of metaList) {
    const rule = meta.rule;
    if (!rule || rule.migration.policy === "blocked") continue;
    if (meta.reverse > 0) hasReverse = true;
    const inCount = inDegree.get(meta.key) ?? 0;
    inspectEdges(meta, rule, inCount, design);
  }
  const needsReverse = metaList.some((meta) => meta.rule?.edges.reverseWarning === true);
  if (needsReverse && !hasReverse) {
    warnings.push(warning(
      "NODE_REVERSE_NOT_SET",
      "流程图尚未设置逆向标识；设计器保存/发布时会要求确认",
      undefined,
      undefined,
      "右键点击网关或审批节点的出口线设置逆向标识"
    ));
  }

  return { blockingIssues: dedupe(blocking), designIssues: dedupe(design), warnings: dedupe(warnings) };
}

function inspectEdges(
  meta: NodeMeta,
  rule: NodeRule,
  inCount: number,
  design: BlockingIssue[]
): void {
  const label = `【${meta.name}】`;
  if (rule.kind === "StartEvent") {
    if (meta.out === 0) {
      design.push(issue("NODE_EXIT_MISSING", `${label}节点缺少出口线，请检查`, meta.key, meta.name));
    }
    return;
  }
  if (rule.kind === "EndEvent" || rule.kind === "TerminateEndEvent") {
    if (inCount === 0) {
      design.push(issue("NODE_ENTRY_MISSING", `${label}节点缺少入口线，请检查`, meta.key, meta.name));
    }
    return;
  }

  if (inCount === 0) {
    design.push(issue("NODE_ENTRY_MISSING", `${label}节点缺少入口线，请检查`, meta.key, meta.name));
  }
  if (meta.out === 0) {
    design.push(issue("NODE_EXIT_MISSING", `${label}节点缺少出口线，请检查`, meta.key, meta.name));
  }

  if (rule.edges.maxOut !== undefined) {
    if (meta.out !== rule.edges.maxOut) {
      design.push(issue(
        "NODE_EXIT_COUNT",
        `${label}节点需要配置 ${rule.edges.maxOut} 条出口线，请检查`,
        meta.key,
        meta.name,
        "为该节点增加/删除出口线，直到数量匹配"
      ));
    }
  } else if (meta.out < rule.edges.minOut) {
    design.push(issue(
      "NODE_EXIT_COUNT",
      `${label}需要配置>=${rule.edges.minOut}条出口线，请检查`,
      meta.key,
      meta.name
    ));
  }

  if (rule.edges.agreeEdge && meta.agree !== 1) {
    design.push(issue(
      "NODE_AGREE_EDGE",
      `${label}节点需要配置同意出口线（uel.agree=true），请检查`,
      meta.key,
      meta.name,
      "在一条出口线的 uel 中设置 agree=true"
    ));
  }

  if (rule.edges.defaultEdge && meta.defaultEdge !== 1) {
    const message = meta.defaultEdge === 0
      ? `${label}未配置默认路径，请修改配置`
      : `${label}只能有1个默认路径，请修改配置`;
    design.push(issue(
      "NODE_DEFAULT_EDGE",
      message,
      meta.key,
      meta.name,
      "在一条出口线的 uel 中设置 isDefault=true"
    ));
  }
}

function inspectNodeConfig(
  node: RecordValue,
  meta: NodeMeta,
  design: BlockingIssue[],
  blocking: BlockingIssue[],
  warnings: BlockingIssue[]
): void {
  const rule = meta.rule;
  if (!rule) return;
  const config = isRecord(node.nodeConfig) ? node.nodeConfig : {};
  const normal = isRecord(config.normal) ? config.normal : undefined;

  if (
    rule.configKeys.length > 0 &&
    isEmptyRecord(config) &&
    rule.group !== "event" &&
    rule.kind !== "ServiceTask"
  ) {
    design.push(issue(
      "NODE_CONFIG_EMPTY",
      `请将【${meta.name}】节点配置完整`,
      meta.key,
      meta.name,
      "双击节点，至少补齐常规/执行人配置"
    ));
  }

  if (hasContent(config.smartAudit) || hasContent(config.ruleConfig)) {
    blocking.push(issue(
      "SMART_AUDIT_BLOCKED",
      `节点 ${meta.name} 配置了智能审核/规则检查，v1 不支持跨环境迁移`,
      meta.key,
      meta.name
    ));
  }

  if (rule.normal?.page) {
    const page = normal && (text(normal.id) ?? text(normal.pageUrl));
    if (!page) {
      const message = `${meta.name} 节点缺少工作界面（normal.id/pageUrl）`;
      if (rule.executor?.required) {
        blocking.push(issue("NODE_PAGE_MISSING", message, meta.key, meta.name));
      }
      design.push(issue("NODE_PAGE_MISSING", message, meta.key, meta.name));
    }
  }

  for (const field of rule.normal?.requiredFields ?? []) {
    if (field === "outTime") {
      const value = normal?.[field];
      const numberValue = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numberValue) || numberValue < 5) {
        design.push(issue(
          "NODE_REQUIRED_FIELD_MISSING",
          `${meta.name} 的 normal.${field} 必填且不能小于 5 分钟`,
          meta.key,
          meta.name
        ));
      }
      continue;
    }
    if (!normal || !hasValue(normal[field])) {
      design.push(issue(
        "NODE_REQUIRED_FIELD_MISSING",
        `${meta.name} 的 normal.${field} 必填`,
        meta.key,
        meta.name
      ));
    }
  }

  if (rule.serviceRequired && !(normal && (text(normal.serviceTaskId) ?? text(normal.serviceTaskUrl)))) {
    design.push(issue(
      "NODE_SERVICE_MISSING",
      `${meta.name} 节点缺少服务事件（normal.serviceTask）`,
      meta.key,
      meta.name
    ));
  }

  if (rule.executor) inspectExecutors(config.executor, rule, meta, blocking, warnings);
}

function inspectExecutors(
  value: unknown,
  rule: NodeRule,
  meta: NodeMeta,
  blocking: BlockingIssue[],
  warnings: BlockingIssue[]
): void {
  const executorRule = rule.executor;
  if (!executorRule) return;
  const entries = executorEntries(value);
  if (executorRule.required && entries.length === 0) {
    blocking.push(issue(
      "NODE_EXECUTOR_MISSING",
      `用户任务 ${meta.key} 缺少执行人`,
      meta.key,
      meta.name
    ));
    return;
  }

  const allowed = new Set(executorRule.allowedTypes);
  const legacy = new Set(executorRule.legacyTypes ?? []);
  const blockedTypes = new Set(executorRule.blockedTypes ?? []);
  const fragmentsByType = new Map<string, Set<string>>();
  const codeFields: Readonly<Record<string, string>> = {
    Person: "employeeCodes",
    Position: "positionCodes",
    PositionType: "positionCategoryCodes",
    Org: "orgCodes",
    OrganizationDimension: "dimensionCodes"
  };

  for (const entry of entries) {
    const userType = text(entry.userType);
    const type = text(entry.type) ?? userType;
    if (!type) {
      blocking.push(issue(
        "NODE_EXECUTOR_TYPE_MISSING",
        `节点 ${meta.name} 的执行人缺少 type/userType`,
        meta.key,
        meta.name
      ));
      continue;
    }
    const codeField = userType ? codeFields[userType] : undefined;
    if (codeField && !hasValue(entry[codeField])) {
      blocking.push(issue(
        "NODE_REQUIRED_FIELD_MISSING",
        `节点 ${meta.name} 的执行人 ${userType} 缺少 ${codeField}`,
        meta.key,
        meta.name,
        `补齐执行人的 ${codeField}`
      ));
    }
    if (userType === "SelfDefinition" && !text(entry.selfDefServiceUrl)) {
      blocking.push(issue(
        "NODE_REQUIRED_FIELD_MISSING",
        `节点 ${meta.name} 的自定义执行人缺少 selfDefServiceUrl`,
        meta.key,
        meta.name,
        "在设计器重新选择自定义执行人接口"
      ));
    }
    if (blockedTypes.has(type) || (userType !== undefined && blockedTypes.has(userType))) {
      blocking.push(issue(
        "PROJECT_POSITION_BLOCKED",
        `节点 ${meta.name} 使用了项目岗位（ProjectPosition），v1 不支持跨环境迁移`,
        meta.key,
        meta.name
      ));
      continue;
    }
    if (type === "PositionTypeAndOrg" && userType === "PositionTypeAndOrg") {
      blocking.push(issue(
        "NODE_EXECUTOR_TYPE_UNSUPPORTED",
        `节点 ${meta.name} 的执行人组合 PositionTypeAndOrg 必须拆成 PositionType 与 Org 两个分片`,
        meta.key,
        meta.name,
        "分别写入 userType=PositionType 和 userType=Org 的两条记录"
      ));
      continue;
    }
    if (!allowed.has(type)) {
      if (legacy.has(type)) {
        warnings.push(warning(
          "NODE_EXECUTOR_LEGACY_TYPE",
          `节点 ${meta.name} 使用历史执行人类型 ${type}；跨环境迁移后需在设计器确认`,
          meta.key,
          meta.name
        ));
      } else {
        blocking.push(issue(
          "NODE_EXECUTOR_TYPE_UNSUPPORTED",
          `节点 ${meta.name} 的执行人类型不受支持：${type}`,
          meta.key,
          meta.name
        ));
      }
    }
    if (userType) {
      const fragments = fragmentsByType.get(type) ?? new Set<string>();
      fragments.add(userType);
      fragmentsByType.set(type, fragments);
    }
  }

  for (const [type, requiredFragments] of Object.entries(executorRule.composites ?? {})) {
    const present = fragmentsByType.get(type);
    if (!present) continue;
    const missing = requiredFragments.filter((fragment) => !present.has(fragment));
    if (missing.length > 0) {
      warnings.push(warning(
        "NODE_EXECUTOR_COMPOSITE_INCOMPLETE",
        `节点 ${meta.name} 的执行人组合 ${type} 缺少分片：${missing.join("、")}`,
        meta.key,
        meta.name,
        "在设计器重新选择执行人，确保组合类型的分片同时存在"
      ));
    }
  }
}

function fromNodeIssue(issue: NodeIssue, nodeId: string, nodeName: string): BlockingIssue {
  return {
    resource: GRAPH_RESOURCE,
    field: issue.field ?? "node",
    reason: "invalid",
    message: issue.message,
    code: issue.code,
    severity: issue.severity,
    scope: "node",
    nodeId,
    nodeName
  };
}

function issue(
  code: string,
  message: string,
  nodeId?: string,
  nodeName?: string,
  fix?: string
): BlockingIssue {
  return {
    resource: GRAPH_RESOURCE,
    field: "graph",
    reason: "invalid",
    message,
    code,
    severity: "error",
    scope: nodeId ? "node" : "graph",
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(nodeName === undefined ? {} : { nodeName }),
    ...(fix === undefined ? {} : { fix })
  };
}

function warning(
  code: string,
  message: string,
  nodeId?: string,
  nodeName?: string,
  fix?: string
): BlockingIssue {
  return { ...issue(code, message, nodeId, nodeName, fix), severity: "warning" };
}

function parseGraph(value: string): RecordValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RecordMappingError([{
      resource: GRAPH_RESOURCE,
      field: "graph",
      reason: "invalid",
      message: "流程图文件不是合法 JSON"
    }]);
  }
  if (!isRecord(parsed)) {
    throw new RecordMappingError([{
      resource: GRAPH_RESOURCE,
      field: "graph",
      reason: "invalid",
      message: "流程图必须是 JSON 对象"
    }]);
  }
  return parsed;
}

function executorEntries(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

function normalizeUel(value: unknown): RecordValue {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function isEmptyRecord(value: unknown): boolean {
  return !isRecord(value) || Object.keys(value).length === 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupe(issues: BlockingIssue[]): BlockingIssue[] {
  const seen = new Set<string>();
  const result: BlockingIssue[] = [];
  for (const item of issues) {
    const key = `${item.code ?? ""}:${item.nodeId ?? ""}:${item.field}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
