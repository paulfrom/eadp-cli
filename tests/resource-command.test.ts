import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  )));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resource-first command workflow", () => {
  it("exposes list/describe with declarative capabilities", async () => {
    const output = captureOutput();
    const program = createProgram().exitOverride();
    await program.parseAsync(["resource", "list"], { from: "user" });
    expect(output.text()).toContain('"feature"');
    await createProgram().parseAsync(["resource", "describe", "feature"], { from: "user" });
    expect(output.text()).toContain('"identityFields"');
  });

  it("query aggregates every page using the registered pagination contract", async () => {
    let pages = 0;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        if (!requestPath(request).endsWith("/feature/findByPage")) return respond(response, []);
        pages += 1;
        respond(response, pages === 1
          ? { rows: [{ code: "A", name: "A" }, ...Array.from({ length: 499 }, (_, index) => ({ code: `A-${index}`, name: `A-${index}` }))] }
          : { rows: [{ code: "B", name: "B" }] });
      },
      target: (_request, response) => respond(response, [])
    });
    const output = captureOutput();
    await createProgram(store).parseAsync(["resource", "query", "feature", "--env", "source"], { from: "user" });
    const result = JSON.parse(output.text()) as { items: Array<{ code: string }>; total: number };
    expect(result.items[0]!.code).toBe("A");
    expect(result.items.at(-1)!.code).toBe("B");
    expect(result.total).toBe(501);
    expect(pages).toBe(2);
  });

  it("write defaults to preview and --apply writes then verifies without delete", async () => {
    const targetRows: Array<Record<string, unknown>> = [];
    let saves = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, []),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: targetRows });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "module-1", code: "BASIC" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, []);
          return;
        }
        if (path.endsWith("/feature/save")) {
          saves += 1;
          const body = await readBody(request) as Record<string, unknown>;
          const saved = { ...body, id: `feature-${saves}` };
          targetRows.splice(0, targetRows.length, saved);
          respond(response, saved);
          return;
        }
        respond(response, [], 404);
      }
    });
    const data = JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" });
    const output = captureOutput();
    await createProgram(store).parseAsync(["resource", "write", "feature", "--env", "target", "--data", data], { from: "user" });
    expect(JSON.parse(output.text()).applied).toBe(false);
    expect(saves).toBe(0);
    output.clear();
    await createProgram(store).parseAsync(["resource", "write", "feature", "--env", "target", "--data", data, "--apply"], { from: "user" });
    const result = JSON.parse(output.text());
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.operationId).toEqual(expect.any(String));
    expect(saves).toBe(1);
  });

  it("compare is read-only and sync reuses the plan for an idempotent apply", async () => {
    const sourceRows = [{ code: "A", name: "new", appModuleCode: "BASIC" }];
    const targetRows: Array<Record<string, unknown>> = [{ id: "target-a", code: "A", name: "old", appModuleId: "module-1" }];
    let saves = 0;
    const { store } = await createFixtureServer({
      source: (request, response) => {
        if (requestPath(request).endsWith("/feature/findByPage")) return respond(response, { rows: sourceRows });
        respond(response, [], 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) return respond(response, { rows: targetRows });
        if (path.endsWith("/appModule/findAll")) return respond(response, [{ id: "module-1", code: "BASIC" }]);
        if (path.endsWith("/featureGroup/findAll")) return respond(response, []);
        if (path.endsWith("/feature/save")) {
          saves += 1;
          const body = await readBody(request) as Record<string, unknown>;
          targetRows.splice(0, targetRows.length, body);
          return respond(response, { ...body, id: "target-a" });
        }
        respond(response, [], 404);
      }
    });
    const output = captureOutput();
    await createProgram(store).parseAsync(["resource", "compare", "feature", "--source", "source", "--target", "target"], { from: "user" });
    const comparison = JSON.parse(output.text());
    expect(comparison.summary).toEqual({ create: 0, update: 1, unchanged: 0, blocked: 0 });
    expect(saves).toBe(0);
    output.clear();
    await createProgram(store).parseAsync(["resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"], { from: "user" });
    expect(JSON.parse(output.text()).verified).toBe(true);
    expect(saves).toBe(1);
    output.clear();
    await createProgram(store).parseAsync(["resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"], { from: "user" });
    expect(JSON.parse(output.text()).summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(saves).toBe(1);
  });

  it("checks both migration tenants before reading either environment", async () => {
    let requests = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => { requests += 1; respond(response, []); },
      target: (_request, response) => { requests += 1; respond(response, []); }
    });
    await store.update((config) => { config.environments.target!.tenantCode = "tenant-a"; });
    await expect(createProgram(store).parseAsync([
      "resource", "compare", "feature", "--source", "source", "--target", "target"
    ], { from: "user" })).rejects.toThrow("必须使用 global 租户");
    expect(requests).toBe(0);
  });

  it("rejects the same migration environment and unsupported time filters before remote reads", async () => {
    let requests = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => { requests += 1; respond(response, []); },
      target: (_request, response) => { requests += 1; respond(response, []); }
    });

    await expect(createProgram(store).parseAsync([
      "resource", "compare", "feature", "--source", "source", "--target", "source"
    ], { from: "user" })).rejects.toThrow("源环境和目标环境不能相同");
    await expect(createProgram(store).parseAsync([
      "resource", "compare", "menu", "--source", "source", "--target", "target",
      "--created-in", "2026-08"
    ], { from: "user" })).rejects.toThrow("资源 menu 不支持时间过滤");
    await expect(createProgram(store).parseAsync([
      "resource", "query", "feature", "--env", "source", "--filter", "code:IN:A"
    ], { from: "user" })).rejects.toThrow("不支持的过滤操作符：IN");
    expect(requests).toBe(0);
  });

  it("applies time filters to the source query only", async () => {
    const sourceBodies: Array<Record<string, unknown>> = [];
    const targetBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        sourceBodies.push(await readBody(request) as Record<string, unknown>);
        respond(response, { rows: [] });
      },
      target: async (request, response) => {
        targetBodies.push(await readBody(request) as Record<string, unknown>);
        respond(response, { rows: [] });
      }
    });
    captureOutput();

    await createProgram(store).parseAsync([
      "resource", "compare", "feature", "--source", "source", "--target", "target",
      "--created-in", "2026-08"
    ], { from: "user" });

    expect(sourceBodies[0]!.filters).toEqual([
      { fieldName: "createdDate", operator: "GE", value: "2026-08-01 00:00:00" },
      { fieldName: "createdDate", operator: "LT", value: "2026-09-01 00:00:00" }
    ]);
    expect(targetBodies[0]!.filters).toEqual([]);
  });

  it("binds serial-number tenant and applies NEW only on create without overriding explicit or target values", async () => {
    const item = [{
      elementName: "流水号", elementCode: "SERIAL_CODE", elementValue: "5",
      isolation: false, linkCharacter: "EMPTY", sort: 0
    }];
    const targetRows: Array<Record<string, unknown>> = [{
      id: "serial-a", entityClassName: "com.example.A", tenantCode: "global",
      configType: "CODE_TYPE", name: "old", returnStrategy: "PATCH", configItem: item
    }];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, []),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) return respond(response, { rows: targetRows });
        if (path.endsWith("/serialNumberConfig/save")) {
          const body = await readBody(request) as Record<string, unknown>;
          savedBodies.push(body);
          const id = typeof body.id === "string" ? body.id : `serial-${savedBodies.length + 1}`;
          const saved = { ...body, id };
          const index = targetRows.findIndex((row) => row.entityClassName === body.entityClassName);
          if (index >= 0) targetRows[index] = saved;
          else targetRows.push(saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    const data = JSON.stringify([
      { entityClassName: "com.example.A", name: "updated", configItem: item },
      { entityClassName: "com.example.B", name: "created-default", configItem: item },
      { entityClassName: "com.example.C", name: "created-explicit", returnStrategy: "REPEAT", configItem: item }
    ]);
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "resource", "write", "serial-number", "--env", "target", "--data", data, "--apply"
    ], { from: "user" });

    expect(savedBodies).toHaveLength(3);
    expect(savedBodies.map((body) => body.tenantCode)).toEqual(["global", "global", "global"]);
    expect(savedBodies.map((body) => body.returnStrategy)).toEqual(["PATCH", "NEW", "REPEAT"]);
    expect(JSON.parse(output.text())).toMatchObject({ applied: true, verified: true });
  });

  it("preserves target-only feature fields and defaults tenantCanUse only for creates", async () => {
    const targetRows: Array<Record<string, unknown>> = [{
      id: "feature-a", code: "A", name: "old", appModuleId: "module-1",
      url: "/existing", canMenu: true, mobileUse: true,
      tenantCanUse: false, specialProjectId: "project-1"
    }];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, []),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) return respond(response, { rows: targetRows });
        if (path.endsWith("/appModule/findAll")) return respond(response, [{ id: "module-1", code: "BASIC" }]);
        if (path.endsWith("/feature/save")) {
          const body = await readBody(request) as Record<string, unknown>;
          savedBodies.push(body);
          const saved = {
            ...body,
            id: typeof body.id === "string" ? body.id : `feature-${String(body.code).toLocaleLowerCase()}`
          };
          const index = targetRows.findIndex((row) => row.code === body.code);
          if (index >= 0) targetRows[index] = saved;
          else targetRows.push(saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    const data = JSON.stringify([
      { code: "A", name: "updated", appModuleCode: "BASIC" },
      { code: "B", name: "created", appModuleCode: "BASIC" },
      { code: "C", name: "created-disabled", appModuleCode: "BASIC", tenantCanUse: false }
    ]);
    captureOutput();

    await createProgram(store).parseAsync([
      "resource", "write", "feature", "--env", "target", "--data", data, "--apply"
    ], { from: "user" });

    expect(savedBodies[0]).toMatchObject({
      code: "A", url: "/existing", canMenu: true, mobileUse: true,
      tenantCanUse: false, specialProjectId: "project-1"
    });
    expect(savedBodies[1]).toMatchObject({ code: "B", tenantCanUse: true });
    expect(savedBodies[2]).toMatchObject({ code: "C", tenantCanUse: false });
  });

  it("syncs serial-number by composite key, strips source IDs, blocks invalid records, and stays idempotent", async () => {
    const validItem = {
      id: "source-item", configId: "source-config", elementName: "流水号",
      elementCode: "SERIAL_CODE", elementValue: "5", isolation: false,
      linkCharacter: "EMPTY", sort: 0
    };
    const sourceRows = [
      {
        id: "source-a", entityClassName: "com.example.A", tenantCode: "global",
        configType: "CODE_TYPE", name: "A", returnStrategy: "REPEAT", configItem: [validItem]
      },
      {
        id: "source-b", entityClassName: "com.example.B", tenantCode: "global",
        configType: "CODE_TYPE", name: "B", configItem: []
      }
    ];
    const targetRows: Array<Record<string, unknown>> = [];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: (request, response) => requestPath(request).endsWith("/serialNumberConfig/findByPage")
        ? respond(response, { rows: sourceRows })
        : respond(response, [], 404),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) return respond(response, { rows: targetRows });
        if (path.endsWith("/serialNumberConfig/save")) {
          const body = await readBody(request) as Record<string, unknown>;
          savedBodies.push(body);
          const saved = { ...body, id: "target-a" };
          targetRows.splice(0, targetRows.length, saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" });

    const first = JSON.parse(output.text());
    expect(first.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(first.skippedBlocked).toBe(1);
    expect(first.blockingIssues[0]).toMatchObject({ resource: "serial-number", field: "configItem" });
    expect(savedBodies[0]).not.toHaveProperty("id");
    expect(savedBodies[0]).toMatchObject({ tenantCode: "global", returnStrategy: "REPEAT" });
    const savedItems = savedBodies[0]!.configItem as Array<Record<string, unknown>>;
    expect(savedItems[0]).not.toHaveProperty("id");
    expect(savedItems[0]).not.toHaveProperty("configId");

    output.clear();
    await createProgram(store).parseAsync([
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" });
    expect(JSON.parse(output.text()).summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 1 });
    expect(savedBodies).toHaveLength(1);
  });

  it("rejects source serial-number records that map to one target composite key", async () => {
    const item = [{
      elementName: "流水号", elementCode: "SERIAL_CODE", elementValue: "5",
      isolation: false, linkCharacter: "EMPTY", sort: 0
    }];
    let saves = 0;
    const { store } = await createFixtureServer({
      source: (request, response) => requestPath(request).endsWith("/serialNumberConfig/findByPage")
        ? respond(response, { rows: [
            { entityClassName: "com.example.Order", tenantCode: "tenant-a", configItem: item },
            { entityClassName: "com.example.Order", tenantCode: "tenant-b", configItem: item }
          ] })
        : respond(response, [], 404),
      target: (request, response) => {
        if (requestPath(request).endsWith("/serialNumberConfig/save")) saves += 1;
        respond(response, { rows: [] });
      }
    });

    await expect(createProgram(store).parseAsync([
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" })).rejects.toThrow("源环境记录映射后业务唯一键重复");
    expect(saves).toBe(0);
  });

  it("maps feature-group dependencies by code and never copies source IDs", async () => {
    const targetRows: Array<Record<string, unknown>> = [];
    let savedBody: Record<string, unknown> | undefined;
    const { store } = await createFixtureServer({
      source: (request, response) => requestPath(request).endsWith("/featureGroup/findAll")
        ? respond(response, [{
            id: "source-group", code: "GROUP", name: "Group",
            appModuleId: "source-module", appModuleCode: "BASIC"
          }])
        : respond(response, [], 404),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/featureGroup/findAll")) return respond(response, targetRows);
        if (path.endsWith("/appModule/findAll")) return respond(response, [{ id: "target-module", code: "BASIC" }]);
        if (path.endsWith("/featureGroup/save")) {
          savedBody = await readBody(request) as Record<string, unknown>;
          const saved = { ...savedBody, id: "target-group", appModuleCode: "BASIC" };
          targetRows.push(saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "resource", "sync", "feature-group", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" });

    expect(savedBody).toEqual({ code: "GROUP", name: "Group", appModuleId: "target-module" });
    expect(JSON.parse(output.text())).toMatchObject({ applied: true, verified: true });
  });

  it("uses the app-module create default without inventing unrelated fields", async () => {
    const targetRows: Array<Record<string, unknown>> = [];
    let savedBody: Record<string, unknown> | undefined;
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, []),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/appModule/findAll")) return respond(response, targetRows);
        if (path.endsWith("/appModule/save")) {
          savedBody = await readBody(request) as Record<string, unknown>;
          const saved = { ...savedBody, id: "module-order" };
          targetRows.push(saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    captureOutput();

    await createProgram(store).parseAsync([
      "resource", "write", "app-module", "--env", "target", "--data",
      JSON.stringify({ code: "ORDER", name: "订单", remark: "订单服务" }), "--apply"
    ], { from: "user" });

    expect(savedBody).toEqual({ code: "ORDER", name: "订单", remark: "订单服务", rank: 1 });
    expect(savedBody).not.toHaveProperty("description");
    expect(savedBody).not.toHaveProperty("url");
  });

  it("completes the full diff, marks missing dependencies blocked, and applies only safe records", async () => {
    const sourceRows = [
      { code: "SAFE", name: "safe", appModuleCode: "BASIC" },
      { code: "BLOCKED", name: "blocked", appModuleCode: "MISSING" }
    ];
    const targetRows: Array<Record<string, unknown>> = [];
    let saves = 0;
    const { store } = await createFixtureServer({
      source: (request, response) => requestPath(request).endsWith("/feature/findByPage")
        ? respond(response, { rows: sourceRows })
        : respond(response, [], 404),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) return respond(response, { rows: targetRows });
        if (path.endsWith("/appModule/findAll")) return respond(response, [{ id: "module-1", code: "BASIC" }]);
        if (path.endsWith("/feature/save")) {
          saves += 1;
          const body = await readBody(request) as Record<string, unknown>;
          const saved = { ...body, id: "feature-safe" };
          targetRows.push(saved);
          return respond(response, saved);
        }
        respond(response, [], 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" });

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(result.missingDependencies).toEqual([
      { resource: "app-module", identityField: "code", value: "MISSING", reason: "missing" }
    ]);
    expect(result.skippedBlocked).toBe(1);
    expect(result.verified).toBe(true);
    expect(saves).toBe(1);
  });

  it("stops after the first failed resource request without retrying or writing", async () => {
    let requests = 0;
    let saves = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, []),
      target: (request, response) => {
        requests += 1;
        if (requestPath(request).endsWith("/feature/save")) saves += 1;
        respond(response, { error: "boom" }, 500);
      }
    });

    await expect(createProgram(store).parseAsync([
      "resource", "write", "feature", "--env", "target", "--data",
      JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" }), "--apply"
    ], { from: "user" })).rejects.toThrow("HTTP 500");
    expect(requests).toBe(1);
    expect(saves).toBe(0);
  });

  it("routes menu through its special handler and keeps BPM special capabilities discoverable", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) => respond(response, [{ code: "ROOT", name: "Root", children: [] }]),
      target: (_request, response) => respond(response, [{ code: "ROOT", name: "Root", children: [] }])
    });
    const output = captureOutput();
    await createProgram(store).parseAsync(["resource", "query", "menu", "--env", "source"], { from: "user" });
    expect(JSON.parse(output.text()).items[0]).toMatchObject({ code: "ROOT", parentCode: null });
    output.clear();
    await createProgram().parseAsync(["resource", "describe", "bpm"], { from: "user" });
    expect(output.text()).toContain('"handler": "bpm"');
  });
});

async function createFixtureServer(handlers: Record<"source" | "target", (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>): Promise<{ store: ConfigStore }> {
  const urls: Record<string, string> = {};
  for (const name of ["source", "target"] as const) {
    const server = createServer((request, response) => void handlers[name](request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    urls[name] = `http://127.0.0.1:${address.port}`;
  }
  const directory = await mkdtemp(join(tmpdir(), "eadp-resource-new-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({ currentEnvironment: "source", environments: {
    source: { baseUrl: urls.source!, token: "source-secret", tenantCode: "global" },
    target: { baseUrl: urls.target!, token: "target-secret", tenantCode: "global" }
  } });
  return { store };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function captureOutput(): { text: () => string; clear: () => void } {
  let value = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { value += String(chunk); return true; });
  return { text: () => value, clear: () => { value = ""; } };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) : undefined;
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ success: status >= 200 && status < 300, message: status >= 400 ? "not found" : "ok", data }));
}
