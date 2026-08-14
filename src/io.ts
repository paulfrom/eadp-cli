import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

export type OutputMode = "json" | "compact" | "compact-ndjson";

let activeOutputMode: OutputMode = "json";

/**
 * Set the output mode used by the shared print helpers.
 *
 * Commands resolve global runtime options once at the beginning of an action,
 * so keeping this tiny bit of process-local state lets existing commands that
 * pass the legacy boolean `compact` flag opt into the new format without
 * duplicating format selection logic in every command.
 */
export function setOutputMode(mode: OutputMode): void {
  activeOutputMode = mode;
}

export interface CompactNdjsonOptions {
  /** Additional, command-specific metadata to put on the first line. */
  meta?: Record<string, unknown>;
  /** An authoritative total count, when the caller has one. */
  count?: number;
  /** An authoritative continuation cursor, when the caller has one. */
  cursor?: unknown;
}

export async function readJsonInput(options: {
  bodyFile?: string | undefined;
  data?: string | undefined;
}): Promise<unknown | undefined> {
  if (options.bodyFile && options.data) {
    throw new CliError("--body 和 --data 不能同时使用");
  }
  if (!options.bodyFile && !options.data) {
    return undefined;
  }
  const source = options.data ?? (await readFile(options.bodyFile!, "utf8"));
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CliError(`请求体不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePairs(values: string[], separator: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const value of values) {
    const index = value.indexOf(separator);
    if (index <= 0) {
      throw new CliError(`参数格式错误：${value}`);
    }
    const name = value.slice(0, index).trim();
    const item = value.slice(index + separator.length).trim();
    (result[name] ??= []).push(item);
  }
  return result;
}

export function flattenPairs(values: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, items]) => [name, items[items.length - 1] ?? ""])
  );
}

export function printValue(value: unknown, compact: boolean | OutputMode = false): void {
  const mode = typeof compact === "string"
    ? compact
    : compact
      ? "compact"
      : activeOutputMode;
  if (mode === "compact-ndjson") {
    process.stdout.write(formatCompactNdjson(value));
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, mode === "compact" ? 0 : 2)}\n`);
}

/**
 * Encode a value as compact, schema-first NDJSON.
 *
 * The first line is always `{ type: "meta", schema: [...] }`. Each following
 * line is a row with a schema-aligned `v` array. Records retain a stable key
 * when one can be read without guessing. Values that are not unambiguously a
 * table use a single `value` column, preserving the original value losslessly.
 */
export function formatCompactNdjson(
  value: unknown,
  options: CompactNdjsonOptions = {}
): string {
  if (isFailureEnvelope(value)) {
    throw new CliError(`EADP 请求失败：${value.message || "未知错误"}`);
  }
  const normalized = normalizeCompactValue(value);
  // Generic wrappers expose fields named `total`/`count` with inconsistent
  // semantics (some APIs return total pages, others total records). Only a
  // caller that has verified the contract may provide an authoritative count.
  const count = options.count ?? normalized.rows.length;
  const cursor = options.cursor !== undefined
    ? { found: true, value: options.cursor }
    : firstCursor(normalized.sources);
  const metadata: Record<string, unknown> = {
    ...(options.meta ?? {}),
    type: "meta",
    schema: normalized.schema,
    count,
    ...(cursor.found ? { cursor: cursor.value } : {})
  };
  const lines = [stringifyOutputLine(metadata)];
  for (const row of normalized.rows) {
    const record: Record<string, unknown> = {
      type: "row",
      ...(row.key === undefined ? {} : { key: row.key }),
      v: row.values
    };
    lines.push(stringifyOutputLine(record));
  }
  return `${lines.join("\n")}\n`;
}

function isFailureEnvelope(value: unknown): value is { success: false; message?: string } {
  return isObjectRecord(value) && value.success === false;
}

interface NormalizedCompactValue {
  rows: Array<{ values: unknown[]; key?: string }>;
  schema: string[];
  sources: Record<string, unknown>[];
}

