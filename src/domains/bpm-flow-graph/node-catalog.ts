/**
 * BPM node capability catalog.
 *
 * This is the CLI's own, self-contained contract for BPM nodes. The CLI never
 * reads, imports or resolves any external repository or source file: the table
 * below is the complete runtime source of truth, and it ships inside the CLI.
 *
 * The rules mirror the BPM designer's save-time behavior, but they are expressed
 * as plain data so `bpm graph nodes`, `bpm graph validate` and the migration
 * pipeline can use them without a browser or a front-end checkout.
 */
import type { ResourceRecord } from "../../resource/core/client.js";
import { nodeUsageForKind } from "./node-usage.js";

/** Bump when the embedded contract changes; exposed by `bpm graph nodes`. */
export const CATALOG_VERSION = "2026-11-05";


export type NodeGroup = "event" | "task" | "gateway";
export type NodeDiscriminator = "type" | "nodeType" | "busType";
export type NodeMigrationPolicy = "supported" | "blocked";

export type GraphIssueCode =
  | "GRAPH_PROCESS_MISSING"
  | "GRAPH_NODES_MISSING"
  | "NODE_TYPE_MISSING"
  | "NODE_TYPE_UNSUPPORTED"
  | "NODE_KIND_MISSING"
  | "NODE_KIND_MISMATCH"
  | "NODE_LEGACY_KIND"
  | "NODE_ID_MISSING"
  | "NODE_ID_MISMATCH"
  | "NODE_NAME_MISSING"
  | "NODE_CONFIG_EMPTY"
  | "NODE_REQUIRED_FIELD_MISSING"
  | "NODE_PAGE_MISSING"
  | "NODE_EXECUTOR_MISSING"
  | "NODE_EXECUTOR_TYPE_MISSING"
  | "NODE_EXECUTOR_TYPE_UNSUPPORTED"
  | "NODE_EXECUTOR_LEGACY_TYPE"
  | "NODE_EXECUTOR_COMPOSITE_INCOMPLETE"
  | "NODE_SERVICE_MISSING"
  | "NODE_ENTRY_MISSING"
  | "NODE_EXIT_MISSING"
  | "NODE_EXIT_COUNT"
  | "NODE_AGREE_EDGE"
  | "NODE_DEFAULT_EDGE"
  | "NODE_REVERSE_NOT_SET"
  | "EDGE_TARGET_MISSING"
  | "EDGE_TARGET_UNKNOWN"
  | "START_COUNT"
  | "END_COUNT"
  | "CALL_ACTIVITY_BLOCKED"
  | "PROJECT_POSITION_BLOCKED"
  | "SMART_AUDIT_BLOCKED"
  | "EXECUTOR_FIDELITY_LOSS";

export interface NodeIssue {
  code: GraphIssueCode;
  severity: "error" | "warning";
  field?: string;
  nodeId?: string;
  nodeName?: string;
  message: string;
  fix?: string;
}

export interface NodeEdgeRules {
  minIn: number;
  minOut: number;
  maxOut?: number;
  /** Exactly one outgoing edge must carry `uel.agree === true`. */
  agreeEdge?: boolean;
  /** Exactly one outgoing edge must carry `uel.isDefault === true`. */
  defaultEdge?: boolean;
  /** Participates in the "no reverse flag anywhere" confirmation. */
  reverseWarning?: boolean;
}

export interface NodeNormalRules {
  /** `normal.id` (source) or `normal.pageUrl` (canonical) is required. */
  page?: boolean;
  /** Required `nodeConfig.normal.*` fields, e.g. counterDecision. */
  requiredFields?: readonly string[];
}

export interface NodeExecutorRules {
  required: boolean;
  /** Executor type keys the current designer can submit. */
  allowedTypes: readonly string[];
  /** Types accepted for migration but no longer offered by the designer. */
  legacyTypes?: readonly string[];
  /** Types that cannot be migrated at all. */
  blockedTypes?: readonly string[];
  /** Composite types and their required `userType` fragments. */
  composites?: Readonly<Record<string, readonly string[]>>;
}

export interface NodeRule {
  kind: string;
  title: string;
  group: NodeGroup;
  engineType: string;
  discriminator: NodeDiscriminator;
  configKeys: readonly string[];
  normal?: NodeNormalRules;
  serviceRequired?: boolean;
  executor?: NodeExecutorRules;
  edges: NodeEdgeRules;
  migration: { policy: NodeMigrationPolicy; reason?: string };
  /** Historical engine type that the current designer no longer produces. */
  legacy?: boolean;
}

