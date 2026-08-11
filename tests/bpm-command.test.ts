import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { BpmClient } from "../src/bpm/client.js";
import { configureBpmProject } from "../src/bpm/configure.js";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
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

describe("apply bpm", () => {
  it("sync bpm 按流程代码迁移完整基础配置并映射目标关系 ID", async () => {
    const sourceState = createBpmServerState();
    sourceState.modules[0] = {
      id: "source-module",
      code: "purchase",
      name: "采购",
      serviceName: "purchase-service",
      webBaseAddress: "purchase-web"
    };
    sourceState.entities.push({
      id: "source-entity",
      name: "采购申请",
      code: "com.example.PurchaseRequest",
      businessModuleId: "source-module",
      serviceName: "/purchaseRequest",
      auditTypeId: "source-audit-type",
      auditTypeName: "采购审计"
    });
    sourceState.pages.push({
      id: "source-page",
      name: "采购申请处理",
      pcUrl: "/purchase/request",
      businessModuleId: "source-module"
    });
    sourceState.interfaces.push({
      id: "source-interface",
      name: "采购流程结束后",
      url: "/purchaseRequest/afterEndFlow",
      interfaceType: "EVENT",
      businessModuleId: "source-module"
    });
    sourceState.flowTypes.push({
      id: "source-flow",
      name: "采购申请",
      code: "PURCHASE_REQUEST",
      businessEntityId: "source-entity",
      realtimeNodeStatus: false
    });
    sourceState.pageRelations.set("source-entity", ["source-page"]);
    sourceState.interfaceRelations.set("source-entity", ["source-interface"]);

    const targetState = createBpmServerState();
    targetState.modules[0] = {
      id: "target-module",
      code: "purchase",
      name: "采购",
      serviceName: "purchase-service",
      webBaseAddress: "purchase-web"
    };
    targetState.entities.push({
      id: "target-entity",
      name: "采购申请",
      code: "com.example.PurchaseRequest",
      businessModuleId: "target-module",
      serviceName: "/purchaseRequest",
      auditTypeId: "target-old-audit",
      auditTypeName: "旧审计对象"
    });
    targetState.pages.push({
      id: "target-page-by-url",
      name: "旧页面",
      pcUrl: "/purchase/request",
      businessModuleId: "another-module"
    });
    targetState.interfaces.push({
      id: "target-interface-by-url",
      name: "旧接口",
      url: "/purchaseRequest/afterEndFlow",
      interfaceType: "CUSTOM_PERSON",
      businessModuleId: "another-module"
    });
    const urls = await startBpmServers({ source: sourceState, target: targetState });
    const directory = await mkdtemp(join(tmpdir(), "eadp-bpm-sync-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "source",
      environments: {
        source: { baseUrl: urls.source, token: "source-secret", tenantCode: "tenant-a" },
        target: { baseUrl: urls.target, token: "target-secret", tenantCode: "tenant-b" }
      }
    });
    const output = captureOutput();
    const args = [
      "--compact", "sync", "bpm", "--source", "source", "--target", "target",
      "--flow", "采购申请", "--apply"
    ];

    await createProgram(store).parseAsync(args, { from: "user" });
    await createProgram(store).parseAsync(args, { from: "user" });

    expect(targetState.modules).toHaveLength(1);
    expect(targetState.entities).toHaveLength(1);
    expect(targetState.entities[0]).toMatchObject({
      auditTypeId: null,
      auditTypeName: null
    });
    expect(targetState.pages).toHaveLength(1);
    expect(targetState.interfaces).toHaveLength(1);
    expect(targetState.flowTypes).toHaveLength(1);
    expect(targetState.flowTypes[0]!.businessEntityId).toBe(targetState.entities[0]!.id);
    expect(targetState.flowTypes[0]!.businessEntityId).not.toBe("source-entity");
    expect(targetState.pageRelations.get(targetState.entities[0]!.id)).toEqual([
      targetState.pages[0]!.id
    ]);
    expect(targetState.interfaceRelations.get(targetState.entities[0]!.id)).toEqual([
      targetState.interfaces[0]!.id
    ]);
    const results = output.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(results[0].kind).toBe("eadp.bpm.sync.v1");
    expect(results[0].verified).toBe(true);
    expect(results[1].summary.unchanged).toBeGreaterThan(0);
  });

  it("sync bpm 在主干规划失败前不写入任何目标资源", async () => {
    const sourceState = createPurchaseBpmSourceState();
    delete sourceState.flowTypes[0]!.name;
    const targetState = createBpmServerState();
    const before = snapshotBpmCounts(targetState);
    const urls = await startBpmServers({ source: sourceState, target: targetState });
    const store = await createBpmSyncStore(urls);

    await expect(
      createProgram(store).parseAsync(
        [
          "sync", "bpm", "--source", "source", "--target", "target",
          "--flow", "PURCHASE_REQUEST", "--apply"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("源 BPM 流程类型缺少名称");

    expect(snapshotBpmCounts(targetState)).toEqual(before);
  });

  it("sync bpm 将目标重复页面标记为 blocked 并应用其余安全资源", async () => {
    const sourceState = createPurchaseBpmSourceState();
    const targetState = createBpmServerState();
    targetState.pages.push(
      { id: "duplicate-page-1", name: "重复页面一", pcUrl: "/purchase/request" },
      { id: "duplicate-page-2", name: "重复页面二", pcUrl: "/purchase/request" }
    );
    const urls = await startBpmServers({ source: sourceState, target: targetState });
    const store = await createBpmSyncStore(urls);
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "--compact", "sync", "bpm", "--source", "source", "--target", "target",
        "--flow", "PURCHASE_REQUEST", "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toMatchObject({ create: 4, blocked: 1, relationsAdded: 1 });
    expect(result.skippedBlocked).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "conPage",
        key: "/purchase/request",
        action: "blocked",
        desired: null,
        blockingIssues: [expect.objectContaining({
          resource: "conPage",
          identityField: "pcUrl",
          value: "/purchase/request",
          reason: "ambiguous"
        })]
      })
    ]));
    expect(result.blockingIssues).toEqual([
      expect.objectContaining({
        resource: "conPage",
        identityField: "pcUrl",
        value: "/purchase/request",
        reason: "ambiguous"
      })
    ]);
    expect(targetState.pages).toHaveLength(2);
    expect(targetState.interfaces).toHaveLength(1);
    expect(targetState.flowTypes).toHaveLength(1);
  });

  it("在全新上下文中从项目代码完成幂等基础配置", async () => {
    const project = await createProjectFixture();
    const state = createBpmServerState();
    const server = createServer((request, response) =>
      handleBpmRequest(request, response, state)
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const configDirectory = await mkdtemp(join(tmpdir(), "eadp-bpm-config-"));
    temporaryDirectories.push(configDirectory);
    const store = new ConfigStore(configDirectory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "secret",
          tenantCode: "tenant-a"
        }
      }
    });

    const args = [
      "--compact",
      "apply",
      "bpm",
      "--project",
      project,
      "--flow",
      "com.sdh.tbs.project.entity.Project",
      "--apply"
    ];
    await createProgram(store).parseAsync(args, { from: "user" });
    await createProgram(store).parseAsync(args, { from: "user" });

    expect(state.entities).toHaveLength(1);
    expect(state.pages).toHaveLength(0);
    expect(state.interfaces).toHaveLength(2);
    expect(state.flowTypes).toHaveLength(1);
    expect(state.pageRelations.get("entity-1") ?? []).toHaveLength(0);
    expect(state.interfaceRelations.get("entity-1")).toHaveLength(2);
  });

  it("apply bpm 可按远端流程类型 code 定位本地 Entity", async () => {
    const project = await createProjectFixture();
    const state = createBpmServerState();
    state.entities.push({
      id: "entity-existing",
      name: "项目申请",
      code: "com.sdh.tbs.project.entity.Project",
      businessModuleId: "module-1",
      serviceName: "project"
    });
    state.flowTypes.push({
      id: "flow-existing",
      name: "项目审批",
      code: "PROJECT_APPROVAL",
      businessEntityId: "entity-existing"
    });
    const server = createServer((request, response) =>
      handleBpmRequest(request, response, state)
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const directory = await mkdtemp(join(tmpdir(), "eadp-bpm-remote-code-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "secret",
          tenantCode: "tenant-a"
        }
      }
    });

    await createProgram(store).parseAsync([
      "apply", "bpm", "--project", project, "--flow", "PROJECT_APPROVAL", "--apply"
    ], { from: "user" });

    expect(state.entities).toHaveLength(1);
    expect(state.flowTypes).toHaveLength(1);
    expect(state.flowTypes[0]).toMatchObject({
      code: "PROJECT_APPROVAL",
      businessEntityId: "entity-existing"
    });
  });

  it("流程页面和集成接口仅按 URL 复用并关联", async () => {
    const state = createBpmServerState();
    state.pages.push({
      id: "page-by-url",
      name: "已有页面",
      pcUrl: "/project/apply",
      businessModuleId: "another-module"
    });
    state.interfaces.push({
      id: "interface-by-url",
      name: "已有接口",
      url: "project/afterEndFlow",
      interfaceType: "CUSTOM_PERSON",
      businessModuleId: "another-module"
    });
    const server = createServer((request, response) =>
      handleBpmRequest(request, response, state)
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const client = new BpmClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret",
      timeoutMs: 5_000
    });

    await configureBpmProject({
      client,
      environment: "dev",
      apply: true,
      definition: {
        projectPath: "fixture",
        sourcePath: "fixture",
        businessModule: { code: "sdh-tbs", name: "川发贸易", serviceName: "sdh-tbs" },
        flows: []
      },
      flows: [{
        name: "项目申请",
        code: "com.sdh.tbs.project.entity.Project",
        entity: {
          name: "项目申请",
          code: "com.sdh.tbs.project.entity.Project",
          serviceName: "project"
        },
        pages: [{ name: "项目申请页面", pcUrl: "/project/apply" }],
        interfaces: [{
          name: "项目流程结束后",
          url: "project/afterEndFlow",
          interfaceType: "EVENT"
        }]
      }]
    });

    expect(state.pages).toHaveLength(1);
    expect(state.interfaces).toHaveLength(1);
    expect(state.pageRelations.get("entity-1")).toEqual(["page-by-url"]);
    expect(state.interfaceRelations.get("entity-1")).toEqual(["interface-by-url"]);
  });

  it("global 环境不能执行 BPM 配置", async () => {
    const project = await createProjectFixture();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: {} }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const configDirectory = await mkdtemp(join(tmpdir(), "eadp-bpm-config-"));
    temporaryDirectories.push(configDirectory);
    const store = new ConfigStore(configDirectory);
    await store.save({
      currentEnvironment: "global",
      environments: {
        global: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "secret",
          tenantCode: "global"
        }
      }
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "bpm",
          "--project",
          project,
          "--flow",
          "com.sdh.tbs.project.entity.Project"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用非 global 租户");
  });
});