interface ArrayContainer {
  rows: unknown[];
  sources: Record<string, unknown>[];
}

function normalizeCompactValue(value: unknown): NormalizedCompactValue {
  if (Array.isArray(value)) {
    return normalizeRows(value, []);
  }
  if (isObjectRecord(value)) {
    const container = findArrayContainer(value);
    if (container) {
      return normalizeRows(container.rows, container.sources);
    }
    return normalizeRows([value], []);
  }
  return normalizeRows([value], []);
}

function normalizeRows(rows: unknown[], sources: Record<string, unknown>[]): NormalizedCompactValue {
  if (rows.length === 0) {
    return { schema: [], rows: [], sources };
  }
  const records = rows.length > 0 && rows.every(isObjectRecord);
  if (!records) {
    return {
      schema: ["value"],
      rows: rows.map((value) => ({ values: [value] })),
      sources
    };
  }

  const schema = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return {
    schema,
    rows: rows.map((row) => {
      const key = stableRecordKey(row);
      const values = schema.map((field) => row[field]);
      return key === undefined ? { values } : { key, values };
    }),
    sources
  };
}

function findArrayContainer(value: Record<string, unknown>, depth = 0): ArrayContainer | undefined {
  if (depth > 3 || looksLikeRecord(value)) {
    return undefined;
  }
  const directKeys = [
    "rows",
    "records",
    "items",
    "content",
    "results",
    "list",
    "elements",
    "values",
    "resources"
  ];
  for (const key of directKeys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return { rows: candidate, sources: [value] };
    }
  }

  const data = value.data;
  if (Array.isArray(data) && (
    hasPaginationMetadata(value) ||
    value.success === true ||
    Object.keys(value).length === 1
  )) {
    return { rows: data, sources: [value] };
  }
  if (isObjectRecord(data) && (
    hasPaginationMetadata(value) ||
    value.success === true ||
    Object.keys(value).length === 1
  )) {
    const nested = findArrayContainer(data, depth + 1);
    if (nested) {
      return { rows: nested.rows, sources: [value, ...nested.sources] };
    }
  }
  return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeRecord(value: Record<string, unknown>): boolean {
  return ["id", "code", "name", "uuid", "entityId", "entityClassName", "tenantCode"]
    .some((field) => field in value);
}

function hasPaginationMetadata(value: Record<string, unknown>): boolean {
  return [
    "total",
    "totalCount",
    "totalElements",
    "count",
    "page",
    "pageNum",
    "pageInfo",
    "cursor",
    "nextCursor",
    "nextPageToken",
    "continuationToken"
  ].some((field) => field in value);
}

function firstCursor(sources: Record<string, unknown>[]): { found: boolean; value?: unknown } {
  for (const source of sources) {
    for (const field of ["cursor", "nextCursor", "nextPageToken", "continuationToken"]) {
      if (field in source) {
        return { found: true, value: source[field] };
      }
    }
  }
  return { found: false };
}

function stableRecordKey(record: Record<string, unknown>): string | undefined {
  const code = record.code;
  if ((typeof code === "string" && code.trim() !== "") ||
    (typeof code === "number" && Number.isFinite(code))) {
    return String(code);
  }
  const explicitKey = record.key;
  if ((typeof explicitKey === "string" && explicitKey.trim() !== "") ||
    (typeof explicitKey === "number" && Number.isFinite(explicitKey))) {
    return String(explicitKey);
  }
  const entityClassName = record.entityClassName;
  const tenantCode = record.tenantCode;
  if (typeof entityClassName === "string" && entityClassName.trim() !== "" &&
    typeof tenantCode === "string" && tenantCode.trim() !== "") {
    return `${entityClassName}|${tenantCode}`;
  }
  for (const field of ["uuid", "id", "entityId"]) {
    const value = record[field];
    if ((typeof value === "string" && value.trim() !== "") ||
      (typeof value === "number" && Number.isFinite(value))) {
      return String(value);
    }
  }
  return undefined;
}

function stringifyOutputLine(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  } catch (error) {
    throw new CliError(`输出序列化失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
