import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";
import { OperationLogStore } from "../src/operations/store.js";

const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rollback 命令", () => {
  it("支持回滚权限复制新增的员工岗位关系", async () => {
    const assigned = new Set(["position-1"]);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employeePosition/getChildrenFromParentId")) {
        return respond(response, [...assigned].map((id) => ({ id })));
      }
      if (url.pathname.endsWith("/employeePosition/removeRelations")) {
        request.on("data", () => undefined);
        request.on("end", () => {
          assigned.delete("position-1");
          respond(response, true);
        });
        return;
      }
      respond(response, null, 404);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-position-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "dev", environments: {
      dev: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "tenant-a" }
    }});
    await new OperationLogStore(directory).save({
      version: 1, id: "copy-permission", command: "eadp permission assign permission",
      environment: "dev", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "completed", actions: [{ id: "position-action", type: "assign-relations",
        service: "sei-basic", resource: "employeePosition", parentId: "employee-2",
        childIds: ["position-1"], status: "applied" }]
    });

    await createProgram(configStore).parseAsync(["rollback", "copy-permission"], { from: "user" });

    expect(assigned.size).toBe(0);
    await expect(new OperationLogStore(directory).load("copy-permission")).resolves.toMatchObject({
      status: "rolled-back"
    });
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
      command: "eadp permission apply feature",
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
      command: "eadp permission apply functional-role && eadp permission assign feature",
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
      command: "eadp resource sync serial-number",
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

  it("新增记录字段被后续修改时仍删除并回查确认已删除", async () => {
    let present = true;
    let deleteCalled = false;
    const requested: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requested.push(`${request.method ?? ""} ${path}`);
      if (path.includes("featureRole/findOne")) {
        respond(response, present
          ? { id: "role-1", code: "TEST_ROLE", name: "后续修改" }
          : null);
      } else if (path.includes("featureRole/delete")) {
        deleteCalled = true;
        present = false;
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
      version: 1, id: "conflict-operation", command: "eadp permission apply functional-role",
      environment: "dev", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "completed", actions: [{ id: "create-role", type: "create-entity", service: "sei-basic",
        resource: "featureRole", entityId: "role-1", expected: { code: "TEST_ROLE", name: "原名称" },
        deleteMethod: "DELETE", status: "applied" }]
    });

    await createProgram(configStore).parseAsync(["rollback", "conflict-operation"], { from: "user" });
    expect(deleteCalled).toBe(true);
    expect(requested.filter((item) => item.includes("featureRole/findOne"))).toHaveLength(2);
    expect(requested.some((item) => item.startsWith("DELETE ") && item.includes("featureRole/delete/role-1"))).toBe(true);
    await expect(new OperationLogStore(directory).load("conflict-operation")).resolves.toMatchObject({
      status: "rolled-back"
    });
  });

  it("删除接口返回成功但记录仍存在时回滚失败", async () => {
    let deleteCalls = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      if (path.includes("feature/findOne")) {
        respond(response, { id: "feature-1", code: "FEATURE_1" });
      } else if (path.includes("feature/delete/feature-1")) {
        deleteCalls += 1;
        respond(response, true);
      } else {
        respond(response, null, 404);
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-rollback-verify-delete-"));
    temporaryDirectories.push(directory);
    const configStore = new ConfigStore(directory);
    await configStore.save({ currentEnvironment: "global", environments: {
      global: { baseUrl: `http://127.0.0.1:${address.port}`, token: "secret", tenantCode: "global" }
    }});
    await new OperationLogStore(directory).save({
      version: 1, id: "verify-delete-operation", command: "eadp permission apply feature",
      environment: "global", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "completed", actions: [{ id: "create-feature", type: "create-entity", service: "sei-basic",
        resource: "feature", entityId: "feature-1", expected: { code: "FEATURE_1" },
        deleteMethod: "DELETE", status: "applied" }]
    });

    await expect(
      createProgram(configStore).parseAsync(["rollback", "verify-delete-operation"], { from: "user" })
    ).rejects.toThrow("回滚后回查失败：feature/feature-1 仍然存在");
    expect(deleteCalls).toBe(1);
    await expect(new OperationLogStore(directory).load("verify-delete-operation")).resolves.toMatchObject({
      status: "rollback-failed",
      actions: [expect.objectContaining({ status: "applied" })]
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
