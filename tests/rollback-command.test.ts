import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { ConfigStore } from "../src/config/store.js";
import { OperationLogStore } from "../src/operations/store.js";

const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rollback 命令", () => {
  it("多个 operationId 按成功完成时间倒序回滚", async () => {
    const entities = new Map([
      ["featureGroup/group-1", { id: "group-1", code: "GROUP" }],
      ["feature/feature-1", { id: "feature-1", code: "FEATURE" }],
      ["menu/menu-1", { id: "menu-1", code: "MENU" }]
    ]);
    const deleted: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const match = path.match(/\/(featureGroup|feature|menu)\/(findOne|delete\/([^/]+))$/);
      if (!match) return respond(response, null, 404);
      const resource = match[1]!;
      if (match[2] === "findOne") {
        const id = new URL(request.url ?? "/", "http://localhost").searchParams.get("id")!;
        return respond(response, entities.get(`${resource}/${id}`) ?? null);
      }
      const id = match[3]!;
      deleted.push(`${resource}/${id}`);
      entities.delete(`${resource}/${id}`);
      respond(response, true);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-batch-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});
    const logs = new OperationLogStore(directory);
    for (const operation of [
      { id: "group-operation", resource: "featureGroup", entityId: "group-1", completedAt: "2026-08-12T01:00:00.000Z" },
      { id: "feature-operation", resource: "feature", entityId: "feature-1", completedAt: "2026-08-12T01:01:00.000Z" },
      { id: "menu-operation", resource: "menu", entityId: "menu-1", completedAt: "2026-08-12T01:02:00.000Z" }
    ] as const) {
      await logs.save({
        version: 1, id: operation.id, command: `eadp apply ${operation.resource}`,
        environment: "global", createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: operation.completedAt, completedAt: operation.completedAt, status: "completed",
        actions: [{ id: `${operation.id}-create`, type: "create-entity", service: "sei-basic",
          resource: operation.resource, entityId: operation.entityId, expected: { code: entities.get(`${operation.resource}/${operation.entityId}`)!.code },
          deleteMethod: "DELETE", status: "applied" }]
      });
    }

    await createProgram(configStore).parseAsync([
      "rollback", "feature-operation", "group-operation", "menu-operation"
    ], { from: "user" });

    expect(deleted).toEqual(["menu/menu-1", "feature/feature-1", "featureGroup/group-1"]);
  });

  it("批量回滚任一 operation 失败后不再回滚更早完成的操作", async () => {
    const deleted: string[] = [];
    let menuExists = true;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/menu/findOne")) {
        return respond(response, menuExists ? { id: "menu-1", code: "MENU" } : null);
      }
      if (url.pathname.endsWith("/menu/delete/menu-1")) {
        deleted.push("menu");
        menuExists = false;
        return respond(response, true);
      }
      if (url.pathname.endsWith("/feature/findOne")) return respond(response, { id: "feature-1", code: "MODIFIED" });
      if (url.pathname.endsWith("/featureGroup/findOne")) return respond(response, { id: "group-1", code: "GROUP" });
      if (url.pathname.includes("/delete/")) deleted.push(url.pathname);
      respond(response, null, 404);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-batch-stop-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});
    const logs = new OperationLogStore(directory);
    for (const operation of [
      { id: "old-group", resource: "featureGroup", entityId: "group-1", code: "GROUP", completedAt: "2026-08-12T01:00:00.000Z" },
      { id: "middle-feature", resource: "feature", entityId: "feature-1", code: "FEATURE", completedAt: "2026-08-12T01:01:00.000Z" },
      { id: "new-menu", resource: "menu", entityId: "menu-1", code: "MENU", completedAt: "2026-08-12T01:02:00.000Z" }
    ] as const) {
      await logs.save({ version: 1, id: operation.id, command: "test", environment: "global",
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: operation.completedAt,
        completedAt: operation.completedAt, status: "completed", actions: [{ id: `${operation.id}-create`,
          type: "create-entity", service: "sei-basic", resource: operation.resource,
          entityId: operation.entityId, expected: { code: operation.code }, deleteMethod: "DELETE", status: "applied" }]
      });
    }

    await expect(createProgram(configStore).parseAsync([
      "rollback", "old-group", "new-menu", "middle-feature"
    ], { from: "user" })).rejects.toThrow("已被后续修改");
    expect(deleted).toEqual(["menu"]);
    await expect(logs.load("old-group")).resolves.toMatchObject({ status: "completed" });
  });

  it("批量回滚拒绝重复 operationId 且不发起远端请求", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      respond(response, null);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-duplicate-id-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});

    await expect(createProgram(configStore).parseAsync([
      "rollback", "duplicate-operation", "duplicate-operation"
    ], { from: "user" })).rejects.toThrow("重复 operation-id");
    expect(requestCount).toBe(0);
  });

  it("批量回滚拒绝相同 completedAt 且不发起远端请求", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      respond(response, null);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-same-time-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});
    const logs = new OperationLogStore(directory);
    const completedAt = "2026-08-12T01:00:00.000Z";
    for (const [id, entityId] of [["same-time-a", "feature-a"], ["same-time-b", "feature-b"]] as const) {
      await logs.save({ version: 1, id, command: "test", environment: "global",
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: completedAt, completedAt,
        status: "completed", actions: [{ id: `${id}-create`, type: "create-entity", service: "sei-basic",
          resource: "feature", entityId, expected: { code: entityId.toUpperCase() }, deleteMethod: "DELETE", status: "applied" }] });
    }

    await expect(createProgram(configStore).parseAsync([
      "rollback", "same-time-a", "same-time-b"
    ], { from: "user" })).rejects.toThrow("completedAt 唯一");
    expect(requestCount).toBe(0);
  });

  it("批量回滚预检所有操作的租户范围，混合租户动作零远端请求", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      respond(response, { id: "entity", code: "ENTITY" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-mixed-tenant-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});
    const logs = new OperationLogStore(directory);
    await logs.save({ version: 1, id: "new-global", command: "test", environment: "global",
      createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T01:02:00.000Z",
      completedAt: "2026-08-12T01:02:00.000Z", status: "completed", actions: [{ id: "global-create",
        type: "create-entity", service: "sei-basic", resource: "feature", entityId: "feature-1",
        expected: { code: "FEATURE" }, deleteMethod: "DELETE", status: "applied" }] });
    await logs.save({ version: 1, id: "old-non-global", command: "test", environment: "global",
      createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T01:01:00.000Z",
      completedAt: "2026-08-12T01:01:00.000Z", status: "completed", actions: [{ id: "non-global-create",
        type: "create-entity", service: "sei-basic", resource: "featureRole", entityId: "role-1",
        expected: { code: "ROLE" }, deleteMethod: "DELETE", status: "applied" }] });

    await expect(createProgram(configStore).parseAsync([
      "rollback", "old-non-global", "new-global"
    ], { from: "user" })).rejects.toThrow("必须使用非 global 租户");
    expect(requestCount).toBe(0);
  });

  it("回滚全局资源时先校验 tenantCode，非 global 环境零远端请求", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      respond(response, { id: "feature-1", code: "FEATURE" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-global-guard-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({
      currentEnvironment: "dev",
      environments: {
        dev: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "tenant-a" }
      }
    });
    await new OperationLogStore(directory).save({
      version: 1,
      id: "feature-operation",
      command: "eadp apply feature",
      environment: "dev",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      actions: [{
        id: "feature-create",
        type: "create-entity",
        service: "sei-basic",
        resource: "feature",
        entityId: "feature-1",
        expected: { code: "FEATURE" },
        deleteMethod: "DELETE",
        status: "applied"
      }]
    });

    await expect(
      createProgram(configStore).parseAsync(["rollback", "feature-operation"], { from: "user" })
    ).rejects.toThrow("必须使用 global 租户");
    expect(requestCount).toBe(0);
  });

  it("不要求 --apply，并按逆序移除分配关系后删除新增角色", async () => {
    const role = { id: "role-1", code: "TEST_ROLE", name: "测试角色" };
    const assigned = new Set(["feature-1"]);
    const requests: Array<{ method?: string; path?: string }> = [];
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method, path: request.url });
      const path = request.url ?? "";
      if (path.includes("featureRoleFeature/getChildrenFromParentId")) {
        respond(response, [...assigned].map((id) => ({ id })));
      } else if (path.endsWith("featureRoleFeature/removeRelations")) {
        const body = await readBody(request) as { childIds: string[] };
        body.childIds.forEach((id) => assigned.delete(id));
        respond(response, null);
      } else if (path.includes("featureRole/findOne")) {
        respond(response, role.id ? role : null);
      } else if (path.endsWith("featureRole/delete/role-1")) {
        role.id = "";
        respond(response, true);
      } else {
        respond(response, null, 404);
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({
      currentEnvironment: "dev",
      environments: {
        dev: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "tenant-a" }
      }
    });
    await new OperationLogStore(directory).save({
      version: 1,
      id: "operation-1",
      command: "eadp apply functional-role && eadp assign feature",
      environment: "dev",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      actions: [
        {
          id: "action-create",
          type: "create-entity",
          service: "sei-basic",
          resource: "featureRole",
          entityId: "role-1",
          expected: { code: "TEST_ROLE", name: "测试角色" },
          deleteMethod: "DELETE",
          status: "applied"
        },
        {
          id: "action-assign",
          type: "assign-relations",
          service: "sei-basic",
          resource: "featureRoleFeature",
          parentId: "role-1",
          childIds: ["feature-1"],
          status: "applied"
        }
      ]
    });

    await createProgram(configStore).parseAsync(["rollback", "operation-1"], { from: "user" });

    expect(assigned.size).toBe(0);
    expect(role.id).toBe("");
    expect(requests.filter((item) => item.path?.includes("removeRelations"))[0]?.method).toBe("DELETE");
    expect(requests.filter((item) => item.path?.includes("featureRole/delete"))[0]?.method).toBe("DELETE");
    await expect(new OperationLogStore(directory).load("operation-1")).resolves.toMatchObject({
      status: "rolled-back"
    });
  });

  it("给号新增使用 Controller 约定的 POST delete/{id} 回滚", async () => {
    let config: Record<string, unknown> | null = {
      id: "serial-1",
      entityClassName: "com.example.Order",
      configType: "CODE_TYPE"
    };
    const methods: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      if (path.includes("serialNumberConfig/getDetail")) {
        respond(response, config);
      } else if (path.endsWith("serialNumberConfig/delete/serial-1")) {
        methods.push(request.method ?? "");
        config = null;
        respond(response, true);
      } else {
        respond(response, null, 404);
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-serial-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({
      currentEnvironment: "global",
      environments: {
        global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
      }
    });
    await new OperationLogStore(directory).save({
      version: 1,
      id: "serial-operation",
      command: "eadp sync serial-number",
      environment: "global",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      actions: [{
        id: "serial-create",
        type: "create-entity",
        service: "sei-basic",
        resource: "serialNumberConfig",
        entityId: "serial-1",
        expected: { entityClassName: "com.example.Order", configType: "CODE_TYPE" },
        deleteMethod: "POST",
        status: "applied"
      }]
    });

    await createProgram(configStore).parseAsync(["rollback", "serial-operation"], { from: "user" });

    expect(config).toBeNull();
    expect(methods).toEqual(["POST"]);
  });

  it("新增记录被后续修改时停止且不调用删除接口", async () => {
    let deleteCalled = false;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      if (path.includes("featureRole/findOne")) {
        respond(response, { id: "role-1", code: "TEST_ROLE", name: "后续修改" });
      } else if (path.includes("featureRole/delete")) {
        deleteCalled = true;
        respond(response, true);
      } else {
        respond(response, null, 404);
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-conflict-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "dev", environments: {
      dev: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "tenant-a" }
    }});
    await new OperationLogStore(directory).save({
      version: 1, id: "conflict-operation", command: "eadp apply functional-role",
      environment: "dev", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "completed", actions: [{ id: "create-role", type: "create-entity", service: "sei-basic",
        resource: "featureRole", entityId: "role-1", expected: { code: "TEST_ROLE", name: "原名称" },
        deleteMethod: "DELETE", status: "applied" }]
    });

    await expect(
      createProgram(configStore).parseAsync(["rollback", "conflict-operation"], { from: "user" })
    ).rejects.toThrow("已被后续修改");
    expect(deleteCalled).toBe(false);
    await expect(new OperationLogStore(directory).load("conflict-operation")).resolves.toMatchObject({
      status: "rollback-failed"
    });
  });
});

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ success: status < 400, data }));
}
