import { readFile } from "node:fs/promises";
import { CliError } from "../../errors.js";
import type { ResourceClient } from "../../resource/core/client.js";

export interface ConditionPropertyRef {
  code: string;
  name: string;
}

export interface ConditionExpressionValue {
  logicUel: string;
  groovyUel: string;
}

/**
 * Build the two UEL representations from the same business expression.
 *
 * This mirrors the designer's name-to-code mapping (longest names first), but
 * deliberately leaves quoted values untouched: a condition such as
 * `文件类型=="文件类型"` must compare with the literal, not with the variable.
 */
export function buildConditionExpression(
  logic: string,
  properties: readonly ConditionPropertyRef[]
): ConditionExpressionValue {
  const logicUel = logic.trim();
  if (!logicUel) {
    throw new CliError("条件表达式不能为空", 1, {
      code: "CONDITION_EXPRESSION_MISSING",
      requiredInput: "logic"
    });
  }
  const unknown = extractUnknownPropertyNames(
    logicUel,
    properties.map((property) => property.name)
  );
  if (unknown.length > 0) {
    throw new CliError(`表达式使用了系统未提供的判定条件：${unknown.join("、")}`, 1, {
      code: "CONDITION_PROPERTY_UNKNOWN",
      candidates: properties.map((property) => property.name),
      requiredInput: "logic"
    });
  }
  return {
    logicUel,
    groovyUel: `#{${replaceConditionNames(logicUel, properties)}}`
  };
}

/**
 * Return the JUEL body only when the expression has the exact `#{...}` wrapper
 * produced by the designer and accepted by ConBusinessEntityService.
 */
export function conditionExpressionBody(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("#{") || !trimmed.endsWith("}")) return undefined;
  const body = trimmed.slice(2, -1);
  return body.trim() === "" ? undefined : body;
}

/** Compare logicUel and groovyUel while ignoring formatting-only whitespace. */
export function conditionExpressionsMatch(
  logic: string,
  groovy: string,
  properties: readonly ConditionPropertyRef[]
): boolean {
  const body = conditionExpressionBody(groovy);
  if (body === undefined) return false;
  const expected = replaceConditionNames(logic, properties);
  return compactExpression(body) === compactExpression(expected);
}

/**
 * Validate through the same target-environment endpoint used by the designer.
 * The server evaluates JUEL with each condition property's initValue. A false
 * result is still a valid expression; only a rejected request is a failure.
 */
export async function validateConditionExpression(
  client: ResourceClient,
  flowTypeId: string,
  expression: string
): Promise<void> {
  await client.invoke("conBusinessEntity/validateExpression", "POST", {
    flowTypeId,
    expression
  });
}

export interface ConditionExpressionMatrixInput {
  key?: string;
  logicUel: string;
}

export interface ConditionExpressionBatchEntry {
  key?: string;
  expression?: ConditionExpressionValue;
  validated: boolean;
  error?: string;
}

export interface ConditionExpressionBatchResult {
  expressions: ConditionExpressionBatchEntry[];
  attempted: number;
  validated: number;
  failed: number;
  serverCalls: number;
}

