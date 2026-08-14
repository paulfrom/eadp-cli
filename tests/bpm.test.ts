/**
 * BPM 必测矩阵：
 * - 从真实项目代码发现流程（BaseFlowController + Entity + API PATH + @Tag）
 * - Entity 全限定名匹配；回调区分 CUSTOM_PERSON / EVENT
 * - 目标 auditTypeId / auditTypeName 置空；跨环境幂等
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError,
  trackDirectory
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

type RecordValue = Record<string, unknown>;

interface BpmState {
  modules: RecordValue[];
  entities: RecordValue[];
  pages: RecordValue[];
  interfaces: RecordValue[];
  flowTypes: RecordValue[];
  pageRelations: Map<string, string[]>;
  interfaceRelations: Map<string, string[]>;
  sequence: number;
  saves: Array<{ resource: string; body: RecordValue }>;
}

function createBpmState(modules: RecordValue[] = [{
  id: "module-1", code: "sdh-tbs", name: "川发贸易", serviceName: "sdh-tbs", webBaseAddress: "sdh-tbs-web"
}]): BpmState {
  return {
    modules,
    entities: [],
    pages: [],
    interfaces: [],
    flowTypes: [],
    pageRelations: new Map(),
    interfaceRelations: new Map(),
    sequence: 1,
    saves: []
  };
}

const BPM_COLLECTIONS = [
  "conBusinessModule",
  "conBusinessEntity",
  "conPage",
  "conInterface",
  "conFlowType"
] as const;

function collectionOf(state: BpmState, resource: string): RecordValue[] {
  switch (resource) {
    case "conBusinessModule": return state.modules;
    case "conBusinessEntity": return state.entities;
    case "conPage": return state.pages;
    case "conInterface": return state.interfaces;
    case "conFlowType": return state.flowTypes;
    default: throw new Error(`未模拟资源：${resource}`);
  }
}

function registerBpmRoutes(server: MockEadpServer, state: BpmState): void {
  for (const resource of BPM_COLLECTIONS) {
    server.onEndsWith(`/${resource}/findByPage`, (context) => {
      context.json({ rows: collectionOf(state, resource) });
    });
    server.onEndsWith(`/${resource}/save`, (context) => {
      const body = context.body as RecordValue;
      state.saves.push({ resource, body });
      const existing = typeof body.id === "string"
        ? collectionOf(state, resource).find((item) => item.id === body.id)
        : undefined;
      if (existing) {
        Object.assign(existing, body);
        context.json(existing);
        return;
      }
      const item = { ...body, id: resource === "conBusinessEntity" ? "entity-1" : `${resource}-${state.sequence++}` };
      collectionOf(state, resource).push(item);
      context.json(item);
    });
  }
  server.onEndsWith("/conEntityPage/getChildrenFromParentId", (context) => {
    const parentId = context.query.get("parentId")!;
    const childIds = state.pageRelations.get(parentId) ?? [];
    context.json(state.pages.filter((page) => childIds.includes(page.id)));
  });
  server.onEndsWith("/conEntityInterface/getChildrenFromParentId", (context) => {
    const parentId = context.query.get("parentId")!;
    const childIds = state.interfaceRelations.get(parentId) ?? [];
    context.json(state.interfaces.filter((item) => childIds.includes(item.id)));
  });
  server.onEndsWith("/conEntityPage/insertRelations", (context) => {
    const body = context.body as { parentId: string; childIds: string[] };
    const existing = state.pageRelations.get(body.parentId) ?? [];
    state.pageRelations.set(body.parentId, [...new Set([...existing, ...body.childIds])]);
    context.json("ok");
  });
  server.onEndsWith("/conEntityInterface/insertRelations", (context) => {
    const body = context.body as { parentId: string; childIds: string[] };
    const existing = state.interfaceRelations.get(body.parentId) ?? [];
    state.interfaceRelations.set(body.parentId, [...new Set([...existing, ...body.childIds])]);
    context.json("ok");
  });
}

async function createBpmProject(options: { pageName?: string } = {}): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "eadp-bpm-project-"));
  trackDirectory(project);
  await mkdir(join(project, "backend"), { recursive: true });
  await mkdir(join(project, "frontend", "config"), { recursive: true });
  await writeFile(join(project, "backend", "settings.gradle"), "rootProject.name = 'sdh-tbs'\n", "utf8");
  const javaRoot = join(project, "backend", "src", "main", "java", "com", "sdh", "tbs", "project");
  await mkdir(join(javaRoot, "api"), { recursive: true });
  await mkdir(join(javaRoot, "entity"), { recursive: true });
  await mkdir(join(javaRoot, "controller"), { recursive: true });
  await writeFile(
    join(javaRoot, "api", "ProjectApi.java"),
    'package com.sdh.tbs.project.api; public interface ProjectApi { String PATH = "/project"; }',
    "utf8"
  );
  await writeFile(
    join(project, "frontend", "config", "router.config.ts"),
    `
const routes = [
  {
    path: "/project",
    routes: [
      {
        path: "apply",
        name: "projectApply",
        title: ${JSON.stringify(options.pageName ?? "项目申请工作台")},
        component: "./pages/project/apply"
      }
    ]
  },
  { path: "/other", name: "无关页面", component: "./pages/other" }
];
export default routes;
`,
    "utf8"
  );
  await writeFile(
    join(javaRoot, "entity", "Project.java"),
    "package com.sdh.tbs.project.entity; public class Project extends BaseFlowEntity {}",
    "utf8"
  );
  await writeFile(join(javaRoot, "controller", "ProjectController.java"), `
package com.sdh.tbs.project.controller;
import com.sdh.tbs.project.api.ProjectApi;
import com.sdh.tbs.project.entity.Project;
/** 项目申请流程 */
@Tag(name = "ProjectApi", description = "项目申请服务")
@RequestMapping(path = ProjectApi.PATH)
public class ProjectController extends BaseFlowController<Project, ProjectDto> {
  /** 项目申请提交前校验 */
  public ResultData<Void> beforeStartFlow(BpmInvokeParams params) {
    return service.validateBeforeStart(params.getBusinessId());
  }
  @Operation(summary = "项目申请流程结束后", description = "流程结束时同步项目")
  public ResultData<Void> afterEndFlow(BpmInvokeParams params) {
    service.createProject(params.getBusinessId());
    return ResultData.success();
  }
  // 项目负责人选人
  public ResultData<List<Executor>> getProjectLeaders(BpmInvokeParams params) {
    return service.getProjectLeaders(params.getBusinessId());
  }
  public ResultData<Void> internalSync(BpmInvokeParams params) {
    return service.internalSync(params.getBusinessId());
  }
}`, "utf8");
  return project;
}

/** 构造真实的采购流程源环境。 */
function purchaseSourceState(): BpmState {
  const state = createBpmState([{
    id: "source-module", code: "purchase", name: "采购", serviceName: "purchase-service",
    webBaseAddress: "purchase-web"
  }]);
  state.entities.push({
    id: "source-entity", name: "采购申请", code: "com.example.PurchaseRequest",
    businessModuleId: "source-module", serviceName: "/purchaseRequest",
    auditTypeId: "source-audit-type", auditTypeName: "采购审计"
  });
  state.pages.push({
    id: "source-page", name: "采购申请处理", pcUrl: "/purchase/request",
    businessModuleId: "source-module"
  });
  state.interfaces.push({
    id: "source-interface", name: "采购流程结束后", url: "/purchaseRequest/afterEndFlow",
    interfaceType: "EVENT", businessModuleId: "source-module"
  });
  state.flowTypes.push({
    id: "source-flow", name: "采购申请", code: "PURCHASE_REQUEST",
    businessEntityId: "source-entity", realtimeNodeStatus: false
  });
  state.pageRelations.set("source-entity", ["source-page"]);
  state.interfaceRelations.set("source-entity", ["source-interface"]);
  return state;
}

async function bpmSyncFixture(): Promise<{
  fixture: Awaited<ReturnType<typeof createFixture>>;
  source: BpmState;
  target: BpmState;
}> {
  const fixture = await createFixture({
    environments: [
      { name: "source", tenantCode: "tenant-a", token: "source-token" },
      { name: "target", tenantCode: "tenant-b", token: "target-token" }
    ]
  });
  const source = purchaseSourceState();
  const target = createBpmState();
  registerBpmRoutes(fixture.server("source"), source);
  registerBpmRoutes(fixture.server("target"), target);
  return { fixture, source, target };
}

describe("bpm inspect：从真实项目代码发现流程", () => {
  it("从项目代码发现流程：Entity 全限定名、回调区分 CUSTOM_PERSON/EVENT", async () => {
    const project = await createBpmProject();
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const result = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "inspect", "--project", project
    ])) as {
      businessModule: { code: string; name: string; serviceName: string };
      flows: Array<{
        name: string;
        code: string;
        entity: { code: string; serviceName: string };
        interfaces: Array<{ url: string; interfaceType: string; name: string }>;
        pages: Array<{ name: string; pcUrl: string }>;
      }>;
    };
    expect(result.businessModule).toEqual({ code: "sdh-tbs", name: "sdh-tbs", serviceName: "sdh-tbs" });
    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0]!;
    expect(flow.name).toBe("项目申请流程");
    expect(flow.code).toBe("com.sdh.tbs.project.entity.Project");
    expect(flow.entity.code).toBe("com.sdh.tbs.project.entity.Project");
    expect(flow.pages).toEqual([
      { name: "项目申请工作台", pcUrl: "/project/apply" }
    ]);
    // 回调区分：Executor 返回值 → CUSTOM_PERSON，其余 → EVENT
    expect(flow.interfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "project/beforeStartFlow", name: "项目申请提交前校验", interfaceType: "EVENT" }),
      expect.objectContaining({ url: "project/afterEndFlow", name: "项目申请流程结束后", interfaceType: "EVENT" }),
      expect.objectContaining({ url: "project/getProjectLeaders", name: "项目负责人选人", interfaceType: "CUSTOM_PERSON" })
    ]));
    expect(flow.interfaces).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "project/internalSync" })
    ]));
  });

  it("页面或接口名称超过 15 个 Unicode 字符时，预览和 apply 都在本地停止", async () => {
    const project = await createBpmProject({ pageName: "项目申请处理工作台首页超长页面名称" });
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const state = createBpmState();
    registerBpmRoutes(fixture.server("dev"), state);
    const args = [
      "bpm", "configure", "--project", project,
      "--flow", "com.sdh.tbs.project.entity.Project"
    ];

    const previewError = await runExpectError(fixture.program(), args);
    expect(previewError).toContain("15");
    expect(state.saves).toHaveLength(0);

    const applyError = await runExpectError(fixture.program(), [...args, "--apply"]);
    expect(applyError).toContain("15");
    expect(state.saves).toHaveLength(0);
  });

  it("Entity 全限定名匹配：--flow 只显示指定流程", async () => {
    const project = await createBpmProject();
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const result = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "inspect", "--project", project, "--flow", "com.sdh.tbs.project.entity.Project"
    ])) as { flows: unknown[] };
    expect(result.flows).toHaveLength(1);
  });

  it("没有 Controller 时按 Entity 全限定名单独发现流程骨架", async () => {
    const project = await mkdtemp(join(tmpdir(), "eadp-bpm-entity-only-"));
    trackDirectory(project);
    const file = join(project, "backend", "src", "main", "java", "com", "sdh", "tbs", "qualification", "entity", "Qualification.java");
    await mkdir(join(project, "backend", "src", "main", "java", "com", "sdh", "tbs", "qualification", "entity"), { recursive: true });
    await writeFile(join(project, "backend", "settings.gradle"), "rootProject.name = 'qualification'\n", "utf8");
    await writeFile(file, `
