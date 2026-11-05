import { CliError, type CliErrorDetails } from "../errors.js";

export interface RequestOptions {
  baseUrl: string;
  path: string;
  method: string;
  token?: string | undefined;
  authorization?: string | undefined;
  headers?: Record<string, string>;
  query?: Record<string, string[]>;
  body?: unknown;
  timeoutMs?: number;
}

export interface ResponseResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  data: unknown;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string[]> = {}
): URL {
  const joined = `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const url = new URL(joined);
  for (const [name, values] of Object.entries(query)) {
    for (const value of values) {
      url.searchParams.append(name, value);
    }
  }
  return url;
}

export async function sendRequest(options: RequestOptions): Promise<ResponseResult> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const headers = new Headers(options.headers);
  if (options.authorization) {
    // Authorization is the implicit credential and must never be sent
    // alongside the legacy x-api-token credential.
    headers.delete("x-api-token");
    headers.set("authorization", options.authorization);
  } else if (options.token) {
    headers.set("x-api-token", options.token);
  }
  headers.set("accept", "application/json");
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestInit: RequestInit = {
    method: options.method.toUpperCase(),
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (options.body !== undefined) {
    // A body that cannot be serialized is a caller bug, not a transport
    // failure; build it outside the fetch try so it keeps its own message.
    requestInit.body = serializeRequestBody(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    throw transportFailure(error, timeoutMs);
  }

  const text = await response.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应保留为文本。
    }
  } else {
    data = null;
  }

  const result: ResponseResult = {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    data
  };

  if (!response.ok) {
    throw new CliError(`HTTP ${response.status}：${formatCompact(data)}`, 1,
      requestFailureDetails(data, result.headers));
  }
  if (isEadpFailure(data)) {
    throw new CliError(`EADP 请求失败：${readText(data, "message") ?? "未知错误"}`, 1,
      requestFailureDetails(data, result.headers));
  }
  return result;
}

function serializeRequestBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    throw new CliError("请求体无法序列化为 JSON，请求未发送", 1, { code: "INTERNAL_ERROR" });
  }
}

/**
 * Build the failure for a rejected `fetch`. The message must stay actionable
 * without leaking the environment URL or the request path, so only stable
 * system codes (`ECONNREFUSED`, `UND_ERR_SOCKET`…) and error class names are
 * used. undici wraps some failures in an AggregateError without a `code`, and
 * a rejected request may carry no cause at all, so the whole chain is scanned
 * before falling back to the error name.
 */
function transportFailure(error: unknown, timeoutMs: number): CliError {
  if (abortName(error)) {
    return new CliError(`请求超时：${timeoutMs}ms`, 1, { code: "EADP_REQUEST_FAILED" });
  }
  return new CliError(`请求失败${diagnosticSuffix(error)}`, 1, {
    code: "EADP_REQUEST_FAILED"
  });
}

function abortName(error: unknown): boolean {
  const name = readText(error, "name");
  return name === "TimeoutError" || name === "AbortError";
}

/** `（ENOTFOUND）`-style suffix; never contains a host, URL or path. */
function diagnosticSuffix(error: unknown): string {
  const codes = new Set<string>();
  const names = new Set<string>();
  collectDiagnostics(error, codes, names, 0);
  if (codes.size > 0) return `（${[...codes].sort().join("/")}）`;
  const name = readText(error, "name");
  if (name) return `（${name}）`;
  if (names.size > 0) return `（${[...names].sort().join("/")}）`;
  return "";
}

function collectDiagnostics(
  value: unknown,
  codes: Set<string>,
  names: Set<string>,
  depth: number
): void {
  if (depth > 4 || typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const code = readText(record, "code");
  if (code) codes.add(code);
  const name = readText(record, "name");
  if (name) names.add(name);
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) collectDiagnostics(item, codes, names, depth + 1);
  }
  collectDiagnostics(record.cause, codes, names, depth + 1);
}

function readText(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const text = (value as Record<string, unknown>)[field];
  return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
}

function requestFailureDetails(
  data: unknown,
  headers: Record<string, string>
): CliErrorDetails {
  const body = typeof data === "object" && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const traceId = (body ? readText(body, "traceId") : undefined) ??
    readText(headers, "x-trace-id") ?? readText(headers, "trace-id");
  const requestId = (body ? readText(body, "requestId") : undefined) ??
    readText(headers, "x-request-id") ?? readText(headers, "request-id");
  return {
    code: "EADP_REQUEST_FAILED",
    ...(body && "detail" in body && body.detail !== undefined ? { detail: body.detail } : {}),
    ...(traceId === undefined ? {} : { traceId }),
    ...(requestId === undefined ? {} : { requestId })
  };
}

function isEadpFailure(value: unknown): value is Record<string, unknown> & { success: false } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "success" in value &&
    (value as { success: unknown }).success === false
  );
}

function formatCompact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