/** Read a JSON condition matrix: an array or { expressions: [...] }. */
export async function readConditionExpressionMatrix(
  path: string
): Promise<ConditionExpressionMatrixInput[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(`读取条件矩阵失败：${path}：${errorMessage(error)}`, 1, {
      code: "INVALID_ARGUMENT"
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new CliError(`条件矩阵不是有效 JSON：${errorMessage(error)}`, 1, {
      code: "INVALID_ARGUMENT"
    });
  }
  const container = isRecord(parsed) && Array.isArray(parsed.expressions)
    ? parsed.expressions
    : isRecord(parsed) && Array.isArray(parsed.matrix)
      ? parsed.matrix
      : parsed;
  if (!Array.isArray(container) || container.length === 0) {
    throw new CliError("条件矩阵必须是非空数组，或包含非空 expressions 数组", 1, {
      code: "INVALID_ARGUMENT",
      requiredInput: "file"
    });
  }
  return container.map((item, index) => {
    if (typeof item === "string") return { logicUel: item };
    if (!isRecord(item)) {
      throw new CliError(`条件矩阵第 ${index + 1} 项必须是字符串或对象`, 1, {
        code: "INVALID_ARGUMENT"
      });
    }
    const logicUel = typeof item.logicUel === "string"
      ? item.logicUel
      : typeof item.logic === "string"
        ? item.logic
        : "";
    if (!logicUel.trim()) {
      throw new CliError(`条件矩阵第 ${index + 1} 项缺少 logicUel`, 1, {
        code: "CONDITION_EXPRESSION_MISSING",
        requiredInput: `expressions[${index}].logicUel`
      });
    }
    const key = [item.key, item.id, item.name].find((value) =>
      typeof value === "string" && value.trim() !== ""
    );
    return {
      ...(typeof key === "string" ? { key: key.trim() } : {}),
      logicUel
    };
  });
}

/** Build every pair and validate each distinct groovyUel exactly once. */
export async function buildAndValidateConditionExpressions(
  client: ResourceClient,
  flowTypeId: string,
  properties: readonly ConditionPropertyRef[],
  inputs: readonly ConditionExpressionMatrixInput[]
): Promise<ConditionExpressionBatchResult> {
  const cache = new Map<string, Promise<string | undefined>>();
  const expressions: ConditionExpressionBatchEntry[] = [];
  let serverCalls = 0;
  let attempted = 0;
  let validated = 0;
  let failed = 0;
  for (const input of inputs) {
    let expression: ConditionExpressionValue;
    try {
      expression = buildConditionExpression(input.logicUel, properties);
    } catch (error) {
      failed += 1;
      expressions.push({
        ...(input.key === undefined ? {} : { key: input.key }),
        validated: false,
        error: errorMessage(error)
      });
      continue;
    }
    attempted += 1;
    let pending = cache.get(expression.groovyUel);
    if (!pending) {
      serverCalls += 1;
      pending = validateConditionExpression(client, flowTypeId, expression.groovyUel)
        .then(() => undefined)
        .catch((error: unknown) => {
          if (error instanceof CliError && error.message.startsWith("EADP 请求失败：")) {
            return error.message;
          }
          throw error;
        });
      cache.set(expression.groovyUel, pending);
    }
    const failure = await pending;
    if (failure === undefined) validated += 1;
    else failed += 1;
    expressions.push({
      ...(input.key === undefined ? {} : { key: input.key }),
      expression,
      validated: failure === undefined,
      ...(failure === undefined ? {} : { error: failure })
    });
  }
  return {
    expressions,
    attempted,
    validated,
    failed,
    serverCalls
  };
}

/** Replace business labels outside string literals, longest label first. */
function replaceConditionNames(
  logic: string,
  properties: readonly ConditionPropertyRef[]
): string {
  const sorted = [...properties]
    .filter((property) => property.name !== "")
    .sort((left, right) => right.name.length - left.name.length);
  return mapOutsideStringLiterals(logic, (segment) => {
    let result = segment;
    for (const property of sorted) {
      result = result.split(property.name).join(property.code);
    }
    return result;
  });
}

/**
 * Find Chinese condition labels absent from the published list. Known labels
 * are removed longest first, matching the designer's replacement order.
 */
export function extractUnknownPropertyNames(
  logic: string,
  knownNames: readonly string[]
): string[] {
  let rest = stripLiterals(logic);
  const sorted = [...knownNames].sort((left, right) => right.length - left.length);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactExpression(expression: string): string {
  return mapOutsideStringLiterals(expression, (segment) => segment.replace(/\s+/g, ""));
}

function stripLiterals(expression: string): string {
  return expression
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Transform only non-string segments, retaining quotes and escape sequences. */
function mapOutsideStringLiterals(
  expression: string,
  transform: (segment: string) => string
): string {
  const literal = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(expression)) !== null) {
    result += transform(expression.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  result += transform(expression.slice(cursor));
  return result;
}
