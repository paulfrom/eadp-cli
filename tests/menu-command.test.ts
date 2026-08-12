import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";
import { OperationLogStore } from "../src/operations/store.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  )));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("菜单命令", () => {
  it("query menu 使用菜单树接口并输出带 parentCode 的扁平结果", async () => {
    const { store } = await fixture({
      source: (request, response) => {
        expect(pathOf(request)).toBe("/api-gateway/sei-basic/menu/getMenuTree");
        respond(response, [{
          id: "root-id", code: "PURCHASE", name: "采购管理", rank: 0,
          children: [{ id: "child-id", code: "PURCHASE_APPLY", name: "采购申请", rank: 1, children: [] }]
        }]);
      },
      target: (_request, response) => respond(response, [])
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["query", "menu", "--env", "source", "--quick", "申请"],
      { from: "user" }
    );

    const lines = parseNdjson(output.text());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ kind: "eadp.resource.query.meta.v1", resource: "menu" });
    expect(lines[1]).toMatchObject({
      kind: "eadp.resource.query.item.v1",
      item: { code: "PURCHASE_APPLY", parentCode: "PURCHASE" }
    });
    expect(lines[2]).toMatchObject({ kind: "eadp.resource.query.summary.v1", total: 1 });
  });

  it("apply menu 帮助明确菜单 code 最多20个字符", () => {
    const apply = createProgram().commands.find((command) => command.name() === "apply");
    const menu = apply?.commands.find((command) => command.name() === "menu");
    let help = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      help += String(chunk);
      return true;
    });

    menu?.outputHelp();

    output.mockRestore();
    expect(help).toContain("最多20个字符");
  });

  it("apply menu 接受恰好20个字符的 code 并继续预览", async () => {
    const code = "ABCDEFGHIJKLMNOPQRST";
    let sourceRequests = 0;
    const { store } = await fixture({
      source: (request, response) => {
        sourceRequests += 1;
        expect(pathOf(request)).toBe("/api-gateway/sei-basic/menu/getMenuTree");
        respond(response, []);
      },
      target: (_request, response) => respond(response, [])
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "--compact", "apply", "menu", "--env", "source", "--name", "边界菜单", "--code", code
    ], { from: "user" });

    expect(sourceRequests).toBe(1);
    expect(JSON.parse(output.text())).toMatchObject({
      action: "create",
      desired: { code },
      applied: false
    });
  });

  it("apply menu 拒绝21个字符的 code 且不发起远端请求", async () => {
    const code = "ABCDEFGHIJKLMNOPQRSTU";
    let remoteRequests = 0;
    const { store } = await fixture({
      source: (_request, response) => {
        remoteRequests += 1;
        respond(response, []);
      },
      target: (_request, response) => {
        remoteRequests += 1;
        respond(response, []);
      }
    });

    await expect(createProgram(store).parseAsync([
      "--compact", "apply", "menu", "--env", "source", "--name", "超长菜单", "--code", code, "--apply"
    ], { from: "user" })).rejects.toThrow("菜单 code 最多20个字符");
    expect(remoteRequests).toBe(0);
  });

  it("apply menu 按 code 解析依赖，新增后产生 operationId 并可直接回滚", async () => {
    const root = { id: "root-id", code: "PURCHASE", name: "采购管理", rank: 0, children: [] as unknown[] };
    let created: Record<string, unknown> | null = null;
    let saveBody: Record<string, unknown> | undefined;
    const { store } = await fixture({
      source: async (request, response) => {
        const path = pathOf(request);
        if (path.endsWith("/menu/getMenuTree")) {
          respond(response, [{ ...root, children: created ? [created] : [] }]);
          return;
        }
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: [{ id: "feature-target-id", code: "PURCHASE_APPLY" }], total: 1 });
          return;
        }
        if (path.endsWith("/menu/save")) {
          saveBody = await bodyOf(request) as Record<string, unknown>;
          created = {
            ...saveBody,
            id: "menu-new-id",
            code: saveBody.code,
            featureCode: "PURCHASE_APPLY",
            children: []
          };
          respond(response, created);
          return;
        }
        if (path.endsWith("/menu/findOne")) {
          respond(response, created);
          return;
        }
        if (path.endsWith("/menu/delete/menu-new-id")) {
          created = null;
          respond(response, true);
          return;
        }
        respond(response, undefined, 404);
      },
      target: (_request, response) => respond(response, [])
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "--compact", "apply", "menu", "--env", "source",
      "--name", "采购申请", "--code", "PURCHASE_APPLY",
      "--parent-code", "PURCHASE", "--feature-code", "PURCHASE_APPLY",
      "--rank", "10", "--apply"
    ], { from: "user" });

    const applied = JSON.parse(output.text()) as Record<string, any>;
    expect(applied).toMatchObject({ applied: true, action: "create", verified: true });
    expect(saveBody).toMatchObject({
      code: "PURCHASE_APPLY",
      name: "采购申请",
      parentId: "root-id",
      featureId: "feature-target-id",
      rank: 10
    });
    expect(applied.operationId).toEqual(expect.any(String));
    const record = await new OperationLogStore(store.directory).load(applied.operationId);
    expect(record.actions).toHaveLength(1);
    expect(record.actions[0]).toMatchObject({ resource: "menu", entityId: "menu-new-id" });

    output.clear();
    await createProgram(store).parseAsync(
      ["--compact", "rollback", applied.operationId, "--env", "source"],
      { from: "user" }
    );
    expect(JSON.parse(output.text())).toMatchObject({
      operationId: applied.operationId,
      status: "rolled-back",
      rolledBack: 1,
      verified: true
    });
    expect(created).toBeNull();
  });

  it("sync menu 按父先子后新增，并重新映射 parentId 和 featureId", async () => {
    const targetRoots: Array<Record<string, any>> = [];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await fixture({
      source: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) {
          respond(response, [{
            id: "source-root-id", code: "PURCHASE", name: "采购管理", rank: 0, children: [{
              id: "source-child-id", code: "PURCHASE_APPLY", name: "采购申请", rank: 1,
              parentId: "source-root-id", featureId: "source-feature-id",
              featureCode: "PURCHASE_APPLY", children: []
            }]
          }]);
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = pathOf(request);
        if (path.endsWith("/menu/getMenuTree")) {
          respond(response, targetRoots);
          return;
        }
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: [{ id: "target-feature-id", code: "PURCHASE_APPLY" }], total: 1 });
          return;
        }
        if (path.endsWith("/menu/save")) {
          const body = await bodyOf(request) as Record<string, any>;
          savedBodies.push(body);
          const saved = {
            ...body,
            id: `target-${body.code}`,
            ...(body.featureId ? { featureCode: "PURCHASE_APPLY" } : {}),
            children: []
          };
          if (body.parentId) {
            targetRoots[0]!.children.push(saved);
          } else {
            targetRoots.push(saved);
          }
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync([
      "--compact", "sync", "menu", "--source", "source", "--target", "target",
      "--code", "PURCHASE", "--apply"
    ], { from: "user" });

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 2, update: 0, unchanged: 0, blocked: 0 });
    expect(result).toMatchObject({ applied: true, verified: true });
    expect(savedBodies[0]).toMatchObject({ code: "PURCHASE", name: "采购管理" });
    expect(savedBodies[0]).not.toHaveProperty("id");
    expect(savedBodies[1]).toMatchObject({
      code: "PURCHASE_APPLY",
      parentId: "target-PURCHASE",
      featureId: "target-feature-id"
    });
    expect(savedBodies[1]).not.toMatchObject({ parentId: "source-root-id", featureId: "source-feature-id" });
    const record = await new OperationLogStore(store.directory).load(result.operationId);
    expect(record.actions.map((action) => action.entityId)).toEqual([
      "target-PURCHASE", "target-PURCHASE_APPLY"
    ]);
  });

  it("sync menu 完成全量预览并将缺失功能项的菜单标记为 blocked", async () => {
    const { store } = await fixture({
      source: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) {
          respond(response, [
            { id: "safe", code: "SAFE", name: "安全菜单", rank: 0, children: [] },
            { id: "blocked", code: "BLOCKED", name: "阻断菜单", rank: 1,
              featureId: "source-feature", featureCode: "MISSING_FEATURE", children: [] }
          ]);
          return;
        }
        respond(response, undefined, 404);
      },
      target: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) respond(response, []);
        else if (pathOf(request).endsWith("/feature/findByPage")) respond(response, { rows: [], total: 0 });
        else respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["--compact", "sync", "menu", "--source", "source", "--target", "target"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(result.applied).toBe(false);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "SAFE", action: "create" }),
      expect.objectContaining({
        key: "BLOCKED",
        action: "blocked",
        missingDependencies: [{ resource: "feature", identityField: "code", value: "MISSING_FEATURE", reason: "missing" }]
      })
    ]));
  });

  it("sync menu 发现参与同步的菜单 code 超长时失败且不写入目标", async () => {
    const overlongCode = "ABCDEFGHIJKLMNOPQRSTU";
    let targetSaveRequests = 0;
    const { store } = await fixture({
      source: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) {
          respond(response, [{
            id: "source-root-id",
            code: "SAFE",
            name: "安全菜单",
            rank: 0,
            children: [{ id: "source-child-id", code: overlongCode, name: "超长菜单", rank: 1, children: [] }]
          }]);
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = pathOf(request);
        if (path.endsWith("/menu/getMenuTree")) {
          respond(response, []);
          return;
        }
        if (path.endsWith("/menu/save")) {
          targetSaveRequests += 1;
          respond(response, { id: "unexpected" });
          return;
        }
        respond(response, undefined, 404);
      }
    });

    await expect(createProgram(store).parseAsync([
      "--compact", "sync", "menu", "--source", "source", "--target", "target", "--apply"
    ], { from: "user" })).rejects.toThrow("菜单 code 最多20个字符");
    expect(targetSaveRequests).toBe(0);
  });

  it("sync menu 更新字段并换父节点时先按原 parentId 保存，再调用 move", async () => {
    const targetA: Record<string, any> = {
      id: "target-a", code: "A", name: "菜单A", rank: 0, children: [{
        id: "target-child", code: "CHILD", name: "旧名称", rank: 0,
        parentId: "target-a", children: []
      }]
    };
    const targetB: Record<string, any> = { id: "target-b", code: "B", name: "菜单B", rank: 1, children: [] };
    let saveParentId: unknown;
    let moveBody: Record<string, unknown> | undefined;
    const { store } = await fixture({
      source: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) {
          respond(response, [
            { id: "source-a", code: "A", name: "菜单A", rank: 0, children: [] },
            { id: "source-b", code: "B", name: "菜单B", rank: 1, children: [{
              id: "source-child", code: "CHILD", name: "新名称", rank: 0,
              parentId: "source-b", children: []
            }] }
          ]);
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = pathOf(request);
        if (path.endsWith("/menu/getMenuTree")) {
          respond(response, [targetA, targetB]);
          return;
        }
        if (path.endsWith("/menu/save")) {
          const body = await bodyOf(request) as Record<string, any>;
          saveParentId = body.parentId;
          Object.assign(targetA.children[0], body);
          respond(response, targetA.children[0]);
          return;
        }
        if (path.endsWith("/menu/move")) {
          moveBody = await bodyOf(request) as Record<string, unknown>;
          const child = targetA.children.shift();
          child.parentId = "target-b";
          targetB.children.push(child);
          respond(response, "移动成功");
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["--compact", "sync", "menu", "--source", "source", "--target", "target", "--apply"],
      { from: "user" }
    );

    expect(saveParentId).toBe("target-a");
    expect(moveBody).toEqual({ nodeId: "target-child", targetId: "target-b", moveType: "ACROSS_LEVEL" });
    expect(JSON.parse(output.text())).toMatchObject({
      summary: { create: 0, update: 1, unchanged: 2, blocked: 0 },
      verified: true
    });
  });

  it("sync menu 通过 TreeNodeMoveParam 将已有菜单移动到根节点", async () => {
    const child: Record<string, any> = {
      id: "target-child", code: "CHILD", name: "子菜单", rank: 0,
      parentId: "target-parent", children: []
    };
    const parent: Record<string, any> = {
      id: "target-parent", code: "PARENT", name: "父菜单", rank: 0, children: [child]
    };
    let moveBody: Record<string, unknown> | undefined;
    const { store } = await fixture({
      source: (request, response) => {
        if (pathOf(request).endsWith("/menu/getMenuTree")) {
          respond(response, [
            { id: "source-parent", code: "PARENT", name: "父菜单", rank: 0, children: [] },
            { id: "source-child", code: "CHILD", name: "子菜单", rank: 0, children: [] }
          ]);
        } else respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = pathOf(request);
        if (path.endsWith("/menu/getMenuTree")) {
          respond(response, [parent, ...(parent.children.length ? [] : [child])]);
          return;
        }
        if (path.endsWith("/menu/move")) {
          moveBody = await bodyOf(request) as Record<string, unknown>;
          parent.children = [];
          child.parentId = null;
          respond(response, "移动成功");
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["--compact", "sync", "menu", "--source", "source", "--target", "target", "--apply"],
      { from: "user" }
    );

    expect(moveBody).toEqual({ nodeId: "target-child", targetId: "", moveType: "ACROSS_LEVEL" });
    expect(JSON.parse(output.text())).toMatchObject({
      summary: { create: 0, update: 1, unchanged: 1, blocked: 0 },
      verified: true
    });
  });
});

async function fixture(handlers: Record<"source" | "target", (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>): Promise<{ store: ConfigStore }> {
  const urls: Record<string, string> = {};
  for (const name of ["source", "target"] as const) {
    const server = createServer((request, response) => void handlers[name](request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    urls[name] = `http://127.0.0.1:${address.port}`;
  }
  const directory = await mkdtemp(join(tmpdir(), "eadp-menu-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: "source",
    environments: {
      source: { baseUrl: urls.source!, token: "source-token", tenantCode: "global" },
      target: { baseUrl: urls.target!, token: "target-token", tenantCode: "global" }
    }
  });
  return { store };
}

function pathOf(request: IncomingMessage): string { return new URL(request.url ?? "/", "http://localhost").pathname; }
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ success: status >= 200 && status < 300, message: status >= 400 ? "not found" : "ok", data }));
}
function captureOutput(): { text(): string; clear(): void } {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
  return { text: () => output, clear: () => { output = ""; } };
}
function parseNdjson(value: string): Array<Record<string, any>> {
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