/** Executor types offered by the current designer (`constants.js`). */
export const CURRENT_EXECUTOR_TYPES = [
  "StartUser",
  "Person",
  "Position",
  "PositionType",
  "SelfDefinition",
  "AnyOne",
  "PositionTypeAndOrg"
] as const;

/** Executor types kept for historical flows. */
export const LEGACY_EXECUTOR_TYPES = ["Org", "OrganizationDimension"] as const;

/** Types that cannot be re-mapped across environments. */
export const BLOCKED_EXECUTOR_TYPES = ["ProjectPosition"] as const;

const HUMAN_EXECUTOR: NodeExecutorRules = {
  required: true,
  allowedTypes: CURRENT_EXECUTOR_TYPES,
  legacyTypes: LEGACY_EXECUTOR_TYPES,
  blockedTypes: BLOCKED_EXECUTOR_TYPES,
  composites: { PositionTypeAndOrg: ["PositionType", "Org"] }
};

const HUMAN_CONFIG = ["normal", "executor", "event", "notify", "smartAudit"] as const;
const SERVICE_CONFIG = ["normal", "event", "notify"] as const;
const NOTIFY_CONFIG = ["normal", "notify"] as const;
const IN_OUT = { minIn: 1, minOut: 1 } as const;

export const NODE_RULES: readonly NodeRule[] = [
  {
    kind: "StartEvent",
    title: "开始",
    group: "event",
    engineType: "StartEvent",
    discriminator: "type",
    configKeys: [],
    edges: { minIn: 0, minOut: 1 },
    migration: { policy: "supported" }
  },
  {
    kind: "EndEvent",
    title: "结束",
    group: "event",
    engineType: "EndEvent",
    discriminator: "type",
    configKeys: NOTIFY_CONFIG,
    edges: { minIn: 1, minOut: 0 },
    migration: { policy: "supported" }
  },
  {
    kind: "TerminateEndEvent",
    title: "终止结束",
    group: "event",
    engineType: "TerminateEndEvent",
    discriminator: "type",
    configKeys: NOTIFY_CONFIG,
    edges: { minIn: 1, minOut: 0 },
    migration: { policy: "supported" }
  },
  {
    kind: "Normal",
    title: "普通任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true },
    executor: HUMAN_EXECUTOR,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "SingleSign",
    title: "单签任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true },
    executor: HUMAN_EXECUTOR,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "Approve",
    title: "审批任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true },
    executor: HUMAN_EXECUTOR,
    edges: { ...IN_OUT, minOut: 2, maxOut: 2, agreeEdge: true, reverseWarning: true },
    migration: { policy: "supported" }
  },
  {
    kind: "CounterSign",
    title: "会签任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true, requiredFields: ["counterDecision"] },
    executor: HUMAN_EXECUTOR,
    edges: { ...IN_OUT, minOut: 2, maxOut: 2, agreeEdge: true },
    migration: { policy: "supported" }
  },
  {
    kind: "ParallelTask",
    title: "并行任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true },
    executor: HUMAN_EXECUTOR,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "SerialTask",
    title: "串行任务",
    group: "task",
    engineType: "UserTask",
    discriminator: "nodeType",
    configKeys: HUMAN_CONFIG,
    normal: { page: true },
    executor: HUMAN_EXECUTOR,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "ServiceTask",
    title: "服务任务",
    group: "task",
    engineType: "ServiceTask",
    discriminator: "nodeType",
    configKeys: SERVICE_CONFIG,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "ManualTask",
    title: "占位任务",
    group: "task",
    engineType: "ManualTask",
    discriminator: "nodeType",
    configKeys: [],
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "ReceiveTask",
    title: "触发任务",
    group: "task",
    engineType: "ReceiveTask",
    discriminator: "nodeType",
    configKeys: SERVICE_CONFIG,
    serviceRequired: true,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "AgentTask",
    title: "智能体任务",
    group: "task",
    engineType: "AgentTask",
    discriminator: "nodeType",
    configKeys: SERVICE_CONFIG,
    normal: { requiredFields: ["executorName", "agentTemplate", "outTime"] },
    serviceRequired: true,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "PoolTask",
    title: "工作池任务",
    group: "task",
    engineType: "PoolTask",
    discriminator: "nodeType",
    configKeys: ["normal", "event", "notify", "smartAudit"],
    normal: { page: true, requiredFields: ["poolTaskCode"] },
    serviceRequired: true,
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "CallActivity",
    title: "子流程",
    group: "task",
    engineType: "CallActivity",
    discriminator: "nodeType",
    configKeys: ["normal"],
    normal: { requiredFields: ["callActivityDefId"] },
    edges: IN_OUT,
    migration: {
      policy: "blocked",
      reason: "子流程（CallActivity）依赖目标环境已发布的子流程版本，v1 不支持跨环境迁移"
    }
  },
  {
    kind: "ExclusiveGateway",
    title: "系统排他网关",
    group: "gateway",
    engineType: "ExclusiveGateway",
    discriminator: "busType",
    configKeys: [],
    edges: { minIn: 1, minOut: 2, defaultEdge: true, reverseWarning: true },
    migration: { policy: "supported" }
  },
  {
    kind: "ManualExclusiveGateway",
    title: "人工排他网关",
    group: "gateway",
    engineType: "ExclusiveGateway",
    discriminator: "busType",
    configKeys: [],
    edges: { minIn: 1, minOut: 2, reverseWarning: true },
    migration: { policy: "supported" }
  },
  {
    kind: "ParallelGateway",
    title: "并行网关",
    group: "gateway",
    engineType: "ParallelGateway",
    discriminator: "busType",
    configKeys: [],
    edges: IN_OUT,
    migration: { policy: "supported" }
  },
  {
    kind: "InclusiveGateway",
    title: "包容网关",
    group: "gateway",
    engineType: "InclusiveGateway",
    discriminator: "busType",
    configKeys: [],
    edges: { minIn: 1, minOut: 1, defaultEdge: true, reverseWarning: true },
    migration: { policy: "supported" }
  },
  {
    kind: "MailTask",
    title: "邮件任务（历史）",
    group: "task",
    engineType: "MailTask",
    discriminator: "type",
    configKeys: [],
    edges: IN_OUT,
    migration: { policy: "supported" },
    legacy: true
  },
  {
    kind: "ScriptTask",
    title: "脚本任务（历史）",
    group: "task",
    engineType: "ScriptTask",
    discriminator: "type",
    configKeys: [],
    edges: IN_OUT,
    migration: { policy: "supported" },
    legacy: true
  },
  {
    kind: "EventGateway",
    title: "事件网关（历史）",
    group: "gateway",
    engineType: "EventGateway",
    discriminator: "type",
    configKeys: [],
    edges: IN_OUT,
    migration: { policy: "supported" },
    legacy: true
  }
];

