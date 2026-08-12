import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";
import { OperationLogStore } from "../src/operations/store.js";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("apply feature-group 与 appModule", () => {
  it("query app-module 仅允许 global，且按 code 过滤", async () => {
    const requests: string[] = [];
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        requests.push(request.url ?? "");
        if ((request.url ?? "").includes("/appModule/findAll")) {
          respond(response, [
            { id: "app-1", code: "ams", name: "AMS" },
            { id: "app-2", code: "other", name: "Other" }
          ]);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      ["query", "app-module", "--env", "global", "--filter", "code:EQ:ams"],
      { from: "user" }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/appModule/findAll");
    const events = output.text().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.kind === "eadp.resource.query.item.v1").map((event) => event.item.code))
      .toEqual(["ams"]);
    expect(events.at(-1)).toMatchObject({ kind: "eadp.resource.query.summary.v1", total: 1 });

    requests.length = 0;
    await expect(
      createProgram(fixture.store).parseAsync(
        ["query", "appModule", "--env", "global", "--filter", "code:EQ:ams"],
        { from: "user" }
      )
    ).rejects.toThrow("app-module");
    expect(requests).toHaveLength(0);

    await fixture.store.update((config) => {
      config.environments.global!.tenantCode = "tenant-a";
    });
    requests.length = 0;
    await expect(
      createProgram(fixture.store).parseAsync(
        ["query", "app-module", "--env", "global", "--filter", "code:EQ:ams"],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(requests).toHaveLength(0);
  });

  it("query feature-group uses findAll and applies LIKE/quick filters locally", async () => {
    const requests: string[] = [];
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        requests.push(request.url ?? "");
        if ((request.url ?? "").includes("/featureGroup/findAll")) {
          respond(response, [
            { id: "group-1", code: "AMS_ORDER", name: "采购订单" },
            { id: "group-2", code: "AMS_OTHER", name: "其他功能" }
          ]);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      [
        "query", "feature-group", "--env", "global",
        "--filter", "code:LIKE:ams", "--quick", "采购"
      ],
      { from: "user" }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/featureGroup/findAll");
    const events = output.text().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.kind === "eadp.resource.query.item.v1").map((event) => event.item.code))
      .toEqual(["AMS_ORDER"]);
    expect(events.at(-1)).toMatchObject({ kind: "eadp.resource.query.summary.v1", total: 1 });
  });

  it("缺失模块时预览显示 create、推断名称和默认 rank，且不写入", async () => {
    let saveCount = 0;
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        if (path.includes("/featureGroup/findAll")) {
          respond(response, []);
        } else if (path.includes("/appModule/findAll")) {
          respond(response, []);
        } else if (path.includes("/save")) {
          saveCount += 1;
          respond(response, undefined, 500);
        } else {
          respond(response, undefined, 404);
        }
      },
      projectName: "orders-business-platform"
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      [
        "apply", "feature-group", "--env", "global", "--app-code", "ams",
        "--code", "AMS_ORDER", "--name", "订单功能组", "--project", fixture.projectPath
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text()) as Record<string, any>;
    expect(result.appModuleAction).toBe("create");
    expect(result.appModule.desired.rank).toBe(1);
    expect([...result.appModule.desired.name].length).toBeLessThanOrEqual(8);
    expect(result.featureGroup.action).toBe("create");
    expect(saveCount).toBe(0);
  });

  it("正式执行连续创建 appModule 与 featureGroup，并回查及共用 operationId", async () => {
    const modules: Array<Record<string, unknown>> = [];
    const groups: Array<Record<string, unknown>> = [];
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        if (path.includes("/featureGroup/findAll")) {
          respond(response, groups);
        } else if (path.includes("/appModule/findAll")) {
          respond(response, modules);
        } else if (path.endsWith("/appModule/save")) {
          const body = await readBody(request) as Record<string, unknown>;
          const saved = { ...body, id: "app-1" };
          modules.push(saved);
          respond(response, saved);
        } else if (path.endsWith("/featureGroup/save")) {
          const body = await readBody(request) as Record<string, unknown>;
          const saved = { ...body, id: "group-1" };
          groups.push(saved);
          respond(response, saved);
        } else {
          respond(response, undefined, 404);
        }
      },
      projectName: "采购申请系统"
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      [
        "apply", "feature-group", "--env", "global", "--app-code", "ams",
        "--code", "AMS_ORDER", "--name", "订单功能组", "--project", fixture.projectPath,
        "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text()) as Record<string, any>;
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.operationId).toMatch(/[A-Za-z0-9-]{10,}/);
    expect(modules).toHaveLength(1);
    expect(groups).toEqual([{ code: "AMS_ORDER", name: "订单功能组", appModuleId: "app-1", id: "group-1" }]);
    const operation = await new OperationLogStore(fixture.store.directory).load(result.operationId);
    expect(operation.actions.map((action) => action.resource)).toEqual(["appModule", "featureGroup"]);
  });

  it("功能项组已存在时只查 group 并短路，不查询模块", async () => {
    const paths: string[] = [];
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        paths.push(request.url ?? "");
        if ((request.url ?? "").includes("/featureGroup/findAll")) {
          respond(response, [{ id: "group-1", code: "AMS_ORDER", name: "订单功能组", appModuleId: "app-1" }]);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      ["apply", "feature-group", "--env", "global", "--app-code", "ams", "--code", "AMS_ORDER", "--name", "订单功能组"],
      { from: "user" }
    );

    const result = JSON.parse(output.text()) as Record<string, any>;
    expect(result.action).toBe("unchanged");
    expect(result.featureGroupAction).toBe("unchanged");
    expect(result.featureGroup.action).toBe("unchanged");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("featureGroup/findAll");
  });

  it("已有模块直接复用远端 name/rank，不要求项目路径可读", async () => {
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        if (path.includes("/featureGroup/findAll")) respond(response, []);
        else if (path.includes("/appModule/findAll")) {
          respond(response, [{ id: "app-1", code: "ams", name: "远端模块", rank: 3 }]);
        } else respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(fixture.store).parseAsync(
      [
        "apply", "feature-group", "--env", "global", "--app-code", "ams",
        "--code", "AMS_ORDER", "--name", "订单功能组", "--project", join(fixture.projectPath, "missing")
      ],
      { from: "user" }
    );
    const result = JSON.parse(output.text()) as Record<string, any>;
    expect(result.appModuleAction).toBe("unchanged");
    expect(result.appModule.name).toBe("远端模块");
    expect(result.appModule.rank).toBe(3);
  });

  it("应用模块 code 歧义时停止且不写入", async () => {
    let saveCalled = false;
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        if (path.includes("/featureGroup/findAll")) respond(response, []);
        else if (path.includes("/appModule/findAll")) {
          respond(response, [{ id: "a1", code: "ams" }, { id: "a2", code: "AMS" }]);
        } else if (path.includes("/save")) {
          saveCalled = true;
          respond(response, undefined, 500);
        } else respond(response, undefined, 404);
      }
    });

    await expect(
      createProgram(fixture.store).parseAsync(
        ["apply", "feature-group", "--env", "global", "--app-code", "ams", "--code", "AMS_ORDER", "--name", "订单功能组"],
        { from: "user" }
      )
    ).rejects.toThrow("应用模块 code 不唯一");
    expect(saveCalled).toBe(false);
  });

  it("模块创建成功后功能项组失败会保留部分成功日志和 operationId", async () => {
    const modules: Array<Record<string, unknown>> = [];
    const paths: string[] = [];
    let featureGroupSaveCalled = false;
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        paths.push(path);
        if (path.includes("/featureGroup/findAll")) respond(response, []);
        else if (path.includes("/appModule/findAll")) respond(response, modules);
        else if (path.endsWith("/appModule/save")) {
          // Keep the created module visible to the required post-create lookup.
          const saved = { id: "app-1", code: "ams", name: "业务系统", rank: 1 };
          modules.push(saved);
          respond(response, saved);
        } else if (path.endsWith("/featureGroup/save")) {
          featureGroupSaveCalled = true;
          respond(response, undefined, 500);
        }
        else respond(response, undefined, 404);
      },
      projectName: "业务系统"
    });

    const error = await captureError(
      createProgram(fixture.store).parseAsync(
        ["apply", "feature-group", "--env", "global", "--app-code", "ams", "--code", "AMS_ORDER", "--name", "订单功能组", "--project", fixture.projectPath, "--apply"],
        { from: "user" }
      )
    );
    if (!error.includes("operation-id")) throw new Error(`command=${error}`);
    if (!paths.includes("/api-gateway/sei-basic/featureGroup/save")) {
      throw new Error(`paths=${JSON.stringify(paths)}`);
    }
    expect(featureGroupSaveCalled).toBe(true);
    const files = await loadOperationRecords(fixture.store.directory);
    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe("partial");
    expect(files[0]!.actions.map((action) => action.resource)).toEqual(["appModule"]);
  });

  it("rollback 按逆序删除功能项组后再删除应用模块", async () => {
    const modules: Array<Record<string, unknown>> = [];
    const groups: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    const fixture = await createFixture({
      onRequest: async (request, response) => {
        const path = request.url ?? "";
        if (path.includes("/featureGroup/findAll")) respond(response, groups);
        else if (path.includes("/appModule/findAll")) respond(response, modules);
        else if (path.endsWith("/appModule/save")) {
          const saved = { ...(await readBody(request) as Record<string, unknown>), id: "app-1" };
          modules.push(saved);
          respond(response, saved);
        } else if (path.endsWith("/featureGroup/save")) {
          const saved = { ...(await readBody(request) as Record<string, unknown>), id: "group-1" };
          groups.push(saved);
          respond(response, saved);
        } else if (path.includes("/featureGroup/findOne")) {
          respond(response, groups[0] ?? null);
        } else if (path.includes("/appModule/findOne")) {
          respond(response, modules[0] ?? null);
        } else if (path.endsWith("/featureGroup/delete/group-1")) {
          deletes.push("featureGroup");
          groups.splice(0);
          respond(response, true);
        } else if (path.endsWith("/appModule/delete/app-1")) {
          deletes.push("appModule");
          modules.splice(0);
          respond(response, true);
        } else respond(response, undefined, 404);
      },
      projectName: "订单系统"
    });
    const output = captureOutput();
    await createProgram(fixture.store).parseAsync(
      ["--compact", "apply", "feature-group", "--env", "global", "--app-code", "ams", "--code", "AMS_ORDER", "--name", "订单功能组", "--project", fixture.projectPath, "--apply"],
      { from: "user" }
    );
    const applied = JSON.parse(output.text().trim().split("\n")[0]!) as { operationId: string };

    await createProgram(fixture.store).parseAsync(
      ["rollback", applied.operationId],
      { from: "user" }
    );

    expect(deletes).toEqual(["featureGroup", "appModule"]);
    expect(groups).toHaveLength(0);
    expect(modules).toHaveLength(0);
  });
});