package com.sdh.tbs.qualification.entity;
/** 资质申请流程 */
public class Qualification extends BaseFlowEntity { }
`, "utf8");
    // bpm inspect 走项目路径发现；Entity 全限定名唯一定位由 discoverBpmProject 支持
    const { discoverBpmProject } = await import("../src/domains/bpm/discovery.js");
    const definition = await discoverBpmProject(
      project,
      "com.sdh.tbs.qualification.entity.Qualification"
    );
    expect(definition.flows).toEqual([{
      name: "资质申请流程",
      code: "com.sdh.tbs.qualification.entity.Qualification",
      entity: {
        name: "资质申请流程",
        code: "com.sdh.tbs.qualification.entity.Qualification",
        serviceName: "qualification"
      },
      interfaces: [],
      pages: []
    }]);
  });
});

describe("bpm configure：真实项目 + 六大场景", () => {
  it("场景1 预览：不访问任何写接口", async () => {
    const project = await createBpmProject();
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const state = createBpmState();
    registerBpmRoutes(fixture.server("dev"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "configure", "--project", project, "--flow", "com.sdh.tbs.project.entity.Project"
    ])) as { applied: boolean; businessModule: { action: string } };
    expect(output.applied).toBe(false);
    expect(output.businessModule.action).toBe("planned");
    expect(state.saves).toHaveLength(0);
    expect(state.entities).toHaveLength(0);
  });

  it("场景2+3+4 正式执行并回查；再次执行幂等复用", async () => {
    const project = await createBpmProject();
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const state = createBpmState();
    registerBpmRoutes(fixture.server("dev"), state);
    const args = [
      "bpm", "configure", "--project", project,
      "--flow", "com.sdh.tbs.project.entity.Project", "--apply"
    ];

    const applied = JSON.parse(await runCommand(fixture.program(), args)) as {
      applied: boolean;
      businessModule: { action: string };
      flows: Array<{ entity: { action: string }; flowType: { action: string }; verified: boolean }>;
    };
    expect(applied.applied).toBe(true);
    expect(applied.businessModule.action).toBe("reused");
    expect(applied.flows[0]!.entity.action).toBe("created");
    expect(applied.flows[0]!.flowType.action).toBe("created");
    expect(applied.flows[0]!.verified).toBe(true);
    // 回调登记类型：两个 EVENT 事件 + 一个 CUSTOM_PERSON 选人回调
    expect(state.interfaces.map((item) => item.interfaceType).sort()).toEqual(
      ["CUSTOM_PERSON", "EVENT", "EVENT"]
    );
    expect(state.entities).toHaveLength(1);
    expect(state.flowTypes).toHaveLength(1);
    expect(state.interfaceRelations.get("entity-1")).toEqual(
      state.interfaces.map((item) => item.id)
    );

    // 场景4 再次执行：全部复用，不重复写入
    const again = JSON.parse(await runCommand(fixture.program(), args)) as {
      flows: Array<{ entity: { action: string }; flowType: { action: string }; verified: boolean }>;
    };
    expect(again.flows[0]!.entity.action).toBe("reused");
    expect(again.flows[0]!.flowType.action).toBe("reused");
    expect(again.flows[0]!.verified).toBe(true);
    expect(state.entities).toHaveLength(1);
    expect(state.interfaces).toHaveLength(3);
    expect(state.flowTypes).toHaveLength(1);
  });

  it("场景5 租户错误：global 环境不能执行 BPM 配置（零请求）", async () => {
    const project = await createBpmProject();
    const fixture = await createFixture();
    const error = await runExpectError(fixture.program(), [
      "bpm", "configure", "--project", project, "--flow", "com.sdh.tbs.project.entity.Project"
    ]);
    expect(error).toContain("必须使用非 global 租户");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});

describe("resource sync bpm：跨环境迁移", () => {
  it("目标 auditTypeId/auditTypeName 置空、ID 重映射、按 URL 复用，且跨环境幂等", async () => {
    const { fixture, source, target } = await bpmSyncFixture();
    // 目标环境已有同 URL 页面/接口和旧审计对象
    target.entities.push({
      id: "target-entity", name: "采购申请", code: "com.example.PurchaseRequest",
      businessModuleId: "target-module", serviceName: "/purchaseRequest",
      auditTypeId: "target-old-audit", auditTypeName: "旧审计对象"
    });
    target.pages.push({ id: "target-page-by-url", name: "旧页面", pcUrl: "/purchase/request", businessModuleId: "another-module" });
    target.interfaces.push({ id: "target-interface-by-url", name: "旧接口", url: "/purchaseRequest/afterEndFlow", interfaceType: "CUSTOM_PERSON", businessModuleId: "another-module" });
    target.modules[0] = { id: "target-module", code: "purchase", name: "采购", serviceName: "purchase-service", webBaseAddress: "purchase-web" };

    const args = [
      "--compact", "resource", "sync", "bpm", "--source", "source", "--target", "target",
      "--flow", "采购申请", "--apply"
    ];
    const first = JSON.parse(await runCommand(fixture.program(), args)) as {
      kind: string;
      changeSetKind: string;
      resource: string;
      verified: boolean;
      missingDependencies: unknown[];
    };
    expect(first.kind).toBe("eadp.resource.change-set.v1");
    expect(first.changeSetKind).toBe("eadp.resource.change-set.v1");
    expect(first.resource).toBe("bpm");
    expect(first.verified).toBe(true);
    expect(first.missingDependencies).toEqual([]);

    // 目标实体：auditTypeId/auditTypeName 显式置空
    expect(target.entities).toHaveLength(1);
    expect(target.entities[0]).toMatchObject({ auditTypeId: null, auditTypeName: null });
    // 页面/接口按 URL 复用，不产生新记录
    expect(target.pages).toHaveLength(1);
    expect(target.interfaces).toHaveLength(1);
    // 流程类型关联重映射后的目标实体 ID
    expect(target.flowTypes).toHaveLength(1);
    expect(target.flowTypes[0]!.businessEntityId).toBe(target.entities[0]!.id);
    expect(target.flowTypes[0]!.businessEntityId).not.toBe("source-entity");
    // 关系按目标实体 ID 建立
    expect(target.pageRelations.get(target.entities[0]!.id)).toEqual([target.pages[0]!.id]);
    expect(target.interfaceRelations.get(target.entities[0]!.id)).toEqual([target.interfaces[0]!.id]);

    // 再次执行幂等
    const second = JSON.parse(await runCommand(fixture.program(), args)) as {
      summary: Record<string, number>;
      verified: boolean;
    };
    expect(second.verified).toBe(true);
    expect(second.summary.unchanged).toBeGreaterThan(0);
    expect(target.entities).toHaveLength(1);
    expect(target.flowTypes).toHaveLength(1);
  });

  it("规划阶段失败前不写入任何目标资源", async () => {
    const { fixture, source, target } = await bpmSyncFixture();
    delete source.flowTypes[0]!.name;
    const snapshot = {
      modules: target.modules.length,
      entities: target.entities.length,
      pages: target.pages.length,
      interfaces: target.interfaces.length,
      flowTypes: target.flowTypes.length
    };
    const error = await runExpectError(fixture.program(), [
      "resource", "sync", "bpm", "--source", "source", "--target", "target",
      "--flow", "PURCHASE_REQUEST", "--apply"
    ]);
    expect(error).toContain("源 BPM 流程类型缺少名称");
    expect(target.modules.length).toBe(snapshot.modules);
    expect(target.entities.length).toBe(snapshot.entities);
    expect(target.pages.length).toBe(snapshot.pages);
    expect(target.interfaces.length).toBe(snapshot.interfaces);
    expect(target.flowTypes.length).toBe(snapshot.flowTypes);
  });

  it("目标重复页面标记 blocked，安全资源照常应用", async () => {
    const { fixture, target } = await bpmSyncFixture();
    target.pages.push(
      { id: "duplicate-page-1", name: "重复页面一", pcUrl: "/purchase/request" },
      { id: "duplicate-page-2", name: "重复页面二", pcUrl: "/purchase/request" }
    );
    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "bpm", "--source", "source", "--target", "target",
      "--flow", "PURCHASE_REQUEST", "--apply"
    ])) as {
      summary: Record<string, number>;
      skippedBlocked: number;
      verified: boolean;
      changes: Array<Record<string, unknown>>;
      blockingIssues: Array<Record<string, unknown>>;
    };
    expect(output.summary).toMatchObject({ create: 4, blocked: 1, relationsAdded: 1 });
    expect(output.skippedBlocked).toBe(1);
    expect(output.verified).toBe(true);
    expect(output.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "conPage",
        key: "/purchase/request",
        action: "blocked",
        desired: null
      })
    ]));
    expect(output.blockingIssues[0]).toMatchObject({
      resource: "conPage", identityField: "pcUrl", value: "/purchase/request", reason: "ambiguous"
    });
    expect(target.pages).toHaveLength(2);
    expect(target.interfaces).toHaveLength(1);
    expect(target.flowTypes).toHaveLength(1);
  });

  it("源页面名称超过 15 个 Unicode 字符时标记 blocked，其他安全资源继续同步", async () => {
    const { fixture, source, target } = await bpmSyncFixture();
    source.pages[0]!.name = "采购申请处理工作台首页超长页面名称";
    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "bpm", "--source", "source", "--target", "target",
      "--flow", "PURCHASE_REQUEST", "--apply"
    ])) as {
      summary: Record<string, number>;
      skippedBlocked: number;
      changes: Array<Record<string, unknown>>;
    };
    expect(output.summary.blocked).toBe(1);
    expect(output.skippedBlocked).toBe(1);
    expect(output.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "conPage", action: "blocked", key: "/purchase/request" })
    ]));
    expect(target.pages).toHaveLength(0);
    expect(target.interfaces).toHaveLength(1);
    expect(target.flowTypes).toHaveLength(1);
  });
});
