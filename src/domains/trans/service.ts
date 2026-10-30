import { CliError } from "../../errors.js";
import {
  isRecord,
  type ContractQueryOptions,
  type ResourceClient,
  type ResourceRecord
} from "../../resource/core/client.js";
import type { BlockingIssue } from "../../resource/core/errors.js";
import { DependencyResolutionError, RecordMappingError } from "../../resource/core/errors.js";
import type {
  ResourcePhaseHooks,
  ResourcePlanChange
} from "../../resource/core/engine.js";
import { selectDependencyByCode } from "../shared.js";
import { transContract } from "./contract.js";

const logicalFields = [
  "code", "name", "groupCode", "logLastDay", "customResult", "antiRetry",
  "sync", "subscriber", "requestSample", "responseSample", "transGraph"
] as const;
const optionalFields = logicalFields.filter((field) =>
  !["code", "groupCode", "transGraph"].includes(field)
);
const createDefaults: ResourceRecord = {
  logLastDay: 60,
  customResult: false,
  antiRetry: false,
  sync: true
};
const secretFields = new Set(["httploginpassword", "password", "dbpass"]);
const secretHeaders = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"
]);

interface TransReferences {
  groups: ResourceRecord[];
  sourceSystems: ResourceRecord[];
}

export async function loadTransRecords(
  client: ResourceClient,
  options: ContractQueryOptions = {},
  references?: TransReferences
): Promise<ResourceRecord[]> {
  const [rows, resolvedReferences] = await Promise.all([
    client.queryContract(transContract, options),
    references ? Promise.resolve(references) : loadReferences(client)
  ]);
  const result: ResourceRecord[] = [];
  for (const row of rows) {
    const id = requiredId(row, "通道列表记录");
    const detail = await client.detailContract(transContract, { id });
    if (detail === null) throw new CliError(`通道 ${String(row.code ?? id)} 的明细不存在`);
    result.push(normalizeLoadedTrans(detail, resolvedReferences));
  }
  return result;
}

export function logicalTransRecord(record: ResourceRecord): ResourceRecord {
  const logical: ResourceRecord = {};
  for (const field of optionalFields) {
    if (field in record) logical[field] = record[field];
  }
  if (typeof record.code === "string") logical.code = record.code;
  logical.groupCode = typeof record.groupCode === "string" && record.groupCode.trim()
    ? record.groupCode.trim()
    : null;
  if (isRecord(record.transGraph) && typeof record.transGraph.graph === "string") {
    try {
      logical.transGraph = {
        graph: stableStringify(parseGraphDocument(record.transGraph.graph))
      };
    } catch {
      logical.transGraph = { graph: record.transGraph.graph };
    }
  }
  return logical;
}

export function buildTransSavePayload(
  desired: ResourceRecord,
  current: ResourceRecord | undefined,
  references: TransReferences
): ResourceRecord {
  const payload: ResourceRecord = {};
  for (const field of optionalFields) {
    if (field in desired) payload[field] = desired[field];
  }
  payload.code = desired.code;
  if (current?.id !== undefined) payload.id = current.id;
  payload.status = current?.status ?? "INIT";
  payload.graphVersion = current?.graphVersion ?? null;

  const groupCode = desired.groupCode;
  if (typeof groupCode === "string" && groupCode.trim()) {
    const group = selectDependencyByCode(references.groups, groupCode, "trans-group");
    payload.groupId = requiredId(group, `目标通道分组 ${groupCode}`);
    payload.groupName = typeof group.name === "string" ? group.name : null;
  } else {
    payload.groupId = null;
    payload.groupName = null;
  }

  if (!isRecord(desired.transGraph) || typeof desired.transGraph.graph !== "string") {
    throw new CliError(`通道 ${String(desired.code)} 缺少有效图配置`);
  }
  const graph = parseGraphDocument(desired.transGraph.graph);
  materializeSourceSystemIds(graph, references.sourceSystems);
  payload.transGraph = { graph: stableStringify(graph) };
  return payload;
}