interface StoredItem {
  id: string;
  [key: string]: unknown;
}

interface BpmServerState {
  modules: StoredItem[];
  entities: StoredItem[];
  pages: StoredItem[];
  interfaces: StoredItem[];
  flowTypes: StoredItem[];
  pageRelations: Map<string, string[]>;
  interfaceRelations: Map<string, string[]>;
  sequence: number;
}

function createBpmServerState(): BpmServerState {
  return {
    modules: [
      {
        id: "module-1",
        code: "sdh-tbs",
        name: "川发贸易",
        serviceName: "sdh-tbs",
        webBaseAddress: "sdh-tbs-web"
      }
    ],
    entities: [],
    pages: [],
    interfaces: [],
    flowTypes: [],
    pageRelations: new Map(),
    interfaceRelations: new Map(),
    sequence: 1
  };
}

function createPurchaseBpmSourceState(): BpmServerState {
  const state = createBpmServerState();
  state.modules = [{
    id: "source-module",
    code: "purchase",
    name: "采购",
    serviceName: "purchase-service",
    webBaseAddress: "purchase-web"
  }];
  state.entities.push({
    id: "source-entity",
    name: "采购申请",
    code: "com.example.PurchaseRequest",
    businessModuleId: "source-module",
    serviceName: "/purchaseRequest"
  });
  state.pages.push({
    id: "source-page",
    name: "采购申请处理",
    pcUrl: "/purchase/request",
    businessModuleId: "source-module"
  });
  state.interfaces.push({
    id: "source-interface",
    name: "采购流程结束后",
    url: "/purchaseRequest/afterEndFlow",
    interfaceType: "EVENT",
    businessModuleId: "source-module"
  });
  state.flowTypes.push({
    id: "source-flow",
    name: "采购申请",
    code: "PURCHASE_REQUEST",
    businessEntityId: "source-entity"
  });
  state.pageRelations.set("source-entity", ["source-page"]);
  state.interfaceRelations.set("source-entity", ["source-interface"]);
  return state;
}

