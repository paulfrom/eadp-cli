import { CliError } from "../../errors.js";
import type { ResourceClient, ResourceRecord } from "../../resource/core/client.js";
import type { BlockingIssue } from "../../resource/core/errors.js";
import { selectFlow } from "../bpm/selection.js";
import {
  conditionExpressionBody,
  conditionExpressionsMatch,
  extractUnknownPropertyNames,
  validateConditionExpression
} from "./expression.js";
import { resolveNodeKind } from "./node-catalog.js";
import { graphReferences } from "./references.js";

export { buildConditionExpression, extractUnknownPropertyNames } from "./expression.js";

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
  /** Target flow ID is required by the designer's validateExpression endpoint. */
  flowTypeId: string;
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
export const CONDITION_EXPRESSION_CONTRACT = {
  command: "eadp bpm graph expression --env <target> --flow <flow-code> --logic '<中文条件表达式>'",
  input: "logicUel 使用条件字段 name；字符串、数字、布尔值和允许值必须有明确业务语义。",
  output: "expression.logicUel 与 expression.groovyUel 可直接用于 process.startUEL 或系统网关连线的 uel。",
  wrapper: "#{...}",
  serverValidation: "conBusinessEntity/validateExpression 使用目标流程类型和条件 initValue 校验 JUEL；false 求值结果仍代表表达式合法。",
  rules: [
    "只手写 logicUel，由 graph expression 生成 groovyUel，不要分别维护两份。",
    "groovyUel 必须恰好使用 #{...} 包裹，不使用 ${...}，也不能是裸表达式。",
    "条件 name 按最长优先替换为 code，字符串字面量中的同名文本不替换。",
    "非默认系统网关路径必须有表达式；默认路径不配置表达式。"
  ]
} as const;

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
  const flowTypeId = requiredText(flow.id, `流程类型 ${code} 缺少 ID`);
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
    flowTypeId,
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
  const knownCodes = new Set(properties.map((property) => property.code));
  const knownNames = new Set(properties.map((property) => property.name));

  for (const entry of collectConditionEntries(canonical)) {
    inspectCondition({
      ...entry,
      knownCodes,
      knownNames,
      properties,
      designIssues,
      warnings
    });
    const expression = text(entry.uel.groovyUel);
    if (!expression && entry.required) {
      designIssues.push(issue(
        "CONDITION_EXPRESSION_MISSING",
        `${entry.label}没有配置条件表达式，非默认路径必须配置条件`,
        entry.nodeId,
        entry.nodeName,
        "使用 eadp bpm graph expression 根据中文条件生成表达式，或将该连线设为默认路径"
      ));
    }
  }
  return { designIssues, warnings };
}

interface ConditionEntry {
  uel: Record<string, unknown>;
  label: string;
  nodeId: string | undefined;
  nodeName: string | undefined;
  /** Start conditions are optional; non-default gateway exits are required. */
  required: boolean;
}

function collectConditionEntries(canonical: string): ConditionEntry[] {
  const graph = parseGraph(canonical);
  const process = isRecord(graph.process) ? graph.process : undefined;
  if (!process) return [];
  const entries: ConditionEntry[] = [{
    uel: normalizeUel(process.startUEL),
    label: "流程启动条件",
    nodeId: undefined,
    nodeName: undefined,
    required: false
  }];

  const nodes = isRecord(process.nodes) ? process.nodes : undefined;
  if (!nodes) return entries;
  for (const [key, value] of Object.entries(nodes)) {
    if (!isRecord(value)) continue;
    const kind = resolveNodeKind(value).rule?.kind;
    // Approval edges use uel.agree; manual gateways are selected by a person.
    if (kind !== "ExclusiveGateway" && kind !== "InclusiveGateway") continue;
    const name = text(value.name) ?? key;
    const targets = Array.isArray(value.target) ? value.target : [];
    for (const target of targets) {
      if (!isRecord(target)) continue;
      const uel = normalizeUel(target.uel);
      const expression = text(uel.groovyUel);
      const isDefault = uel.isDefault === true || uel.isDefault === "true";
      if (!expression && isDefault) continue;
      entries.push({
        uel,
        label: `【${name}】的连线`,
        nodeId: key,
        nodeName: name,
        required: !isDefault
      });
    }
  }
  return entries;
}

