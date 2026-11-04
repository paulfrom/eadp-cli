import { CliError } from "../../errors.js";
import type { ResourceClient, ResourceRecord } from "../../resource/core/client.js";
import type { BlockingIssue } from "../../resource/core/errors.js";
import { selectFlow } from "../bpm/selection.js";
import { resolveNodeKind } from "./node-catalog.js";
import { graphReferences } from "./references.js";

/**
 * System-provided flow decision conditions.
 *
 * The BPM platform decides gateway routes from the condition properties a
 * business entity publishes (`conBusinessEntity/getConditionPropertiesExplain`).
 * Each property carries the engine variable (`code`), the business label
 * (`name`) the designer shows and stores in `logicUel`, and the initial value
 * the engine uses when it validates an expression.
 *
 * Nothing here is inferred from an external design: an agent must load the
 * target environment's list before it writes a gateway condition, because the
 * designer refuses to save an expression that references an unknown variable.
 */

export interface ConditionProperty {
  /** Engine variable used inside `groovyUel`, e.g. `fileType`. */
  code: string;
  /** Business label used inside `logicUel`, e.g. `文件类型`. */
  name: string;
  /** Initial value the engine evaluates the expression with. */
  initValue?: unknown;
  /** Free-text remark published by the business entity. */
  remark?: string;
}

export interface FlowConditionCatalog {
  flow: { code: string; name?: string };
  businessEntity: { code: string; name?: string };
  conditions: ConditionProperty[];
}

export interface ConditionAnalysis {
  designIssues: BlockingIssue[];
  warnings: BlockingIssue[];
}

/** Operators offered by the BPM expression editor. */
export const CONDITION_OPERATORS: readonly { name: string; code: string }[] = [
  { name: "小于", code: "<" },
  { name: "小于等于", code: "<=" },
  { name: "大于", code: ">" },
  { name: "大于等于", code: ">=" },
  { name: "等于", code: "==" },
  { name: "不等于", code: "!=" },
  { name: "并且", code: "&&" },
  { name: "或者", code: "||" },
  { name: "左括号", code: "(" },
  { name: "右括号", code: ")" }
];

/**
 * Branching priority. The system exclusive gateway wins whenever the route can
 * be decided from the condition properties the environment publishes; every
 * other gateway kind is a fallback for cases the platform cannot decide.
 */
export const CONDITION_PRIORITY = {
  rule: "业务分流优先使用系统排他网关（ExclusiveGateway），其优先级高于人工排他、包容和并行网关。",
  order: [
    {
      rank: 1,
      kind: "ExclusiveGateway",
      label: "系统排他网关",
      useWhen: "分支可以由系统按条件字段自动判定时使用。",
      reason: "优先级最高：条件由系统字段决定，路径唯一、可复现、可审计。"
    },
    {
      rank: 2,
      kind: "InclusiveGateway",
      label: "系统包容网关",
      useWhen: "多个条件可能同时成立且允许多条路径并行时使用。",
      reason: "仍属于系统判定，但需要确认多分支汇合语义。"
    },
    {
      rank: 3,
      kind: "ParallelGateway",
      label: "并行网关",
      useWhen: "无条件地同时进入多条独立路径时使用。",
      reason: "不依赖条件字段，只表达并行结构。"
    },
    {
      rank: 4,
      kind: "ManualExclusiveGateway",
      label: "人工排他网关",
      useWhen: "系统条件字段无法判定，必须由人在运行时选路时使用。",
      reason: "优先级最低：属于人工兜底，条件字段能判定时不得使用。"
    }
  ],
  rules: [
    "先加载系统条件字段（eadp bpm graph conditions），再决定用哪个网关。",
    "条件字段能判定的分流一律使用系统排他网关；人工排他网关需要说明为什么系统条件不可用。",
    "同一个网关内不要混用系统判定与人工选路。",
    "系统排他网关必须恰好一条默认边（uel.isDefault=true）。"
  ]
} as const;

/** Engine variables that are provided by the platform itself, not by the entity. */
const ENGINE_VARIABLES = new Set(["approveResult"]);

const GROOVY_KEYWORDS = new Set([
  "true", "false", "null", "def", "in", "as", "new", "return", "if", "else",
  "this", "it", "class", "import", "package", "void", "int", "long", "double",
  "float", "boolean", "char", "byte", "short", "instanceof", "switch", "case",
  "break", "continue", "while", "for", "try", "catch", "finally", "throw"
]);

