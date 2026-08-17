import { CliError } from "./errors.js";
import { sendRequest } from "./http/client.js";

export type TenantScope = "global" | "non-global";

export interface TenantInfo {
  tenantCode: string;
  authorityPolicy: string;
}

const GLOBAL_RESOURCE_SEGMENTS = new Set([
  "appmodule",
  "feature",
  "featuregroup",
  "menu",
  "serialnumberconfig"
]);

/**
 * Validate the token against the current environment and return its tenant info.
 * The caller must persist the token only after this request succeeds.
 */
export async function fetchTenantInfo(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<TenantInfo> {
  const result = await sendRequest({
    baseUrl: options.baseUrl,
    token: options.token,
    method: "GET",
    path: "/api-gateway/sei-basic/account/getByApiKey",
    query: { apiKey: [options.token] },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  const envelope = result.data;
  const data = isRecord(envelope) ? envelope.data : undefined;
  const tenantCode = isRecord(data) ? data.tenantCode : undefined;
  const authorityPolicy = isRecord(data) ? data.authorityPolicy : undefined;
  if (typeof tenantCode !== "string" || tenantCode.trim() === "") {
    throw new CliError("account/getByApiKey 未返回有效 tenantCode");
  }
  if (typeof authorityPolicy !== "string" || authorityPolicy.trim() === "") {
    throw new CliError("account/getByApiKey 未返回有效 authorityPolicy");
  }
  return { tenantCode: tenantCode.trim(), authorityPolicy: authorityPolicy.trim() };
}

export function scopeForPath(path: string): TenantScope {
  const segments = path
    .split(/[?#]/, 1)[0]!
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase());
  // Unknown paths are non-global by default. Global access must be declared explicitly.
  return segments.some((segment) => GLOBAL_RESOURCE_SEGMENTS.has(segment))
    ? "global"
    : "non-global";
}

export function assertTenantScope(
  tenantCode: string | undefined,
  requiredScope: TenantScope,
  environmentName?: string
): void {
  if (!tenantCode) {
    throw new CliError(
      `环境${environmentName ? ` ${environmentName}` : ""} 未记录 tenantCode，请重新执行 env add 验证 Token`
    );
  }

  const actualScope = tenantCode === "global" ? "global" : "non-global";
  if (actualScope === requiredScope) {
    return;
  }

  if (requiredScope === "global") {
    throw new CliError(
      `环境${environmentName ? ` ${environmentName}` : ""} 的 tenantCode 为 ${tenantCode}，应用模块、菜单、功能项、功能项组和给号配置操作必须使用 global 租户（tenantCode === "global" 的全局管理员环境）`
    );
  }
  throw new CliError(
    `环境${environmentName ? ` ${environmentName}` : ""} 的 tenantCode 为 global（tenantCode === "global" 的全局管理员），该操作必须使用非 global 租户`
  );
}

export function assertPathTenantScope(
  tenantCode: string | undefined,
  path: string,
  environmentName?: string
): void {
  assertTenantScope(tenantCode, scopeForPath(path), environmentName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