export const transPhaseHooks: ResourcePhaseHooks = {
  async load(client, _contract, options) {
    return loadTransRecords(client, options);
  },

  async aggregatePlan(context) {
    const code = context.selectors.code;
    if (!code) throw new CliError("通道比较或迁移必须提供 --select code=<code>");
    const [source, target] = await Promise.all([
      loadTransRecords(context.sourceClient, codeQuery(code)),
      loadTransRecords(context.targetClient, codeQuery(code))
    ]);
    return {
      changes: await buildTransChanges(
        source,
        target,
        context.targetClient,
        context.selectors
      )
    };
  },

  async plan(source, target, context) {
    return buildTransChanges(source, target, context.targetClient, context.selectors);
  },

  async apply(writable, client, context) {
    const references = await loadReferences(client);
    for (const change of writable) {
      if (change.action !== "create" && change.action !== "update") continue;
      const desired = change.desired!;
      const code = requiredCode(desired);
      const targetRows = await loadTransRecords(client, codeQuery(code), references);
      const current = selectOptionalTarget(targetRows, code);
      const payload = buildTransSavePayload(desired, current, references);
      const saved = await client.save("trans", payload);
      if (change.action === "create" && context.recorder) {
        await context.recorder.recordAction({
          type: "create-entity",
          service: "sei-eai",
          resource: "trans",
          entityId: requiredId(saved, `通道 ${code} 保存结果`),
          expected: payload,
          deleteMethod: "DELETE",
          remove: transContract.rollback!.remove,
          lookup: transContract.rollback!.lookup,
          tenantPolicy: "non-global"
        });
      }
    }
  },

  async verify(client, context) {
    const references = await loadReferences(client);
    for (const change of context.plan.changes) {
      if (change.action === "blocked" || change.action === "delete") continue;
      if (change.desired === null) return false;
      const code = requiredCode(change.desired);
      const rows = await loadTransRecords(client, codeQuery(code), references);
      const actual = selectOptionalTarget(rows, code);
      if (!actual) return false;
      const logical = logicalTransRecord(actual);
      if (!desiredFieldsEqual(logical, change.desired)) return false;
    }
    return true;
  }
};

async function buildTransChanges(
  source: ResourceRecord[],
  target: ResourceRecord[],
  targetClient: ResourceClient,
  selectors: Readonly<Record<string, string>>
): Promise<ResourcePlanChange[]> {
  const code = selectors.code;
  const selectedSource = code ? [selectSourceByCode(source, code)] : source;
  const selectedTarget = code
    ? target.filter((record) => sameCode(record.code, code))
    : target;
  assertUniqueCodes(selectedSource, "源通道");
  assertUniqueCodes(selectedTarget, "目标通道");
  const targetByCode = new Map(
    selectedTarget.map((record) => [normalizeCode(requiredCode(record)), record])
  );
  const references = await loadReferences(targetClient);
  const changes: ResourcePlanChange[] = [];

  for (const sourceRecord of selectedSource) {
    const key = typeof sourceRecord.code === "string" ? sourceRecord.code : "<missing-code>";
    const before = targetByCode.get(normalizeCode(key));
    try {
      const desired = buildDesired(sourceRecord, before);
      validateDesiredDependencies(desired, references);
      const logicalBefore = before ? logicalTransRecord(before) : null;
      const changedFields = logicalFields.filter((field) =>
        field in desired && !sameValue(logicalBefore?.[field], desired[field])
      );
      changes.push({
        key: requiredCode(desired),
        action: before ? (changedFields.length ? "update" : "unchanged") : "create",
        changedFields,
        before: logicalBefore,
        desired
      });
    } catch (error) {
      if (error instanceof RecordMappingError) {
        changes.push({
          key,
          action: "blocked",
          changedFields: [],
          before: before ? logicalTransRecord(before) : null,
          desired: null,
          blockingIssues: error.blockingIssues
        });
        continue;
      }
      if (error instanceof DependencyResolutionError) {
        changes.push({
          key,
          action: "blocked",
          changedFields: [],
          before: before ? logicalTransRecord(before) : null,
          desired: null,
          missingDependencies: error.missingDependencies
        });
        continue;
      }
      throw error;
    }
  }
  return changes;
}