const GRAPH_RESOURCE = "bpm-flow-graph";

/**
 * Read the condition properties one business entity publishes.
 */
export async function readConditionProperties(
  client: ResourceClient,
  businessEntityCode: string
): Promise<ConditionProperty[]> {
  const refs = graphReferences(client);
  const rows = await refs.conditionProperties(businessEntityCode);
  const properties: ConditionProperty[] = [];
  for (const row of rows) {
    const code = text(row.code);
    if (!code) continue;
    const name = text(row.name) ?? code;
    properties.push({
      code,
      name,
      ...(row.initValue === undefined ? {} : { initValue: row.initValue }),
      ...(text(row.remark) === undefined ? {} : { remark: text(row.remark)! })
    });
  }
  return properties;
}

/**
 * Resolve one flow type and list the condition fields its business entity
 * publishes. The flow selector accepts the flow type code, name or entity code.
 */
export async function loadFlowConditions(
  client: ResourceClient,
  flowSelector: string
): Promise<FlowConditionCatalog> {
  const refs = graphReferences(client);
  const [flows, entities] = await Promise.all([refs.flowTypes(), refs.businessEntities()]);
  const flow = selectTargetFlow(flows, entities, flowSelector);
  const code = requiredText(flow.code, "流程类型缺少 code");
  const entityId = text(flow.businessEntityId);
  if (!entityId) {
    throw new CliError(`流程类型 ${code} 未绑定业务实体，无法读取系统判定条件`, 1, {
      code: "GRAPH_FLOW_ENTITY_MISSING"
    });
  }
  const entity = entities.find((item) => text(item.id) === entityId);
  const entityCode = requiredText(
    entity?.code,
    `流程类型 ${code} 的业务实体缺少 code，无法读取系统判定条件`
  );
  const conditions = await readConditionProperties(client, entityCode);
  return {
    flow: { code, ...(text(flow.name) === undefined ? {} : { name: text(flow.name)! }) },
    businessEntity: {
      code: entityCode,
      ...(text(entity?.name) === undefined ? {} : { name: text(entity?.name)! })
    },
    conditions
  };
}

/**
 * Check every gateway condition of one canonical graph against the condition
 * fields the environment publishes.
 *
 * Unknown variables are a designer blocker: the designer validates the
 * expression against the entity's condition properties before saving an edge.
 */
export function analyzeGraphConditions(
  canonical: string,
  properties: readonly ConditionProperty[]
): ConditionAnalysis {
  const designIssues: BlockingIssue[] = [];
  const warnings: BlockingIssue[] = [];
  const graph = parseGraph(canonical);
  const process = isRecord(graph.process) ? graph.process : undefined;
  if (!process) return { designIssues, warnings };

  const knownCodes = new Set(properties.map((property) => property.code));
  const knownNames = new Set(properties.map((property) => property.name));

  const startUel = normalizeUel(process.startUEL);
  inspectCondition({
    uel: startUel,
    label: "流程启动条件",
    nodeId: undefined,
    nodeName: undefined,
    knownCodes,
    knownNames,
    designIssues,
    warnings
  });

  const nodes = isRecord(process.nodes) ? process.nodes : undefined;
  if (!nodes) return { designIssues, warnings };
  for (const [key, value] of Object.entries(nodes)) {
    if (!isRecord(value)) continue;
    const kind = resolveNodeKind(value).rule?.kind;
    // Only system-decided gateways carry conditions; approval edges use
    // `uel.agree` and manual gateways are chosen by a person at runtime.
    if (kind !== "ExclusiveGateway" && kind !== "InclusiveGateway") continue;
    const name = text(value.name) ?? key;
    const targets = Array.isArray(value.target) ? value.target : [];
    for (const target of targets) {
      if (!isRecord(target)) continue;
      const uel = normalizeUel(target.uel);
      const expression = text(uel.groovyUel);
      const isDefault = uel.isDefault === true || uel.isDefault === "true";
      if (!expression && isDefault) continue;
      const label = `【${name}】的连线`;
      inspectCondition({
        uel,
        label,
        nodeId: key,
        nodeName: name,
        knownCodes,
        knownNames,
        designIssues,
        warnings
      });
      if (!expression && !isDefault) {
        designIssues.push(issue(
          "CONDITION_EXPRESSION_MISSING",
          `${label}没有配置条件表达式，非默认路径必须配置条件`,
          key,
          name,
          "在设计器中为该连线配置表达式，或将其设为默认路径"
        ));
      }
    }
  }
  return { designIssues, warnings };
}