const RULES_BY_KIND = new Map<string, NodeRule>(NODE_RULES.map((rule) => [rule.kind, rule]));

export function nodeRuleByKind(kind: string): NodeRule | undefined {
  return RULES_BY_KIND.get(kind);
}

export interface NodeResolution {
  rule?: NodeRule;
  kind?: string;
  issues: NodeIssue[];
}

/**
 * Resolve the designer-level node kind from `type` plus `nodeType` / `busType`.
 *
 * The designer stores `type` as the engine type, `nodeType` as the task kind and
 * `busType` as the gateway kind. A node such as `Approve` therefore has
 * `type: "UserTask"` + `nodeType: "Approve"`.
 */
export function resolveNodeKind(node: ResourceRecord): NodeResolution {
  const type = text(node.type);
  if (!type) {
    return {
      issues: [{
        code: "NODE_TYPE_MISSING",
        severity: "error",
        field: "type",
        message: "节点缺少 type"
      }]
    };
  }

  const eventRule = RULES_BY_KIND.get(type);
  if (eventRule && eventRule.group === "event") {
    return { rule: eventRule, kind: eventRule.kind, issues: [] };
  }

  if (type === "UserTask") {
    const kind = text(node.nodeType);
    if (!kind) {
      return {
        issues: [{
          code: "NODE_KIND_MISSING",
          severity: "error",
          field: "nodeType",
          message: "人工任务缺少 nodeType（Normal/SingleSign/Approve/CounterSign/ParallelTask/SerialTask）"
        }]
      };
    }
    const rule = RULES_BY_KIND.get(kind);
    if (!rule || rule.engineType !== "UserTask") {
      return {
        kind,
        issues: [{
          code: "NODE_KIND_MISMATCH",
          severity: "error",
          field: "nodeType",
          message: `人工任务的 nodeType 不受支持：${kind}`,
          fix: "使用 Normal/SingleSign/Approve/CounterSign/ParallelTask/SerialTask"
        }]
      };
    }
    return { rule, kind, issues: [] };
  }

  if (type === "ExclusiveGateway") {
    const kind = text(node.busType) ?? "ExclusiveGateway";
    const rule = RULES_BY_KIND.get(kind);
    if (!rule || rule.engineType !== "ExclusiveGateway") {
      return {
        kind,
        issues: [{
          code: "NODE_KIND_MISMATCH",
          severity: "error",
          field: "busType",
          message: `排他网关的 busType 不受支持：${kind}`,
          fix: "使用 ExclusiveGateway（系统排他）或 ManualExclusiveGateway（人工排他）"
        }]
      };
    }
    return { rule, kind, issues: [] };
  }

  if (type === "ParallelGateway" || type === "InclusiveGateway") {
    const kind = text(node.busType) ?? type;
    const rule = RULES_BY_KIND.get(kind);
    if (!rule || rule.engineType !== type) {
      return {
        kind,
        issues: [{
          code: "NODE_KIND_MISMATCH",
          severity: "error",
          field: "busType",
          message: `网关 ${type} 的 busType 不受支持：${kind}`
        }]
      };
    }
    return { rule, kind, issues: [] };
  }

  const kind = text(node.nodeType) ?? type;
  const rule = RULES_BY_KIND.get(kind) ?? RULES_BY_KIND.get(type);
  if (!rule) {
    return {
      kind,
      issues: [{
        code: "NODE_TYPE_UNSUPPORTED",
        severity: "error",
        field: "type",
        message: `节点 type 不受支持：${type}`,
        fix: "运行 eadp bpm graph nodes 查看支持的节点类型"
      }]
    };
  }
  if (rule.engineType !== type) {
    return {
      kind,
      issues: [{
        code: "NODE_KIND_MISMATCH",
        severity: "error",
        field: "type",
        message: `节点声明不一致：type=${type}，nodeType=${kind}`,
        fix: rule.discriminator === "nodeType"
          ? `使用 type=${rule.engineType} + nodeType=${rule.kind}`
          : rule.discriminator === "busType"
            ? `使用 type=${rule.engineType} + busType=${rule.kind}`
            : `使用 type=${rule.engineType}`
      }]
    };
  }
  return { rule, kind: rule.kind, issues: [] };
}