function buildDesired(
  source: ResourceRecord,
  target: ResourceRecord | undefined
): ResourceRecord {
  const issues: BlockingIssue[] = [];
  const code = requiredCode(source);
  const desired: ResourceRecord = { code };
  for (const field of optionalFields) {
    if (field in source) desired[field] = source[field];
    else if (target && field in target) desired[field] = target[field];
    else if (field in createDefaults) desired[field] = createDefaults[field];
  }

  if (typeof desired.logLastDay === "number" && desired.logLastDay > 180) {
    issues.push(invalidIssue("logLastDay", `通道 ${code} 的日志保留天数不能超过 180 天`));
  } else if (desired.logLastDay !== undefined && desired.logLastDay !== null &&
      (typeof desired.logLastDay !== "number" || !Number.isInteger(desired.logLastDay))) {
    issues.push(invalidIssue("logLastDay", `通道 ${code} 的日志保留天数必须是整数`));
  }

  if (typeof source.groupCode === "string" && source.groupCode.trim()) {
    desired.groupCode = source.groupCode.trim();
  } else if (typeof source.groupId === "string" && source.groupId.trim()) {
    issues.push(invalidIssue(
      "groupCode",
      `通道 ${code} 包含 groupId，但无法解析源分组 code`
    ));
  } else if ("groupCode" in source || "groupId" in source) {
    desired.groupCode = null;
  } else {
    desired.groupCode = target?.groupCode ?? null;
  }

  if (!isRecord(source.transGraph) || typeof source.transGraph.graph !== "string" ||
      !source.transGraph.graph.trim()) {
    issues.push(invalidIssue("transGraph.graph", `通道 ${code} 缺少 transGraph.graph`));
  } else {
    try {
      const graph = parseGraphDocument(source.transGraph.graph);
      issues.push(...graphBlockingIssues(graph, code));
      desired.transGraph = { graph: stableStringify(graph) };
    } catch (error) {
      issues.push(invalidIssue(
        "transGraph.graph",
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  if (issues.length) throw new RecordMappingError(issues);
  return desired;
}

function validateDesiredDependencies(
  desired: ResourceRecord,
  references: TransReferences
): void {
  const missing = [];
  const groupCode = desired.groupCode;
  if (typeof groupCode === "string" && groupCode.trim()) {
    try {
      selectDependencyByCode(references.groups, groupCode, "trans-group");
    } catch (error) {
      if (!(error instanceof DependencyResolutionError)) throw error;
      missing.push(...error.missingDependencies);
    }
  }
  if (isRecord(desired.transGraph) && typeof desired.transGraph.graph === "string") {
    const graph = parseGraphDocument(desired.transGraph.graph);
    for (const code of sourceSystemCodes(graph)) {
      try {
        selectDependencyByCode(references.sourceSystems, code, "source-system");
      } catch (error) {
        if (!(error instanceof DependencyResolutionError)) throw error;
        missing.push(...error.missingDependencies);
      }
    }
  }
  if (missing.length) throw new DependencyResolutionError(missing);
}

function graphBlockingIssues(graph: ResourceRecord, code: string): BlockingIssue[] {
  const issues: BlockingIssue[] = [];
  const seen = new Set<string>();
  const add = (kind: string, message: string): void => {
    if (seen.has(kind)) return;
    seen.add(kind);
    issues.push(invalidIssue("transGraph.graph", `通道 ${code}：${message}`));
  };
  walkGraph(graph, (record, key) => {
    if (key === "sourceSystemId") {
      add("sourceSystemId", "图包含未解析的 sourceSystemId，必须按来源系统 code 映射");
    }
    if (key === "sourceSystemCode" &&
        (typeof record[key] !== "string" || !String(record[key]).trim())) {
      add("sourceSystemCode", "sourceSystemCode 必须是非空字符串");
    }
    if (key === "dbMeta" && isRecord(record[key])) {
      add("dbMeta", "数据库节点包含环境相关 dbMeta，当前不支持跨环境写入");
    }
    if (secretFields.has(key.toLocaleLowerCase()) && hasSecretValue(record[key])) {
      add("secret", "图包含内嵌密码，CLI 不会读取后迁移密钥");
    }
    if ((key.toLocaleLowerCase() === "header" || key.toLocaleLowerCase() === "headers") &&
        isRecord(record[key])) {
      for (const [header, value] of Object.entries(record[key])) {
        if (secretHeaders.has(header.toLocaleLowerCase()) && hasSecretValue(value)) {
          add("secret-header", "图请求头包含认证信息，CLI 不会读取后迁移密钥");
        }
      }
    }
  });
  return issues;
}

function materializeSourceSystemIds(
  graph: ResourceRecord,
  sourceSystems: ResourceRecord[]
): void {
  walkGraph(graph, (record, key) => {
    if (key !== "sourceSystemCode") return;
    const code = record[key];
    if (typeof code !== "string" || !code.trim()) {
      throw new CliError("图的 sourceSystemCode 必须是非空字符串");
    }
    const system = selectDependencyByCode(sourceSystems, code, "source-system");
    record.sourceSystemId = requiredId(system, `目标来源系统 ${code}`);
    delete record.sourceSystemCode;
  });
}

function sourceSystemCodes(graph: ResourceRecord): string[] {
  const result = new Set<string>();
  walkGraph(graph, (record, key) => {
    if (key === "sourceSystemCode" && typeof record[key] === "string" && record[key].trim()) {
      result.add(record[key].trim());
    }
  });
  return [...result];
}

function normalizeLoadedTrans(
  detail: ResourceRecord,
  references: TransReferences
): ResourceRecord {
  const result: ResourceRecord = { ...detail };
  if (typeof detail.groupId === "string" && detail.groupId.trim()) {
    const group = references.groups.find((record) => record.id === detail.groupId);
    if (group && typeof group.code === "string") result.groupCode = group.code;
  } else {
    result.groupCode = null;
  }
  if (isRecord(detail.transGraph) && typeof detail.transGraph.graph === "string") {
    try {
      const graph = parseGraphDocument(detail.transGraph.graph);
      walkGraph(graph, (record, key) => {
        if (key !== "sourceSystemId" || typeof record[key] !== "string") return;
        const system = references.sourceSystems.find((candidate) => candidate.id === record[key]);
        if (system && typeof system.code === "string") {
          record.sourceSystemCode = system.code;
          delete record.sourceSystemId;
        }
      });
      result.transGraph = { graph: stableStringify(graph) };
    } catch {
      result.transGraph = { graph: detail.transGraph.graph };
    }
  }
  return result;
}

async function loadReferences(client: ResourceClient): Promise<TransReferences> {
  const [groups, sourceSystems] = await Promise.all([
    client.findByPage("transGroup"),
    client.findByPage("sourceSystem")
  ]);
  return { groups: groups.rows, sourceSystems: sourceSystems.rows };
}

function selectSourceByCode(rows: ResourceRecord[], code: string): ResourceRecord {
  const matches = rows.filter((record) => sameCode(record.code, code));
  if (matches.length !== 1) {
    throw new CliError(
      `源通道 code=${code} ${matches.length === 0 ? "不存在" : `不唯一（匹配 ${matches.length} 条）`}`,
      1,
      { code: "INVALID_ARGUMENT", requiredInput: "selector" }
    );
  }
  return matches[0]!;
}

function selectOptionalTarget(
  rows: ResourceRecord[],
  code: string
): ResourceRecord | undefined {
  const matches = rows.filter((record) => sameCode(record.code, code));
  if (matches.length > 1) throw new CliError(`目标通道 code=${code} 不唯一`);
  return matches[0];
}

function assertUniqueCodes(rows: ResourceRecord[], label: string): void {
  const codes = new Set<string>();
  for (const row of rows) {
    const code = normalizeCode(requiredCode(row));
    if (codes.has(code)) throw new CliError(`${label} code=${String(row.code)} 不唯一`);
    codes.add(code);
  }
}

function desiredFieldsEqual(actual: ResourceRecord, desired: ResourceRecord): boolean {
  return logicalFields.every((field) =>
    !(field in desired) || sameValue(actual[field], desired[field])
  );
}

function parseGraphDocument(source: string): ResourceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CliError("通道图不是合法 JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new CliError("通道图必须是包含 nodes、edges 数组的 JSON 对象");
  }
  return parsed;
}

function walkGraph(
  value: unknown,
  visit: (record: ResourceRecord, key: string) => void
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkGraph(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(value, key);
    walkGraph(child, visit);
    if ((key === "loopSubGraph" || key === "graph") && typeof child === "string" &&
        child.trim().startsWith("{")) {
      try {
        const nested = JSON.parse(child) as unknown;
        walkGraph(nested, visit);
      } catch {
        continue;
      }
    }
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sanitizeTransOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTransOutput);
  if (!isRecord(value)) return value;
  const result: ResourceRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "transGraph" && isRecord(child)) {
      result[key] = sanitizeGraphContainer(child);
    } else {
      result[key] = sanitizeTransOutput(child);
    }
  }
  return result;
}

function sanitizeGraphContainer(container: ResourceRecord): ResourceRecord {
  const result: ResourceRecord = {};
  for (const [key, value] of Object.entries(container)) {
    if (key !== "graph" || typeof value !== "string") {
      result[key] = sanitizeTransOutput(value);
      continue;
    }
    try {
      result[key] = stableStringify(redactGraphSecrets(JSON.parse(value)));
    } catch {
      result[key] = "[REDACTED]";
    }
  }
  return result;
}

function redactGraphSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGraphSecrets);
  if (!isRecord(value)) return value;
  const result: ResourceRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (secretFields.has(key.toLocaleLowerCase()) && hasSecretValue(child)) {
      result[key] = "[REDACTED]";
    } else if ((key.toLocaleLowerCase() === "header" || key.toLocaleLowerCase() === "headers") &&
        isRecord(child)) {
      result[key] = redactHeaders(child);
    } else if ((key === "loopSubGraph" || key === "graph") && typeof child === "string" &&
        child.trim().startsWith("{")) {
      try {
        result[key] = stableStringify(redactGraphSecrets(JSON.parse(child)));
      } catch {
        result[key] = "[REDACTED]";
      }
    } else {
      result[key] = redactGraphSecrets(child);
    }
  }
  return result;
}

