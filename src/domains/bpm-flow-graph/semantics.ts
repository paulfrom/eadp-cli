import type { BlockingIssue } from "../../resource/core/errors.js";
import type { ResourceRecord } from "../../resource/core/client.js";
import { resolveNodeKind } from "./node-catalog.js";

const GRAPH_RESOURCE = "bpm-flow-graph";
const MAX_DNF_CLAUSES = 128;

interface EdgeEntry {
  sourceId: string;
  sourceName: string;
  targetId?: string;
  targetIndex: number;
  edgeId: string;
  jsonPath: string;
  uel: ResourceRecord;
}

/** Semantic, designer-level checks. Structural migration blockers stay in analysis.ts. */
export function analyzeGraphSemantics(graph: ResourceRecord): BlockingIssue[] {
  const process = isRecord(graph.process) ? graph.process : undefined;
  const nodes = process && isRecord(process.nodes) ? process.nodes : undefined;
  if (!nodes) return [];

  const entries = Object.entries(nodes).filter((entry): entry is [string, ResourceRecord] =>
    isRecord(entry[1])
  );
  const keys = new Set(Object.keys(nodes));
  const edges = new Map<string, EdgeEntry[]>();
  const issues: BlockingIssue[] = [];
  const seenEdgeIds = new Map<string, EdgeEntry>();

  for (const [nodeId, node] of entries) {
    const nodeName = text(node.name) ?? nodeId;
    const targets = Array.isArray(node.target) ? node.target : [];
    const list: EdgeEntry[] = [];
    for (const [targetIndex, value] of targets.entries()) {
      if (!isRecord(value)) continue;
      const uel = normalizeUel(value.uel);
      const targetId = text(value.targetId);
      const declaredId = text(value.id) ?? text(value.edgeId) ?? text(uel.id);
      const edgeId = declaredId ?? `${nodeId}->${targetId ?? "?"}[${targetIndex}]`;
      const jsonPath = `process.nodes.${nodeId}.target[${targetIndex}]`;
      const edge: EdgeEntry = {
        sourceId: nodeId,
        sourceName: nodeName,
        ...(targetId === undefined ? {} : { targetId }),
        targetIndex,
        edgeId,
        jsonPath,
        uel
      };
      list.push(edge);

      if (declaredId) {
        const previous = seenEdgeIds.get(declaredId);
        if (previous) {
          issues.push(semanticIssue(
            "EDGE_ID_DUPLICATE",
            `边 ${declaredId} 的 id 重复：${previous.jsonPath} 与 ${jsonPath}`,
            nodeId,
            nodeName,
            "为每条边分配全图唯一 id，不要复制已有边的 id",
            edge
          ));
        } else {
          seenEdgeIds.set(declaredId, edge);
        }
      }

      if (!targetId || !keys.has(targetId)) {
        issues.push(semanticIssue(
          "EDGE_DANGLING",
          `边 ${edgeId} 悬空：${nodeId} -> ${targetId ?? "<缺少 targetId>"}`,
          nodeId,
          nodeName,
          "把 targetId 改为 process.nodes 中存在的节点，或删除该悬空边",
          edge
        ));
      }
      if (hasExpression(uel) && !text(uel.name)) {
        issues.push(semanticIssue(
          "CONDITION_LABEL_MISSING",
          `边 ${edgeId}（${nodeId} -> ${targetId ?? "?"}）携带表达式，但 uel.name 为空或空白`,
          nodeId,
          nodeName,
          "为该边设置能说明业务条件的 uel.name；不要只填写 logicUel/groovyUel",
          edge,
          `${jsonPath}.uel.name`
        ));
      }
    }
    edges.set(nodeId, list);
  }

  inspectReachability(entries, edges, issues);
  inspectUnexpectedCycles(entries, edges, issues);
  inspectExclusiveConditions(entries, edges, issues);
  return dedupe(issues);
}

function inspectReachability(
  entries: [string, ResourceRecord][],
  edges: Map<string, EdgeEntry[]>,
  issues: BlockingIssue[]
): void {
  const starts = entries
    .filter(([, node]) => resolveNodeKind(node).rule?.kind === "StartEvent")
    .map(([id]) => id);
  const reachable = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges.get(current) ?? []) {
      if (!edge.targetId || reachable.has(edge.targetId)) continue;
      reachable.add(edge.targetId);
      queue.push(edge.targetId);
    }
  }
  for (const [nodeId, node] of entries) {
    if (reachable.has(nodeId) || resolveNodeKind(node).rule?.kind === "StartEvent") continue;
    const name = text(node.name) ?? nodeId;
    issues.push(semanticIssue(
      "NODE_UNREACHABLE",
      `节点 ${name}(${nodeId}) 从 StartEvent 不可达`,
      nodeId,
      name,
      "补上从可到达节点到该节点的路径，或删除无业务用途的节点"
    ));
  }
}