export interface NodeCatalogFilter {
  group?: string;
  kind?: string;
  includeLegacy?: boolean;
}

export function listNodeRules(filter: NodeCatalogFilter = {}): NodeRule[] {
  return NODE_RULES.filter((rule) => {
    if (!filter.includeLegacy && rule.legacy) return false;
    if (filter.group && rule.group !== filter.group) return false;
    if (filter.kind && rule.kind !== filter.kind) return false;
    return true;
  });
}

/** JSON-friendly catalog entry used by `eadp bpm graph nodes`. */
export function describeNodeRule(rule: NodeRule): Record<string, unknown> {
  const example: Record<string, unknown> = {
    id: `${rule.kind}_1`,
    type: rule.engineType,
    name: rule.title,
    target: [],
    nodeConfig: {}
  };
  if (rule.discriminator === "nodeType") example.nodeType = rule.kind;
  if (rule.discriminator === "busType") example.busType = rule.kind;
  const usage = nodeUsageForKind(rule.kind);
  return {
    kind: rule.kind,
    title: rule.title,
    group: rule.group,
    engineType: rule.engineType,
    discriminator: rule.discriminator,
    usage: {
      summary: usage.summary,
      exampleScenarios: [...usage.exampleScenarios],
      notFor: [...usage.notFor],
      requiredInputs: [...usage.requiredInputs],
      askWhenUnclear: [...usage.askWhenUnclear]
    },
    configKeys: [...rule.configKeys],
    ...(rule.normal
      ? {
        normal: {
          page: rule.normal.page === true,
          requiredFields: [...(rule.normal.requiredFields ?? [])]
        }
      }
      : {}),
    ...(rule.serviceRequired ? { serviceRequired: true } : {}),
    ...(rule.executor
      ? {
        executor: {
          required: rule.executor.required,
          allowedTypes: [...rule.executor.allowedTypes],
          legacyTypes: [...(rule.executor.legacyTypes ?? [])],
          blockedTypes: [...(rule.executor.blockedTypes ?? [])],
          composites: { ...(rule.executor.composites ?? {}) }
        }
      }
      : {}),
    edges: { ...rule.edges },
    migration: { ...rule.migration },
    legacy: rule.legacy === true,
    example
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