async function createFixture(options: {
  onRequest: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  projectName?: string;
}): Promise<{ store: ConfigStore; projectPath: string }> {
  const server = createServer((request, response) => void options.onRequest(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
  const directory = await mkdtemp(join(tmpdir(), "eadp-feature-group-"));
  directories.push(directory);
  const projectPath = join(directory, "project");
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, "settings.gradle"), `rootProject.name = '${options.projectName ?? "test-project"}'\n`);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: "global",
    environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }
  });
  return { store, projectPath };
}

function captureOutput(): { text: () => string } {
  let value = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    value += String(chunk);
    return true;
  });
  return { text: () => value };
}

async function captureError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected command to fail");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ success: status >= 200 && status < 300, message: status >= 400 ? "failed" : "ok", data }));
}

async function loadOperationRecords(directory: string): Promise<import("../src/operations/store.js").OperationRecord[]> {
  const values = new Map<string, import("../src/operations/store.js").OperationRecord>();
  const operationsDirectory = join(directory, "operations");
  let names: string[];
  try {
    names = await readdir(operationsDirectory);
  } catch {
    return [];
  }
  for (const name of names.filter((item) => item.endsWith(".jsonl")).sort()) {
    const contents = await readFile(join(operationsDirectory, name), "utf8");
    for (const line of contents.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as import("../src/operations/store.js").OperationRecord;
      values.set(record.id, record);
    }
  }
  return [...values.values()];
}
