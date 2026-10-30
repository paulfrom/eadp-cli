import type { ResolvedEnvironment } from "../../config/resolve.js";
import { CliError } from "../../errors.js";
import { sendRequest } from "../../http/client.js";
import type { ResourceClient, ResourceRecord } from "../../resource/core/client.js";
import {
  buildTransSavePayload,
  loadTransRecords,
  logicalTransRecord,
  sanitizeTransOutput
} from "./service.js";

export async function executeTransLifecycle(options: {
  environment: ResolvedEnvironment;
  client: ResourceClient;
  code: string;
  action: "publish" | "freeze";
  apply: boolean;
  timeoutMs: number;
}): Promise<unknown> {
  const { environment, client, code, action, apply, timeoutMs } = options;
  const rows = await loadTransRecords(client, {
    filters: [{ fieldName: "code", operator: "EQ", value: code }]
  });
  const matches = rows.filter((row) =>
    typeof row.code === "string" && row.code.trim().toLocaleLowerCase() === code.toLocaleLowerCase()
  );
  if (matches.length !== 1) {
    throw new CliError(
      `通道 code=${code} ${matches.length === 0 ? "不存在" : `不唯一（匹配 ${matches.length} 条）`}`,
      1,
      { code: "INVALID_ARGUMENT", requiredInput: "selector" }
    );
  }
  const current = matches[0]!;
  const desired = logicalTransRecord(current);
  const unchanged = action === "freeze" && current.status === "FROZEN";
  const base = {
    kind: "eadp.trans.lifecycle.v1",
    resource: "trans",
    environment: environment.name,
    action,
    code,
    applied: false,
    desired
  };
  if (!apply || unchanged) {
    return sanitizeTransOutput({
      ...base,
      action: unchanged ? "unchanged" : action,
      verified: true
    });
  }

  if (action === "publish") {
    const [groups, sourceSystems] = await Promise.all([
      client.findByPage("transGroup"),
      client.findByPage("sourceSystem")
    ]);
    const payload = buildTransSavePayload(desired, current, {
      groups: groups.rows,
      sourceSystems: sourceSystems.rows
    });
    await callLifecycle(environment, timeoutMs, "trans/saveAndPublish", payload);
  } else {
    await callLifecycle(
      environment,
      timeoutMs,
      "trans/frozen",
      undefined,
      { id: [requiredId(current)] }
    );
  }

  const afterRows = await loadTransRecords(client, {
    filters: [{ fieldName: "code", operator: "EQ", value: code }]
  });
  const actual = afterRows.find((row) =>
    typeof row.code === "string" && row.code.trim().toLocaleLowerCase() === code.toLocaleLowerCase()
  );
  if (!actual) throw new CliError(`通道 ${code} 生命周期操作后回查失败`);
  const actualLogical = logicalTransRecord(actual);
  const statusValid = action === "publish" ? actual.status === "PUBLISH" : actual.status === "FROZEN";
  const versionValid = action === "freeze" || actual.graphVersion !== current.graphVersion;
  const configValid = JSON.stringify(actualLogical) === JSON.stringify(desired);
  if (!statusValid || !versionValid || !configValid) {
    throw new CliError(`通道 ${code} ${action === "publish" ? "发布" : "冻结"}后回查失败`);
  }
  return sanitizeTransOutput({
    ...base,
    applied: true,
    actual: actualLogical,
    status: actual.status,
    graphVersion: actual.graphVersion,
    verified: true
  });
}

async function callLifecycle(
  environment: ResolvedEnvironment,
  timeoutMs: number,
  path: string,
  body?: ResourceRecord,
  query?: Record<string, string[]>
): Promise<void> {
  const response = await sendRequest({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    method: "POST",
    path: `/api-gateway/sei-eai/${path}`,
    timeoutMs,
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query })
  });
  if (!isEnvelope(response.data)) throw new CliError(`资源接口返回格式无效：${path}`);
}

function isEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).success === true &&
    "data" in value;
}

function requiredId(record: ResourceRecord): string {
  if ((typeof record.id !== "string" && typeof record.id !== "number") || !String(record.id)) {
    throw new CliError("通道缺少有效 ID");
  }
  return String(record.id);
}
