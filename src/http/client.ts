import { CliError } from "../errors.js";

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

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: options.method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
    };
    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
    }
    response = await fetch(url, requestInit);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new CliError(`请求超时：${options.timeoutMs ?? 30_000}ms`);
    }
    throw new CliError(`请求失败：${error instanceof Error ? error.message : String(error)}`);
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
    throw new CliError(`HTTP ${response.status}：${formatCompact(data)}`);
  }
  if (isEadpFailure(data)) {
    throw new CliError(`EADP 请求失败：${data.message || "未知错误"}`);
  }
  return result;
}

function isEadpFailure(value: unknown): value is { success: false; message?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success: unknown }).success === false
  );
}

function formatCompact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
