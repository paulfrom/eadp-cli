import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { ConfigStore } from "../src/config/store.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("query 和 sync 命令", () => {
  it("query 给号配置时默认限定 CODE_TYPE，并按 entityClassName 校验唯一性", async () => {
    let requestBody: unknown;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        requestBody = await readBody(request);
        respond(response, {
          rows: [
            {
              id: "serial-1",
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE"
            }
          ],
          total: 1
        });
      }
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "global";
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "query",
        "serialNumberConfig",
        "--env",
        "source",
        "--entity-class",
        "com.example.Order"
      ],
      { from: "user" }
    );

    expect(requestBody).toMatchObject({
      filters: [
        { fieldName: "entityClassName", operator: "EQ", value: "com.example.Order" },
        { fieldName: "configType", operator: "EQ", value: "CODE_TYPE" }
      ]
    });
    const result = JSON.parse(output.text());
    expect(result.identity).toEqual({
      field: "entityClassName",
      value: "com.example.Order",
      exists: true,
      unique: true
    });
  });

  it("query 给号配置发现重复 entityClassName 时终止", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) =>
        respond(response, {
          rows: [
            { id: "serial-1", entityClassName: "com.example.Order", configType: "CODE_TYPE" },
            { id: "serial-2", entityClassName: "com.example.Order", configType: "CODE_TYPE" }
          ],
          total: 2
        })
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "global";
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "query",
          "serialNumberConfig",
          "--env",
          "source",
          "--entity-class",
          "com.example.Order"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("entityClassName 不唯一");
  });

  it("query 自动读取全部分页结果", async () => {
    const requestedPages: number[] = [];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as {
          pageInfo: { page: number; rows: number };
        };
        requestedPages.push(body.pageInfo.page);
        const rows =
          body.pageInfo.page === 1
            ? Array.from({ length: body.pageInfo.rows }, (_, index) => ({
                id: `feature-${index}`,
                code: `FEATURE_${index}`
              }))
            : [{ id: "feature-last", code: "FEATURE_LAST" }];
        respond(response, { rows, total: body.pageInfo.rows + 1 });
      },
      target: (_request, response) => respond(response, { rows: [], total: 0 })
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["query", "feature", "--env", "source"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(requestedPages).toEqual([1, 2]);
    expect(result.items).toHaveLength(501);
  });

  it("query 将月份转换成创建时间的左闭右开过滤条件", async () => {
    let requestBody: unknown;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        requestBody = await readBody(request);
        respond(response, {
          rows: [{ id: "feature-a", code: "NEW_FEATURE", createdDate: "2026-07-10 08:00:00" }],
          total: 1
        });
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "query",
        "feature",
        "--env",
        "source",
        "--created-in",
        "2026-07",
      ],
      { from: "user" }
    );

    expect(requestBody).toMatchObject({
      filters: [
        { fieldName: "createdDate", operator: "GE", value: "2026-07-01 00:00:00" },
        { fieldName: "createdDate", operator: "LT", value: "2026-08-01 00:00:00" }
      ]
    });
    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.resource.query.v1");
    expect(result.items).toHaveLength(1);
  });

  it("sync 功能项时按业务代码映射依赖和目标记录，默认只预览", async () => {
    let targetSaveCount = 0;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [
              {
                id: "source-feature-id",
                code: "NEW_FEATURE",
                name: "新功能",
                url: "/new",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleId: "source-app-id",
                appModuleCode: "BASIC",
                featureGroupId: "source-group-id",
                featureGroupCode: "BASE_CONFIG",
                createdDate: "2026-07-10 08:00:00"
              }
            ],
            total: 1
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: [], total: 0 });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "BASIC" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, [{ id: "target-group-id", code: "BASE_CONFIG" }]);
          return;
        }
        if (path.endsWith("/feature/save")) {
          targetSaveCount += 1;
          respond(response, { id: "target-feature-id" });
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "sync",
        "feature",
        "--source",
        "source",
        "--target",
        "target",
        "--created-in",
        "2026-07",
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.resource.sync.v1");
    expect(result.applied).toBe(false);
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0 });
    expect(result.changes[0].desired).toMatchObject({
      code: "NEW_FEATURE",
      appModuleId: "target-app-id",
      featureGroupId: "target-group-id"
    });
    expect(result.changes[0].desired).not.toHaveProperty("id");
    expect(result.changes[0].desired).not.toHaveProperty("createdDate");
    expect(targetSaveCount).toBe(0);
  });

  it("sync --apply 写入后重新查询验证", async () => {
    const targetFeatures: Array<Record<string, unknown>> = [];
    let savedBody: Record<string, unknown> | undefined;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        if (requestPath(request).endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [
              {
                id: "source-id",
                code: "NEW_FEATURE",
                name: "新功能",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleCode: "BASIC"
              }
            ],
            total: 1
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: targetFeatures, total: targetFeatures.length });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "BASIC" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, []);
          return;
        }
        if (path.endsWith("/feature/save")) {
          savedBody = (await readBody(request)) as Record<string, unknown>;
          const saved = { ...savedBody, id: "target-id" };
          targetFeatures.push(saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "sync",
        "feature",
        "--source",
        "source",
        "--target",
        "target",
        "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(savedBody).toMatchObject({
      code: "NEW_FEATURE",
      appModuleId: "target-app-id"
    });
  });

  it("迁移前先校验源和目标租户，任一不满足时不发起远程请求", async () => {
    let sourceRequestCount = 0;
    let targetRequestCount = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => {
        sourceRequestCount += 1;
        respond(response, { rows: [], total: 0 });
      },
      target: (_request, response) => {
        targetRequestCount += 1;
        respond(response, { rows: [], total: 0 });
      }
    });

    await store.update((config) => {
      config.environments.target!.tenantCode = "tenant-a";
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "sync",
          "feature",
          "--source",
          "source",
          "--target",
          "target"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(sourceRequestCount).toBe(0);
    expect(targetRequestCount).toBe(0);

    await store.update((config) => {
      config.environments.source!.tenantCode = "tenant-a";
      config.environments.target!.tenantCode = "global";
    });
    sourceRequestCount = 0;
    targetRequestCount = 0;

    await expect(
      createProgram(store).parseAsync(
        [
          "sync",
          "feature",
          "--source",
          "source",
          "--target",
          "target"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(sourceRequestCount).toBe(0);
    expect(targetRequestCount).toBe(0);
  });
});

async function createFixtureServer(
  handlers: Record<
    "source" | "target",
    (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  >
): Promise<{ store: ConfigStore }> {
  const urls: Record<string, string> = {};
  for (const name of ["source", "target"] as const) {
    const server = createServer((request, response) => void handlers[name](request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }
    urls[name] = `http://127.0.0.1:${address.port}`;
  }
  const directory = await mkdtemp(join(tmpdir(), "eadp-resource-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: "source",
    environments: {
      source: { baseUrl: urls.source!, token: "source-secret", tenantCode: "global" },
      target: { baseUrl: urls.target!, token: "target-secret", tenantCode: "global" }
    }
  });
  return { store };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function captureOutput(): { text: () => string } {
  let value = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    value += String(chunk);
    return true;
  });
  return { text: () => value };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) : undefined;
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      success: status >= 200 && status < 300,
      message: status >= 400 ? "not found" : "ok",
      data
    })
  );
}