interface ConditionCheck {
  uel: Record<string, unknown>;
  label: string;
  nodeId: string | undefined;
  nodeName: string | undefined;
  knownCodes: Set<string>;
  knownNames: Set<string>;
  designIssues: BlockingIssue[];
  warnings: BlockingIssue[];
}

function inspectCondition(check: ConditionCheck): void {
  const { uel, label, nodeId, nodeName, knownCodes, knownNames, designIssues } = check;
  const groovy = text(uel.groovyUel);
  const logic = text(uel.logicUel);
  if (groovy) {
    for (const variable of extractConditionVariables(groovy)) {
      if (knownCodes.has(variable) || ENGINE_VARIABLES.has(variable)) continue;
      const available = [...knownCodes].join("、");
      designIssues.push(issue(
        "CONDITION_VARIABLE_UNKNOWN",
        `${label}使用了系统未提供的判定条件变量：${variable}`,
        nodeId,
        nodeName,
        "运行 eadp bpm graph conditions --env <环境> --flow <流程类型> 取回系统提供的条件字段" +
        `（当前可用：${available}）；若业务确实需要该变量，先在业务实体中发布该条件属性，再重新配置表达式`
      ));
    }
  }
  if (logic) {
    for (const name of extractUnknownPropertyNames(logic, [...knownNames])) {
      designIssues.push(issue(
        "CONDITION_PROPERTY_UNKNOWN",
        `${label}的中文条件引用了系统未提供的判定条件：${name}`,
        nodeId,
        nodeName,
        "运行 eadp bpm graph conditions --env <环境> --flow <流程类型> 取回系统提供的条件字段；" +
        "中文条件必须使用条件字段的名称，表达式必须使用它的 code"
      ));
    }
  }
  if (!groovy && logic) {
    designIssues.push(issue(
      "CONDITION_EXPRESSION_MISSING",
      `${label}只有中文条件，缺少可执行表达式`,
      nodeId,
      nodeName,
      "同时配置 groovyUel（使用条件字段 code，形如 #{code==\"值\"}）"
    ));
  }
}

/**
 * Extract the variables a groovy expression reads. String literals, property
 * access, keywords and platform variables are not business conditions.
 */
export function extractConditionVariables(expression: string): string[] {
  const body = stripLiterals(expression);
  const found = new Set<string>();
  const pattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const token = match[0];
    const index = match.index;
    const previous = body[index - 1];
    if (previous === "." || previous === "?") continue;
    if (GROOVY_KEYWORDS.has(token)) continue;
    if (ENGINE_VARIABLES.has(token)) continue;
    found.add(token);
  }
  return [...found].sort();
}

/**
 * Find the Chinese condition labels that do not exist in the published list.
 * Known labels are removed first (longest first, like the designer does), then
 * operators, literals and numbers; whatever text is left names an unknown field.
 */
export function extractUnknownPropertyNames(
  logic: string,
  knownNames: readonly string[]
): string[] {
  let rest = stripLiterals(logic);
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (name === "") continue;
    rest = rest.split(name).join(" ");
  }
  rest = rest.replace(/[（）()\[\]{}]/g, " ");
  rest = rest.replace(/==|!=|<=|>=|&&|\|\||[!<>]/g, " ");
  rest = rest.replace(/[0-9]/g, " ");
  const unknown = new Set<string>();
  for (const token of rest.split(/\s+/)) {
    if (token === "") continue;
    if (!/[\u4e00-\u9fff]/.test(token)) continue;
    unknown.add(token);
  }
  return [...unknown].sort();
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
        error.message.replace("源环境", "目标环境"),
        1,
        { code: error.code }
      );
    }
    throw error;
  }
}

function parseGraph(canonical: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(canonical) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUel(value: unknown): Record<string, unknown> {
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

function stripLiterals(expression: string): string {
  return expression
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
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
    scope: nodeId === undefined ? "graph" : "edge",
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(nodeName === undefined ? {} : { nodeName }),
    ...(fix === undefined ? {} : { fix })
  };
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CliError(message);
  return value.trim();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