interface ConditionCheck extends ConditionEntry {
  knownCodes: Set<string>;
  knownNames: Set<string>;
  properties: readonly ConditionProperty[];
  designIssues: BlockingIssue[];
  warnings: BlockingIssue[];
}

function inspectCondition(check: ConditionCheck): void {
  const {
    uel, label, nodeId, nodeName, knownCodes, knownNames, properties, designIssues
  } = check;
  const groovy = text(uel.groovyUel);
  const logic = text(uel.logicUel);
  if (groovy) {
    if (conditionExpressionBody(groovy) === undefined) {
      designIssues.push(issue(
        "CONDITION_EXPRESSION_INVALID",
        `${label}的 groovyUel 必须是完整的 #{...} 表达式且内容不能为空`,
        nodeId,
        nodeName,
        "不要直接使用 ${...}、裸表达式或嵌套包裹；可用 eadp bpm graph expression 重新生成"
      ));
    }
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
    if (groovy && !conditionExpressionsMatch(logic, groovy, properties)) {
      designIssues.push(issue(
        "CONDITION_EXPRESSION_MISMATCH",
        `${label}的 logicUel 与 groovyUel 不是同一条件`,
        nodeId,
        nodeName,
        "只维护中文 logicUel，并用 eadp bpm graph expression 重新生成 groovyUel，不要分别手写两份"
      ));
    }
  }
  if (!groovy && logic) {
    designIssues.push(issue(
      "CONDITION_EXPRESSION_MISSING",
      `${label}只有中文条件，缺少可执行表达式`,
      nodeId,
      nodeName,
      "使用 eadp bpm graph expression 根据 logicUel 生成 groovyUel"
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

export interface RemoteConditionAnalysis extends ConditionAnalysis {
  /** Expression locations sent to the target environment. */
  attempted: number;
  validated: number;
  failed: number;
}

/** Cache by expression text so repeated branches are validated only once. */
export type ConditionExpressionValidationCache = Map<string, Promise<string | undefined>>;

/**
 * Apply the designer's server-side JUEL validation to every locally plausible
 * expression. Unknown variables and malformed wrappers are already reported by
 * local analysis, so those expressions are not sent a second time.
 */
export async function analyzeRemoteGraphConditions(
  client: ResourceClient,
  flowTypeId: string,
  canonical: string,
  properties: readonly ConditionProperty[],
  cache: ConditionExpressionValidationCache = new Map()
): Promise<RemoteConditionAnalysis> {
  const designIssues: BlockingIssue[] = [];
  const knownCodes = new Set(properties.map((property) => property.code));
  let attempted = 0;
  let validated = 0;
  let failed = 0;

  for (const entry of collectConditionEntries(canonical)) {
    const expression = text(entry.uel.groovyUel);
    if (!expression || conditionExpressionBody(expression) === undefined) continue;
    const variables = extractConditionVariables(expression);
    if (variables.some((variable) => !knownCodes.has(variable) && !ENGINE_VARIABLES.has(variable))) {
      continue;
    }
    attempted += 1;
    let pending = cache.get(expression);
    if (!pending) {
      pending = validateConditionExpression(client, flowTypeId, expression)
        .then(() => undefined)
        .catch((error: unknown) => {
          // A ResultData(success=false) is the validator's normal negative
          // answer. Transport/HTTP failures must stop the command instead of
          // being misreported as an invalid expression or followed by writes.
          if (error instanceof CliError && error.message.startsWith("EADP 请求失败：")) {
            return error.message;
          }
          throw error;
        });
      cache.set(expression, pending);
    }
    const failure = await pending;
    if (failure === undefined) {
      validated += 1;
      continue;
    }
    failed += 1;
    designIssues.push(issue(
      "CONDITION_EXPRESSION_INVALID",
      `${entry.label}的表达式未通过目标环境校验：${failure}`,
      entry.nodeId,
      entry.nodeName,
      "按服务端返回修正 JUEL 语法、运算符或条件值类型；可用 eadp bpm graph expression 单独生成并校验"
    ));
  }
  return { designIssues, warnings: [], attempted, validated, failed };
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
