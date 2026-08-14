/**
 * 统一 mock HTTP 服务器。
 *
 * 所有测试通过 MockEadpServer 模拟远端 EADP 环境，不再在单个测试文件里
 * 手工 createServer。每个环境一个实例；实例记录全部请求，供零写入断言、
 * 请求体断言与回查状态验证使用。
 *
 * 默认封装 EADP 成功信封 `{ success: true, message: "ok", data }`；
 * 失败用 `{ success: false, message }`。测试也可用 ctx.raw 原样返回。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface CapturedRequest {
  method: string;
  /** 不含查询串的路径。 */
  path: string;
  /** 原始查询串（不含 ?）。 */
  search: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
  url: string;
}

export interface RouteContext {
  server: MockEadpServer;
  method: string;
  path: string;
  /** 原始查询串（不含 ?）。 */
  search: string;
  /** 完整请求 URL（path + search）。 */
  url: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
  response: ServerResponse;
  /** 以 EADP 成功信封返回 data。 */
  json(data: unknown, status?: number): void;
  /** 以 EADP 失败信封返回 message。 */
  fail(message: string, status?: number): void;
  /** 原样返回响应体（不做信封包装）。 */
  raw(data: unknown, status?: number): void;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

export interface TenantInfo {
  tenantCode: string;
  authorityPolicy: string;
}

export type PathMatcher = string | RegExp | ((method: string, path: string) => boolean);

interface RegisteredRoute {
  matcher: PathMatcher;
  handler: RouteHandler;
}

export class MockEadpServer {
  /** 全部收到的请求（按到达顺序）。 */
  readonly requests: CapturedRequest[] = [];

  /** 租户解析器；env add 的 getByApiKey 端点默认使用它。 */
  tenant: (token: string) => TenantInfo = () => ({
    tenantCode: "global",
    authorityPolicy: "GlobalAdmin"
  });

  private readonly routes: RegisteredRoute[] = [];
  private server: Server | undefined;
  private listenPromise: Promise<string> | undefined;
  /** 服务器捕获到的运行期错误（用于测试排障）。 */
  readonly errors: unknown[] = [];

  /** 注册路由。同一精确字符串路径再次注册时替换旧实现。 */
  on(path: string | RegExp, handler: RouteHandler): this {
    const index = typeof path === "string"
      ? this.routes.findIndex((route) => route.matcher === path)
      : -1;
    const route = { matcher: path, handler };
    if (index >= 0) {
      this.routes[index] = route;
    } else {
      this.routes.push(route);
    }
    return this;
  }

  /** 按路径后缀匹配注册（如 "/feature/findByPage"）。 */
  onEndsWith(suffix: string, handler: RouteHandler): this {
    return this.on((_method, path) => path.endsWith(suffix), handler);
  }

  /** 按方法 + 路径同时匹配注册。 */
  onRequest(method: string, path: string | RegExp, handler: RouteHandler): this {
    return this.on(
      (candidateMethod, candidatePath) =>
        candidateMethod.toUpperCase() === method.toUpperCase() &&
        (typeof path === "string" ? candidatePath === path : path.test(candidatePath)),
      handler
    );
  }

  /** 注册默认租户端点处理。可用 server.on 覆盖精确路径。 */
  onTenantEndpoint(): this {
    this.on("/api-gateway/sei-basic/account/getByApiKey", (context) => {
      const token = String(context.headers["x-api-token"] ?? context.query.get("apiKey") ?? "");
      const info = this.tenant(token);
      if (!info || !info.tenantCode || !info.authorityPolicy) {
        context.fail("invalid apiKey", 400);
        return;
      }
      context.json({ tenantCode: info.tenantCode, authorityPolicy: info.authorityPolicy });
    });
    return this;
  }

  /** 满足条件的请求数量（用于零写入断言）。 */
  count(method?: string, matcher?: PathMatcher): number {
    return this.requests.filter((request) => matches(request, method, matcher)).length;
  }

  /** 满足条件的请求体列表。 */
  bodies(method?: string, matcher?: PathMatcher): unknown[] {
    return this.requests
      .filter((request) => matches(request, method, matcher))
      .map((request) => request.body);
  }

  /** 满足条件的请求头（原始）。 */
  headers(method?: string, matcher?: PathMatcher): IncomingMessage["headers"][] {
    return this.requests
      .filter((request) => matches(request, method, matcher))
      .map((request) => request.headers);
  }

  async start(): Promise<string> {
    if (this.listenPromise) return this.listenPromise;
    this.listenPromise = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error) => this.errors.push(error));
      });
      this.server = server;
      server.on("error", reject);
      server.on("clientError", (error) => this.errors.push(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("测试服务器未分配端口"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.listenPromise;
  }

  baseUrl(): Promise<string> {
    return this.start();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const rawBody = await readRawBody(request);
    let body: unknown;
    if (rawBody.trim() !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const captured: CapturedRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      search: url.search.replace(/^\?/, ""),
      query: url.searchParams,
      headers: request.headers,
      body,
      rawBody,
      url: url.pathname + url.search
    };
    this.requests.push(captured);

    const context: RouteContext = {
      server: this,
      method: captured.method,
      path: captured.path,
      search: captured.search,
      url: captured.url,
      query: captured.query,
      headers: captured.headers,
      body,
      rawBody,
      response,
      json: (data, status = 200) => {
        respondJson(response, status, { success: true, message: "ok", data });
      },
      fail: (message, status = 400) => {
        respondJson(response, status, { success: false, message });
      },
      raw: (data, status = 200) => {
        respondJson(response, status, data);
      }
    };

    const route = this.routes.find((candidate) =>
      typeof candidate.matcher === "string"
        ? captured.path === candidate.matcher
        : typeof candidate.matcher === "function"
          ? candidate.matcher(captured.method, captured.path)
          : candidate.matcher.test(captured.path)
    );
    if (!route) {
      context.fail("not found", 404);
      return;
    }
    try {
      await route.handler(context);
    } catch (error) {
      if (!response.writableEnded) {
        context.fail(error instanceof Error ? error.message : String(error), 500);
      } else {
        throw error;
      }
    }
  }
}

/** 启动并跟踪一个 mock 服务器，返回其实例（随后可 server.baseUrl()）。 */
export function createMockServer(): MockEadpServer {
  return new MockEadpServer();
}

function matches(
  request: CapturedRequest,
  method: string | undefined,
  matcher: PathMatcher | undefined
): boolean {
  if (method !== undefined && request.method.toUpperCase() !== method.toUpperCase()) {
    return false;
  }
  if (matcher === undefined) return true;
  if (typeof matcher === "string") return request.path === matcher;
  if (typeof matcher === "function") return matcher(request.method, request.path);
  return matcher.test(request.path);
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