function inspectUnexpectedCycles(
  entries: [string, ResourceRecord][],
  edges: Map<string, EdgeEntry[]>,
  issues: BlockingIssue[]
): void {
  // Tarjan SCC over forward edges only. A cycle containing an explicitly marked
  // reverse/reject edge is expected and therefore excluded from this graph.
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const reported = new Set<string>();

  const visit = (nodeId: string): void => {
    const index = nextIndex++;
    indices.set(nodeId, index);
    low.set(nodeId, index);
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const edge of edges.get(nodeId) ?? []) {
      if (!edge.targetId || !indices.has(edge.targetId) && !entries.some(([id]) => id === edge.targetId)) {
        continue;
      }
      if (isReverse(edge.uel)) continue;
      const target = edge.targetId;
      if (!indices.has(target)) {
        visit(target);
        low.set(nodeId, Math.min(low.get(nodeId)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(nodeId, Math.min(low.get(nodeId)!, indices.get(target)!));
      }
    }
    if (low.get(nodeId) !== indices.get(nodeId)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    const selfLoop = component.length === 1 && (edges.get(nodeId) ?? []).some((edge) =>
      edge.targetId === nodeId && !isReverse(edge.uel)
    );
    if (component.length === 1 && !selfLoop) return;
    const cycle = [...component].sort();
    const key = cycle.join("|");
    if (reported.has(key)) return;
    reported.add(key);
    const owner = cycle[0]!;
    const ownerNode = entries.find(([id]) => id === owner)?.[1];
    const ownerName = ownerNode ? text(ownerNode.name) ?? owner : owner;
    issues.push(semanticIssue(
      "GRAPH_CYCLE_UNEXPECTED",
      `检测到非预期环：${cycle.join(" -> ")}；环内没有 uel.isReverse=true 的驳回边`,
      owner,
      ownerName,
      "删除误接的回边；若确为驳回/修改后重审，只在真实驳回边上设置 uel.isReverse=true"
    ));
  };

  for (const [nodeId] of entries) {
    if (!indices.has(nodeId)) visit(nodeId);
  }
}

function inspectExclusiveConditions(
  entries: [string, ResourceRecord][],
  edges: Map<string, EdgeEntry[]>,
  issues: BlockingIssue[]
): void {
  for (const [nodeId, node] of entries) {
    if (resolveNodeKind(node).rule?.kind !== "ExclusiveGateway") continue;
    const name = text(node.name) ?? nodeId;
    const outgoing = edges.get(nodeId) ?? [];
    const hasDefault = outgoing.some((edge) => edge.uel.isDefault === true || edge.uel.isDefault === "true");
    const conditions = outgoing.filter((edge) =>
      edge.uel.isDefault !== true && edge.uel.isDefault !== "true" && hasExpression(edge.uel)
    );

    for (let left = 0; left < conditions.length; left += 1) {
      for (let right = left + 1; right < conditions.length; right += 1) {
        const a = conditions[left]!;
        const b = conditions[right]!;
        if (!conditionsOverlap(expressionOf(a.uel), expressionOf(b.uel))) continue;
        issues.push(semanticIssue(
          "CONDITION_OVERLAP",
          `排他网关 ${name}(${nodeId}) 的出边条件可能同时成立：${a.edgeId} 与 ${b.edgeId}`,
          nodeId,
          name,
          "调整阈值/枚举条件使两条路径互斥，或改用包容网关表达允许多命中的语义",
          a,
          `${a.jsonPath}.uel`,
          `${b.edgeId} (${b.jsonPath})`
        ));
      }
    }

    if (!hasDefault && outgoing.length > 0) {
      const union = conditions
        .map((edge) => expressionOf(edge.uel))
        .filter(Boolean)
        .map((expression) => `(${unwrapExpression(expression)})`)
        .join("||");
      if (!isCompleteCondition(union) || conditions.length !== outgoing.length) {
        issues.push(semanticIssue(
          "CONDITION_COVERAGE_INCOMPLETE",
          `排他网关 ${name}(${nodeId}) 的非默认出边条件不能证明覆盖全部输入，且没有默认边`,
          nodeId,
          name,
          "补齐条件全集，或设置一条 uel.isDefault=true 的默认边承载未命中输入"
        ));
      }
    }
  }
}

function hasExpression(uel: ResourceRecord): boolean {
  return text(uel.groovyUel) !== undefined || text(uel.logicUel) !== undefined;
}

function expressionOf(uel: ResourceRecord): string {
  return text(uel.groovyUel) ?? text(uel.logicUel) ?? "";
}

function isReverse(uel: ResourceRecord): boolean {
  return uel.isReverse === true || uel.isReverse === "true";
}

function semanticIssue(
  code: string,
  message: string,
  nodeId: string,
  nodeName: string,
  fix: string,
  edge?: EdgeEntry,
  jsonPath?: string,
  value?: string
): BlockingIssue {
  return {
    resource: GRAPH_RESOURCE,
    field: jsonPath ?? edge?.jsonPath ?? "graph",
    reason: "invalid",
    message,
    code,
    severity: "error",
    scope: edge ? "edge" : nodeId ? "node" : "graph",
    nodeId,
    nodeName,
    ...(edge ? { edgeId: edge.edgeId } : {}),
    ...(jsonPath ?? edge ? { jsonPath: jsonPath ?? edge!.jsonPath } : {}),
    ...(value === undefined ? {} : { value }),
    fix
  };
}

// ---- Small, deterministic condition solver ---------------------------------
// It intentionally proves overlap/coverage only for comparisons joined by !,
// &&, || and parentheses. Unknown Groovy constructs are never guessed to be
// complete; exact duplicate unknown expressions still count as overlap.

type Operator = "==" | "!=" | ">" | ">=" | "<" | "<=";
interface Atom { variable: string; operator: Operator; value: unknown }
type Ast =
  | { kind: "atom"; atom: Atom }
  | { kind: "unknown"; text: string }
  | { kind: "not"; child: Ast }
  | { kind: "and" | "or"; left: Ast; right: Ast };

function conditionsOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (compact(left) === compact(right)) return true;
  const a = parseCondition(left);
  const b = parseCondition(right);
  if (!a || !b || a.kind === "unknown" || b.kind === "unknown") return false;
  const leftDnf = toDnf(a, false);
  const rightDnf = toDnf(b, false);
  if (!leftDnf || !rightDnf) return false;
  return leftDnf.some((leftClause) => rightDnf.some((rightClause) =>
    satisfiable([...leftClause, ...rightClause])
  ));
}

function isCompleteCondition(expression: string): boolean {
  if (!expression) return false;
  const ast = parseCondition(expression);
  if (!ast || ast.kind === "unknown") return false;
  // The union covers the universe exactly when its negation is unsatisfiable.
  const negated = toDnf(ast, true);
  return negated !== undefined && negated.every((clause) => !satisfiable(clause));
}

function parseCondition(expression: string): Ast | undefined {
  let source = expression.trim();
  if (source.startsWith("#{") && source.endsWith("}")) source = source.slice(2, -1);
  let cursor = 0;
  const skip = (): void => { while (/\s/.test(source[cursor] ?? "")) cursor += 1; };
  const consume = (token: string): boolean => {
    skip();
    if (!source.startsWith(token, cursor)) return false;
    cursor += token.length;
    return true;
  };
  const parseOr = (): Ast => {
    let left = parseAnd();
    while (consume("||")) left = { kind: "or", left, right: parseAnd() };
    return left;
  };
  const parseAnd = (): Ast => {
    let left = parseUnary();
    while (consume("&&")) left = { kind: "and", left, right: parseUnary() };
    return left;
  };
  const parseUnary = (): Ast => {
    skip();
    if (source[cursor] === "!" && source[cursor + 1] !== "=") {
      cursor += 1;
      return { kind: "not", child: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): Ast => {
    skip();
    if (consume("(")) {
      const inner = parseOr();
      if (!consume(")")) return { kind: "unknown", text: source };
      return inner;
    }
    const start = cursor;
    let quote = "";
    while (cursor < source.length) {
      const char = source[cursor]!;
      if (quote) {
        if (char === "\\") cursor += 2;
        else {
          cursor += 1;
          if (char === quote) quote = "";
        }
        continue;
      }
      if (char === "\"" || char === "'") { quote = char; cursor += 1; continue; }
      if (char === ")" || source.startsWith("&&", cursor) || source.startsWith("||", cursor)) break;
      cursor += 1;
    }
    const raw = source.slice(start, cursor).trim();
    const atom = parseAtom(raw);
    return atom ? { kind: "atom", atom } : { kind: "unknown", text: raw };
  };
  const result = parseOr();
  skip();
  return cursor === source.length && source.trim() !== "" ? result : undefined;
}

function parseAtom(raw: string): Atom | undefined {
  const match = raw.match(/^(.+?)(==|!=|>=|<=|>|<)(.+)$/);
  if (!match) return undefined;
  const left = match[1]!.trim();
  const right = match[3]!.trim();
  const operator = match[2] as Operator;
  const leftVariable = variableName(left);
  const rightVariable = variableName(right);
  if (leftVariable && !rightVariable) {
    const value = literal(right);
    return value.ok ? { variable: leftVariable, operator, value: value.value } : undefined;
  }
  if (rightVariable && !leftVariable) {
    const value = literal(left);
    return value.ok
      ? { variable: rightVariable, operator: reverseOperator(operator), value: value.value }
      : undefined;
  }
  return undefined;
}

function variableName(value: string): string | undefined {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) && !["true", "false", "null"].includes(value)
    ? value
    : undefined;
}

function literal(value: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === "true") return { ok: true, value: true };
  if (trimmed === "false") return { ok: true, value: false };
  if (trimmed === "null") return { ok: true, value: null };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try { return { ok: true, value: JSON.parse(trimmed) as unknown }; } catch { return { ok: false }; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return { ok: true, value: trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\") };
  }
  return { ok: false };
}

function reverseOperator(operator: Operator): Operator {
  return operator === ">" ? "<" : operator === ">=" ? "<=" : operator === "<" ? ">" : operator === "<=" ? ">=" : operator;
}

function negateOperator(operator: Operator): Operator {
  return operator === "==" ? "!=" : operator === "!=" ? "==" : operator === ">" ? "<=" : operator === ">=" ? "<" : operator === "<" ? ">=" : ">";
}

function toDnf(ast: Ast, negated: boolean): Atom[][] | undefined {
  if (ast.kind === "unknown") return undefined;
  if (ast.kind === "atom") {
    return [[{
      variable: ast.atom.variable,
      operator: negated ? negateOperator(ast.atom.operator) : ast.atom.operator,
      value: ast.atom.value
    }]];
  }
  if (ast.kind === "not") return toDnf(ast.child, !negated);
  const effectiveAnd = (ast.kind === "and") !== negated;
  const left = toDnf(ast.left, negated);
  const right = toDnf(ast.right, negated);
  if (!left || !right) return undefined;
  if (!effectiveAnd) {
    const result = [...left, ...right];
    return result.length <= MAX_DNF_CLAUSES ? result : undefined;
  }
  const result: Atom[][] = [];
  for (const a of left) {
    for (const b of right) {
      result.push([...a, ...b]);
      if (result.length > MAX_DNF_CLAUSES) return undefined;
    }
  }
  return result;
}

interface Domain {
  hasEquals: boolean;
  equals?: unknown;
  excluded: Set<string>;
  lower?: { value: number; inclusive: boolean };
  upper?: { value: number; inclusive: boolean };
}

function satisfiable(atoms: Atom[]): boolean {
  const domains = new Map<string, Domain>();
  for (const atom of atoms) {
    const domain = domains.get(atom.variable) ?? { hasEquals: false, excluded: new Set<string>() };
    domains.set(atom.variable, domain);
    if (atom.operator === "==" || atom.operator === "!=") {
      const key = stableValue(atom.value);
      if (atom.operator === "!=") {
        if (domain.hasEquals && stableValue(domain.equals) === key) return false;
        domain.excluded.add(key);
        continue;
      }
      if (domain.hasEquals && stableValue(domain.equals) !== key) return false;
      if (domain.excluded.has(key)) return false;
      domain.hasEquals = true;
      domain.equals = atom.value;
      continue;
    }
    if (typeof atom.value !== "number" || !Number.isFinite(atom.value)) return false;
    if (atom.operator === ">" || atom.operator === ">=") {
      const inclusive = atom.operator === ">=";
      if (!domain.lower || atom.value > domain.lower.value ||
          atom.value === domain.lower.value && domain.lower.inclusive && !inclusive) {
        domain.lower = { value: atom.value, inclusive };
      }
    } else {
      const inclusive = atom.operator === "<=";
      if (!domain.upper || atom.value < domain.upper.value ||
          atom.value === domain.upper.value && domain.upper.inclusive && !inclusive) {
        domain.upper = { value: atom.value, inclusive };
      }
    }
  }

  for (const domain of domains.values()) {
    if (domain.lower && domain.upper) {
      if (domain.lower.value > domain.upper.value) return false;
      if (domain.lower.value === domain.upper.value && (!domain.lower.inclusive || !domain.upper.inclusive)) return false;
    }
    if (domain.hasEquals) {
      if (domain.excluded.has(stableValue(domain.equals))) return false;
      if (domain.lower || domain.upper) {
        if (typeof domain.equals !== "number") return false;
        if (domain.lower && (domain.equals < domain.lower.value ||
            domain.equals === domain.lower.value && !domain.lower.inclusive)) return false;
        if (domain.upper && (domain.equals > domain.upper.value ||
            domain.equals === domain.upper.value && !domain.upper.inclusive)) return false;
      }
    } else if (domain.lower && domain.upper && domain.lower.value === domain.upper.value &&
        domain.excluded.has(stableValue(domain.lower.value))) {
      return false;
    }
  }
  return true;
}

function stableValue(value: unknown): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function unwrapExpression(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("#{") && trimmed.endsWith("}")
    ? trimmed.slice(2, -1)
    : trimmed;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function normalizeUel(value: unknown): ResourceRecord {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupe(issues: BlockingIssue[]): BlockingIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.nodeId}:${issue.edgeId}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