function snapshotBpmCounts(state: BpmServerState): Record<string, number> {
  return {
    modules: state.modules.length,
    entities: state.entities.length,
    pages: state.pages.length,
    interfaces: state.interfaces.length,
    flowTypes: state.flowTypes.length,
    pageRelations: state.pageRelations.size,
    interfaceRelations: state.interfaceRelations.size
  };
}

async function createBpmSyncStore(
  urls: Record<"source" | "target", string>
): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), "eadp-bpm-sync-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(directory);
  await store.save({
    currentEnvironment: "source",
    environments: {
      source: { baseUrl: urls.source, token: "source-secret", tenantCode: "tenant-a" },
      target: { baseUrl: urls.target, token: "target-secret", tenantCode: "tenant-b" }
    }
  });
  return store;
}

async function handleBpmRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: BpmServerState
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const body = await readBody(request);
  const collections: Record<string, StoredItem[]> = {
    conBusinessModule: state.modules,
    conBusinessEntity: state.entities,
    conPage: state.pages,
    conInterface: state.interfaces,
    conFlowType: state.flowTypes
  };
  const resource = Object.keys(collections).find((name) => path.includes(`/${name}/`));
  if (resource && path.endsWith("/findByPage")) {
    respond(response, {
      success: true,
      data: { page: 1, records: collections[resource]!.length, rows: collections[resource] }
    });
    return;
  }
  if (resource && path.endsWith("/save")) {
    const input = body as Record<string, unknown>;
    const existing = typeof input.id === "string"
      ? collections[resource]!.find((item) => item.id === input.id)
      : undefined;
    if (existing) {
      Object.assign(existing, input);
      respond(response, { success: true, data: existing });
      return;
    }
    const item = { ...input, id: `${resource}-${state.sequence++}` };
    if (resource === "conBusinessEntity") {
      item.id = "entity-1";
    }
    collections[resource]!.push(item);
    respond(response, { success: true, data: item });
    return;
  }
  if (path.endsWith("/findByBusinessEntityId")) {
    const entityId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
      "businessEntityId"
    );
    respond(response, {
      success: true,
      data: state.flowTypes.filter((item) => item.businessEntityId === entityId)
    });
    return;
  }
  const relation = path.includes("/conEntityPage/")
    ? state.pageRelations
    : path.includes("/conEntityInterface/")
      ? state.interfaceRelations
      : undefined;
  if (relation && path.endsWith("/getChildrenFromParentId")) {
    const parentId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
      "parentId"
    )!;
    const source = path.includes("/conEntityPage/") ? state.pages : state.interfaces;
    const childIds = relation.get(parentId) ?? [];
    respond(response, {
      success: true,
      data: source.filter((item) => childIds.includes(item.id))
    });
    return;
  }
  if (relation && path.endsWith("/insertRelations")) {
    const input = body as { parentId: string; childIds: string[] };
    const existing = relation.get(input.parentId) ?? [];
    relation.set(input.parentId, [...new Set([...existing, ...input.childIds])]);
    respond(response, { success: true, data: "ok" });
    return;
  }
  respond(response, { success: false, message: `未模拟接口：${path}` }, 404);
}

