/**
 * 企业员工资源目标契约：Basic employee 路径、user 别名、组织代码映射、
 * 默认预览/正式写入回查、幂等和目标独有删除。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

interface EmployeeState {
  rows: Array<Record<string, unknown>>;
  organizations: Array<Record<string, unknown>>;
  saves: Array<Record<string, unknown>>;
}

function employeeState(
  rows: Array<Record<string, unknown>> = [],
  organizations: Array<Record<string, unknown>> = [{ id: "target-org", code: "ORG-001", name: "目标组织" }]
): EmployeeState {
  return { rows, organizations, saves: [] };
}

function createEmployeeFixture() {
  return createFixture({
    defaultAuthorityPolicy: "NormalUser",
    environments: [
      { name: "source", tenantCode: "tenant-a", token: "source-token" },
      { name: "target", tenantCode: "tenant-a", token: "target-token" }
    ]
  });
}

function registerEmployeeRoutes(server: MockEadpServer, state: EmployeeState): void {
  server.onEndsWith("/employee/findByPage", (context) => {
    context.json(eadpPage(state.rows, {
      records: state.rows.length,
      total: state.rows.length === 0 ? 0 : 1
    }));
  });
  server.onEndsWith("/organization/findByCode", (context) => {
    const code = context.query.get("code");
    context.json(state.organizations.find((organization) => organization.code === code) ?? null);
  });
  server.onEndsWith("/employee/findOne", (context) => {
    const id = context.query.get("id");
    context.json(state.rows.find((row) => String(row.id) === id) ?? null);
  });
  server.onRequest("DELETE", /\/employee\/delete\//, (context) => {
    const id = context.path.split("/").at(-1);
    const index = state.rows.findIndex((row) => String(row.id) === id);
    if (index >= 0) state.rows.splice(index, 1);
    context.json(true);
  });
  server.onEndsWith("/employee/save", (context) => {
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const index = state.rows.findIndex((row) => row.code === body.code);
    const saved = {
      ...body,
      id: index >= 0 ? state.rows[index]!.id : `employee-${state.saves.length}`
    };
    if (index >= 0) state.rows[index] = saved;
    else state.rows.push(saved);
    context.json(saved);
  });
}

describe("employee resource", () => {
  it("查询支持 user 别名并使用 employee/findByPage 分页契约", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState([{ id: "employee-1", code: "E001", userName: "员工一" }]);
    registerEmployeeRoutes(fixture.server("target"), state);

    const catalog = JSON.parse(await runCommand(fixture.program(), ["resource", "inspect"])) as {
      resources: Array<{ name: string; aliases: string[] }>;
    };
    expect(catalog.resources.find((resource) => resource.name === "employee")?.aliases).toEqual(["user"]);

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "user", "--env", "target"
    ])) as { resource: string; items: Array<Record<string, unknown>> };

    expect(output.resource).toBe("employee");
    expect(output.items).toEqual(state.rows);
    const request = fixture.server("target").requests.find((item) =>
      item.path.endsWith("/employee/findByPage")
    );
    expect(request?.path).toBe("/api-gateway/sei-basic/employee/findByPage");
    expect(request?.method).toBe("POST");
    expect(request?.body).toMatchObject({
      pageInfo: { page: 1, rows: 500 },
      filters: [],
      sortOrders: []
    });
  });

  it("新增/更新按目标组织 code 映射 ID，不发送 organizationCode 或源 organizationId，并保持幂等", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState();
    registerEmployeeRoutes(fixture.server("target"), state);
    const data = JSON.stringify({
      id: "source-employee",
      code: "E001",
      userName: "员工一",
      organizationCode: "ORG-001",
      organizationId: "source-org",
      email: "e001@example.com",
      frozen: false,
      gender: false
    });

    const preview = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "user", "--env", "target", "--data", data
    ])) as { applied: boolean };
    expect(preview.applied).toBe(false);
    expect(state.saves).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "employee", "--env", "target", "--data", data, "--apply"
    ])) as { applied: boolean; verified: boolean };
    expect(applied).toMatchObject({ applied: true, verified: true });
    expect(state.saves).toEqual([{
      code: "E001",
      userName: "员工一",
      organizationId: "target-org",
      frozen: false,
      gender: false,
      email: "e001@example.com"
    }]);
    expect(state.saves[0]).not.toHaveProperty("organizationCode");
    expect(state.saves[0]).not.toHaveProperty("id");
    expect(fixture.server("target").requests.some((request) =>
      request.path === "/api-gateway/sei-basic/organization/findByCode" && request.query.get("code") === "ORG-001"
    )).toBe(true);
    expect(fixture.server("target").requests.some((request) =>
      request.path === "/api-gateway/sei-basic/employee/save"
    )).toBe(true);

    const again = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "employee", "--env", "target", "--data", data, "--apply"
    ])) as { summary: Record<string, number> };
    expect(again.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(1);
  });

  it("组织依赖缺失时只阻塞对应 compare/sync 记录，预览不写入", async () => {
    const fixture = await createEmployeeFixture();
    const targetState = employeeState([], [{ id: "target-org", code: "ORG-001" }]);
    registerEmployeeRoutes(fixture.server("target"), targetState);
    registerEmployeeRoutes(fixture.server("source"), employeeState([
      { id: "source-safe", code: "SAFE", userName: "安全员工", organizationCode: "ORG-001", organizationId: "source-org-1" },
      { id: "source-blocked", code: "BLOCKED", userName: "阻塞员工", organizationCode: "ORG-MISSING", organizationId: "source-org-2" }
    ]));

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "user", "--source", "source", "--target", "target"
    ])) as {
      applied: boolean;
      summary: Record<string, number>;
      changes: Array<Record<string, unknown>>;
    };
    expect(output.applied).toBe(false);
    expect(output.summary).toEqual({ create: 1, update: 0, delete: 0, unchanged: 0, blocked: 1 });
    expect(output.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "safe",
        action: "create",
        desired: expect.objectContaining({ code: "SAFE", userName: "安全员工", organizationId: "target-org" })
      }),
      expect.objectContaining({
        key: "blocked",
        action: "blocked",
        missingDependencies: [{ resource: "organization", identityField: "code", value: "ORG-MISSING", reason: "missing" }]
      })
    ]));
    expect(targetState.saves).toHaveLength(0);
    expect(fixture.server("target").count("POST", /\/employee\/save$/)).toBe(0);
  });

  it("目标独有员工按显式删除契约预览、删除并回查", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState([{ id: "target-only", code: "OLD", userName: "旧员工", organizationId: "target-org" }]);
    registerEmployeeRoutes(fixture.server("target"), state);
    registerEmployeeRoutes(fixture.server("source"), employeeState([]));

    const preview = JSON.parse(await runCommand(fixture.program(), [
      "resource", "compare", "employee", "--source", "source", "--target", "target"
    ])) as { summary: Record<string, number> };
    expect(preview.summary).toEqual({ create: 0, update: 0, delete: 1, unchanged: 0, blocked: 0 });
    expect(fixture.server("target").count("DELETE", /\/employee\/delete\//)).toBe(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "user", "--source", "source", "--target", "target", "--apply"
    ])) as { applied: boolean; verified: boolean; summary: Record<string, number> };
    expect(applied).toMatchObject({ applied: true, verified: true });
    expect(applied.summary).toEqual({ create: 0, update: 0, delete: 1, unchanged: 0, blocked: 0 });
    expect(fixture.server("target").count("DELETE", /\/employee\/delete\//)).toBe(1);
    expect(fixture.server("target").requests.some((request) =>
      request.method === "DELETE" && request.path === "/api-gateway/sei-basic/employee/delete/target-only"
    )).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it("直接写入缺少 organizationCode 时在 apply 前失败且不调用保存", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState();
    registerEmployeeRoutes(fixture.server("target"), state);

    const error = await runExpectError(fixture.program(), [
      "resource", "write", "employee", "--env", "target", "--data",
      JSON.stringify({ code: "E001", userName: "员工一", organizationId: "source-org" }), "--apply"
    ]);
    expect(error).toContain("organizationCode");
    expect(state.saves).toHaveLength(0);
    expect(fixture.server("target").count("POST", /\/employee\/save$/)).toBe(0);
  });

  it("直接写入目标组织缺失时在 apply 前失败且不把记录静默标记为 blocked", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState([], []);
    registerEmployeeRoutes(fixture.server("target"), state);

    const error = await runExpectError(fixture.program(), [
      "resource", "write", "employee", "--env", "target", "--data",
      JSON.stringify({ code: "E001", userName: "员工一", organizationCode: "ORG-MISSING" }), "--apply"
    ]);
    expect(error).toContain("organization.code=ORG-MISSING (missing)");
    expect(state.saves).toHaveLength(0);
    expect(fixture.server("target").count("POST", /\/employee\/save$/)).toBe(0);
  });

  it("--count/--summary 只读第一页并输出总数，--fields/--limit 裁剪明细", async () => {
    const fixture = await createEmployeeFixture();
    const state = employeeState([
      { id: "e1", code: "E001", userName: "甲" },
      { id: "e2", code: "E002", userName: "乙" }
    ]);
    registerEmployeeRoutes(fixture.server("target"), state);

    const countOutput = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "employee", "--env", "target", "--count"
    ])) as { kind: string; resource: string; count: number };
    expect(countOutput.kind).toBe("eadp.resource.count.v1");
    expect(countOutput.resource).toBe("employee");
    expect(countOutput.count).toBe(2);

    const summaryOutput = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "employee", "--env", "target", "--summary"
    ])) as { kind: string; count: number; summaryInfo: unknown };
    expect(summaryOutput.kind).toBe("eadp.resource.summary.v1");
    expect(summaryOutput.count).toBe(2);
    expect(summaryOutput).toHaveProperty("summaryInfo");

    const trimmed = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "employee", "--env", "target",
      "--fields", "code,userName", "--limit", "1"
    ])) as { items: Array<Record<string, unknown>>; total: number };
    expect(trimmed.items).toEqual([{ code: "E001", userName: "甲" }]);
    expect(trimmed.total).toBe(2);
  });

  it("--count 在分页资源上只发起一次请求", async () => {
    const fixture = await createEmployeeFixture();
    let pageRequests = 0;
    fixture.server("target").onEndsWith("/employee/findByPage", (context) => {
      pageRequests += 1;
      context.json(eadpPage([{ id: "e1", code: "E001" }], {
        records: 1500,
        total: 3,
        summaryInfo: { byModule: { a: 900, b: 600 } }
      }));
    });

    const countOutput = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "employee", "--env", "target", "--count"
    ])) as { count: number };
    expect(countOutput.count).toBe(1500);
    expect(pageRequests).toBe(1);

    const summaryOutput = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "employee", "--env", "target", "--summary"
    ])) as { summaryInfo: { byModule: Record<string, number> } };
    expect(summaryOutput.summaryInfo).toEqual({ byModule: { a: 900, b: 600 } });
    expect(pageRequests).toBe(2);
  });
});