function redactHeaders(headers: ResourceRecord): ResourceRecord {
  const result: ResourceRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = secretHeaders.has(key.toLocaleLowerCase()) && hasSecretValue(value)
      ? "[REDACTED]"
      : redactGraphSecrets(value);
  }
  return result;
}

function hasSecretValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function invalidIssue(field: string, message: string): BlockingIssue {
  return { resource: "trans", field, reason: "invalid", message };
}

function requiredCode(record: ResourceRecord): string {
  if (typeof record.code !== "string" || !record.code.trim()) {
    throw new RecordMappingError([invalidIssue("code", "通道 code 必须是非空字符串")]);
  }
  return record.code.trim();
}

function requiredId(record: ResourceRecord, label: string): string {
  if ((typeof record.id !== "string" && typeof record.id !== "number") || !String(record.id)) {
    throw new CliError(`${label}缺少有效 ID`);
  }
  return String(record.id);
}

function normalizeCode(code: string): string {
  return code.trim().toLocaleLowerCase();
}

function sameCode(left: unknown, right: string): boolean {
  return typeof left === "string" && normalizeCode(left) === normalizeCode(right);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function codeQuery(code: string): ContractQueryOptions {
  return { filters: [{ fieldName: "code", operator: "EQ", value: code }] };
}