async function startBpmServers(states: Record<"source" | "target", BpmServerState>): Promise<Record<"source" | "target", string>> {
  const urls = {} as Record<"source" | "target", string>;
  for (const name of ["source", "target"] as const) {
    const server = createServer((request, response) =>
      handleBpmRequest(request, response, states[name])
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    urls[name] = `http://127.0.0.1:${address.port}`;
  }
  return urls;
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

function respond(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function createProjectFixture(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "eadp-bpm-project-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, "backend"), { recursive: true });
  await writeFile(
    join(project, "backend", "settings.gradle"),
    "rootProject.name = 'sdh-tbs'\n",
    "utf8"
  );
  const javaRoot = join(project, "backend", "src", "main", "java", "com", "sdh", "tbs", "project");
  await mkdir(join(javaRoot, "api"), { recursive: true });
  await mkdir(join(javaRoot, "entity"), { recursive: true });
  await mkdir(join(javaRoot, "controller"), { recursive: true });
  await writeFile(join(javaRoot, "api", "ProjectApi.java"),
    'package com.sdh.tbs.project.api; public interface ProjectApi { String PATH = "/project"; }', "utf8");
  await writeFile(join(javaRoot, "entity", "Project.java"),
    'package com.sdh.tbs.project.entity; public class Project extends BaseFlowEntity {}', "utf8");
  await writeFile(join(javaRoot, "controller", "ProjectController.java"), `
package com.sdh.tbs.project.controller;
import com.sdh.tbs.project.api.ProjectApi;
import com.sdh.tbs.project.entity.Project;
@Tag(name = "ProjectApi", description = "项目申请服务")
@RequestMapping(path = ProjectApi.PATH)
public class ProjectController extends BaseFlowController<Project, ProjectDto> {
  public ResultData<Void> beforeStartFlow(BpmInvokeParams params) {
    return service.validateBeforeStart(params.getBusinessId());
  }
  public ResultData<Void> afterEndFlow(BpmInvokeParams params) {
    return service.afterEndFlow(params);
  }
}`, "utf8");
  return project;
}
