/**
 * rollback / operation log 必测矩阵：
 * - 操作记录格式、并发保存、坏 JSON、过期清理（保留 1 天）
 * - 逆序回滚（先移除关系再删除实体）；删除后回查确认不存在
 * - 契约显式 lookup/remove 语义；给号 POST delete/{id}
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPERATION_RETENTION_MS,
  OperationLogStore,
  type OperationRecord
} from "../src/operations/store.js";
import {
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError,
  trackDirectory
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eadp-operation-log-"));
  trackDirectory(directory);
  return directory;
}

function record(id: string, createdAt: string, extra: Partial<OperationRecord> = {}): OperationRecord {
  return {
    version: 1,
    id,
    command: "eadp permission assign feature",
    environment: "dev",
    createdAt,
    updatedAt: createdAt,
    status: "completed",
    actions: [],
    ...extra
  };
}

describe("OperationLogStore：记录格式与保存", () => {
  it("按 createdAt 的 UTC 日期聚合，同 id 返回最新快照", async () => {
    const directory = await makeDirectory();
    const store = new OperationLogStore(directory);
    const first = record("same-day", "2026-08-11T01:00:00.000Z");
    const latest = { ...first, updatedAt: "2026-08-11T02:00:00.000Z", status: "partial" as const };

    await store.save(first);
    await store.save(latest);

    await expect(readdir(join(directory, "operations"))).resolves.toEqual(["2026-08-11.jsonl"]);
    await expect(store.load(first.id)).resolves.toMatchObject({
      status: "partial",
      updatedAt: latest.updatedAt
    });
  });

  it("跨日快照写入不同聚合文件", async () => {
    const directory = await makeDirectory();
    const store = new OperationLogStore(directory);
    await store.save(record("day-one", "2026-08-10T23:59:59.000Z"));
    await store.save(record("day-two", "2026-08-11T00:00:00.000Z"));
    await expect(readdir(join(directory, "operations")))
      .resolves.toEqual(["2026-08-10.jsonl", "2026-08-11.jsonl"]);
  });

  it("并发保存同日操作时不丢失记录", async () => {
    const directory = await makeDirectory();
    const store = new OperationLogStore(directory);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.save(record(`parallel-${index}`, "2026-08-11T00:00:00.000Z"))
    ));
    const lines = (await readFile(join(directory, "operations", "2026-08-11.jsonl"), "utf8"))
      .trim().split("\n");
    expect(lines).toHaveLength(20);
    await expect(store.load("parallel-19")).resolves.toMatchObject({ id: "parallel-19" });
  });

  it("拒绝非法 operation-id，并使用 1 天保留期", async () => {
    const store = new OperationLogStore(await makeDirectory());
    expect(OPERATION_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    await expect(store.load("../escape")).rejects.toThrow("operation-id 格式无效");
    await expect(store.save(record("bad/id", "2026-08-11T00:00:00.000Z")))
      .rejects.toThrow("operation-id 格式无效");
  });

  it("动作格式校验：create-entity 需要合法服务/资源与回滚语义", async () => {
    const store = new OperationLogStore(await makeDirectory());
    const custom = record("custom-service", "2026-08-11T00:00:00.000Z");
    custom.actions.push({
      id: "create-warehouse",
      type: "create-entity",
      service: "sei-inventory",
      resource: "warehouse",
      status: "applied",
      entityId: "warehouse-1",
      expected: { code: "W1" },
      deleteMethod: "DELETE",
      tenantPolicy: "global"
    });
    await expect(store.save(custom)).resolves.toBeUndefined();
    custom.actions[0]!.service = "../unsafe";
    await expect(store.save(custom)).rejects.toThrow("服务或资源无效");
  });
});

describe("OperationLogStore：清理", () => {
  it("按精确 24 小时清理，不误删保留记录", async () => {
    const directory = await makeDirectory();
    const store = new OperationLogStore(directory);
    const now = new Date("2026-08-12T12:00:00.000Z");
    await store.save(record("expired", "2026-08-11T11:59:59.999Z"));
    await store.save(record("exact", "2026-08-11T12:00:00.000Z"));
    await store.save(record("recent", "2026-08-11T12:00:00.001Z"));

    await store.cleanup(now);

    await expect(store.load("expired")).rejects.toThrow("不存在或已过期");
    await expect(store.load("exact")).rejects.toThrow("不存在或已过期");
    await expect(store.load("recent")).resolves.toMatchObject({ id: "recent" });
  });

  it("忽略旧 JSON 且清理不读取或修改旧 JSON", async () => {
    const directory = await makeDirectory();
    const operationsDirectory = join(directory, "operations");
    await mkdir(operationsDirectory, { recursive: true });
    const recent = record("legacy-recent", "2026-08-12T11:00:00.000Z");
    const expired = record("legacy-expired", "2026-08-11T11:00:00.000Z");
    const recentPath = join(operationsDirectory, `${recent.id}.json`);
    const expiredPath = join(operationsDirectory, `${expired.id}.json`);
    const corruptPath = join(operationsDirectory, "legacy-corrupt.json");
    const recentContents = `${JSON.stringify(recent)}\n`;
    const expiredContents = `${JSON.stringify(expired)}\n`;
    const corruptContents = "{not-json}\n";
    await writeFile(recentPath, recentContents, "utf8");
    await writeFile(expiredPath, expiredContents, "utf8");
    await writeFile(corruptPath, corruptContents, "utf8");
    const store = new OperationLogStore(directory);

    await expect(store.load(recent.id)).rejects.toThrow("不存在或已过期");
    await store.cleanup(new Date("2026-08-12T12:00:00.000Z"));
    await expect(readdir(operationsDirectory).then((names) => names.sort())).resolves.toEqual([
      "legacy-corrupt.json",
      `${expired.id}.json`,
      `${recent.id}.json`
    ]);
    await expect(readFile(recentPath, "utf8")).resolves.toBe(recentContents);
    await expect(readFile(corruptPath, "utf8")).resolves.toBe(corruptContents);
  });

  it("坏 JSONL 行不会导致清理误删其他有效记录", async () => {
    const directory = await makeDirectory();
    const operationsDirectory = join(directory, "operations");
    await mkdir(operationsDirectory, { recursive: true });
    const expired = record("line-expired", "2026-08-11T11:00:00.000Z");
    const recent = record("line-recent", "2026-08-11T12:00:00.001Z");
    const path = join(operationsDirectory, "2026-08-11.jsonl");
    await writeFile(path, ["{not-json}", JSON.stringify(expired), JSON.stringify(recent)].join("\n") + "\n", "utf8");
    const store = new OperationLogStore(directory);

    await store.cleanup(new Date("2026-08-12T12:00:00.000Z"));

    await expect(store.load(recent.id)).resolves.toMatchObject({ id: recent.id });
    await expect(store.load(expired.id)).rejects.toThrow("不存在或已过期");
    await expect(readFile(path, "utf8")).resolves.toContain("{not-json}");
  });

  it("目标快照格式损坏时报格式无效", async () => {
    const directory = await makeDirectory();
    const operationsDirectory = join(directory, "operations");
    await mkdir(operationsDirectory, { recursive: true });
    await writeFile(join(operationsDirectory, "2026-08-11.jsonl"), JSON.stringify({
      version: 1,
      id: "broken",
      command: "test",
      environment: "dev",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      status: "completed",
      actions: [{ invalid: true }]
    }) + "\n", "utf8");
    const store = new OperationLogStore(directory);
    await expect(store.load("broken")).rejects.toThrow("格式无效");
    await expect(store.load("missing")).rejects.toThrow("不存在或已过期");
  });
});

describe("rollback：逆序回滚与回查", () => {
  async function rollbackFixture(recordToSave: OperationRecord): Promise<Awaited<ReturnType<typeof createFixture>>> {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    await new OperationLogStore(fixture.store.directory).save(recordToSave);
    return fixture;
  }

  it("使用契约显式 lookup/remove 语义：POST detail → POST remove → 回查", async () => {
    let exists = true;
    const requests: string[] = [];
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    fixture.server("dev").onEndsWith("/warehouse/detail", (context) => {
      requests.push(`${context.method} ${context.path}`);
      expect((context.body as { warehouseId?: string }).warehouseId).toBe("warehouse-1");
      context.json(exists ? { id: "warehouse-1", code: "W1" } : null);
    });
    fixture.server("dev").onEndsWith("/warehouse/remove", (context) => {
      requests.push(`${context.method} ${context.path}?${context.search}`);
      expect(context.query.get("warehouseId")).toBe("warehouse-1");
      exists = false;
      context.json(true);
    });
    await new OperationLogStore(fixture.store.directory).save(record("contract-operation", new Date().toISOString(), {
      command: "eadp resource write warehouse",
      actions: [{
        id: "warehouse-create",
        type: "create-entity",
        service: "sei-inventory",
        resource: "warehouse",
        entityId: "warehouse-1",
        expected: { code: "W1" },
        deleteMethod: "POST",
        lookup: { path: "warehouse/detail", method: "POST", idField: "warehouseId", idPlacement: "body" },
        remove: { path: "warehouse/remove", method: "POST", idField: "warehouseId", idPlacement: "query" },
        tenantPolicy: "any",
        status: "applied"
      }]
    }));

    await runCommand(fixture.program(), ["rollback", "contract-operation", "--env", "dev"]);

    expect(exists).toBe(false);
    expect(requests).toEqual([
      "POST /api-gateway/sei-inventory/warehouse/detail",
      "POST /api-gateway/sei-inventory/warehouse/remove?warehouseId=warehouse-1",
      "POST /api-gateway/sei-inventory/warehouse/detail"
    ]);
  });

  it("逆序回滚：先移除分配关系，再删除新增角色，并回查确认删除", async () => {
    const role = { id: "role-1", code: "TEST_ROLE", name: "测试角色" };
    const assigned = new Set(["feature-1"]);
    const methods: string[] = [];
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    fixture.server("dev").onEndsWith("/featureRoleFeature/getChildrenFromParentId", (context) => {
      context.json([...assigned].map((id) => ({ id })));
    });
    fixture.server("dev").onEndsWith("/featureRoleFeature/removeRelations", (context) => {
      methods.push("removeRelations");
      const body = context.body as { childIds: string[] };
      body.childIds.forEach((id) => assigned.delete(id));
      context.json(true);
    });
    fixture.server("dev").onEndsWith("/featureRole/findOne", (context) => {
      context.json(role.id ? role : null);
    });
    fixture.server("dev").on(/\/featureRole\/delete\/[^/]+$/, (context) => {
      methods.push("delete");
      role.id = "";
      context.json(true);
    });
    await new OperationLogStore(fixture.store.directory).save(record("operation-1", new Date().toISOString(), {
      command: "eadp permission apply functional-role && eadp permission assign feature",
      actions: [
        {
          id: "action-create", type: "create-entity", service: "sei-basic", resource: "featureRole",
          entityId: "role-1", expected: { code: "TEST_ROLE", name: "测试角色" },
          deleteMethod: "DELETE", status: "applied"
        },
        {
          id: "action-assign", type: "assign-relations", service: "sei-basic",
          resource: "featureRoleFeature", parentId: "role-1", childIds: ["feature-1"], status: "applied"
        }
      ]
    }));

    await runCommand(fixture.program(), ["rollback", "operation-1", "--env", "dev"]);

    // 逆序：先关系后实体
    expect(methods).toEqual(["removeRelations", "delete"]);
    expect(assigned.size).toBe(0);
    expect(role.id).toBe("");
    await expect(new OperationLogStore(fixture.store.directory).load("operation-1"))
      .resolves.toMatchObject({ status: "rolled-back" });
  });

  it("给号新增使用 Controller 约定的 POST delete/{id} 回滚", async () => {
    let config: Record<string, unknown> | null = {
      id: "serial-1", entityClassName: "com.example.Order", configType: "CODE_TYPE"
    };
    const methods: string[] = [];
    const fixture = await createFixture({
      environments: [{ name: "global", tenantCode: "global", token: "secret" }]
    });
    fixture.server("global").onEndsWith("/serialNumberConfig/getDetail", (context) => {
      context.json(config);
    });
    fixture.server("global").on(/\/serialNumberConfig\/delete\/[^/]+$/, (context) => {
      methods.push(context.method);
      config = null;
      context.json(true);
    });
    await new OperationLogStore(fixture.store.directory).save(record("serial-operation", new Date().toISOString(), {
      environment: "global",
      command: "eadp resource sync serial-number",
      actions: [{
        id: "serial-create", type: "create-entity", service: "sei-basic", resource: "serialNumberConfig",
        entityId: "serial-1", expected: { entityClassName: "com.example.Order", configType: "CODE_TYPE" },
        deleteMethod: "POST", status: "applied"
      }]
    }));

    await runCommand(fixture.program(), ["rollback", "serial-operation"]);

    expect(config).toBeNull();
    expect(methods).toEqual(["POST"]);
  });

  it("删除接口返回成功但记录仍存在时回滚失败并标记 rollback-failed", async () => {
    let deleteCalls = 0;
    const fixture = await createFixture({
      environments: [{ name: "global", tenantCode: "global", token: "secret" }]
    });
    fixture.server("global").onEndsWith("/feature/findOne", (context) => {
      context.json({ id: "feature-1", code: "FEATURE_1" });
    });
    fixture.server("global").on(/\/feature\/delete\/[^/]+$/, (context) => {
      deleteCalls += 1;
      context.json(true);
    });
    await new OperationLogStore(fixture.store.directory).save(record("verify-delete-operation", new Date().toISOString(), {
      environment: "global",
      command: "eadp permission apply feature",
      actions: [{
        id: "create-feature", type: "create-entity", service: "sei-basic", resource: "feature",
        entityId: "feature-1", expected: { code: "FEATURE_1" }, deleteMethod: "DELETE", status: "applied"
      }]
    }));

    const error = await runExpectError(fixture.program(), ["rollback", "verify-delete-operation"]);
    expect(error).toContain("回滚后回查失败：feature/feature-1 仍然存在");
    expect(deleteCalls).toBe(1);
    await expect(new OperationLogStore(fixture.store.directory).load("verify-delete-operation"))
      .resolves.toMatchObject({ status: "rollback-failed" });
  });

  it("回滚已 rolled-back 的操作幂等，不发起远端请求", async () => {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    await new OperationLogStore(fixture.store.directory).save(record("already-rolled-back", new Date().toISOString(), {
      status: "rolled-back",
      completedAt: new Date().toISOString(),
      actions: [{
        id: "a1", type: "assign-relations", service: "sei-basic", resource: "employeePosition",
        parentId: "employee-1", childIds: ["position-1"], status: "rolled-back"
      }]
    }));
    const output = JSON.parse(await runCommand(fixture.program(), ["rollback", "already-rolled-back"])) as {
      status: string;
      rolledBack: number;
    };
    expect(output.status).toBe("rolled-back");
    expect(output.rolledBack).toBe(0);
    expect(fixture.server("dev").requests).toHaveLength(0);
  });

  it("批量回滚拒绝重复 operation-id 且零远端请求；环境不一致拒绝", async () => {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const error = await runExpectError(fixture.program(), ["rollback", "dup", "dup"]);
    expect(error).toContain("重复 operation-id");
    expect(fixture.server("dev").requests).toHaveLength(0);

    const store = new OperationLogStore(fixture.store.directory);
    await store.save(record("op-env-dev", new Date().toISOString(), { environment: "dev" }));
    await store.save(record("op-env-other", new Date().toISOString(), { environment: "other" }));
    const mixed = await runExpectError(fixture.program(), ["rollback", "op-env-dev", "op-env-other"]);
    expect(mixed).toContain("环境不一致");
    expect(fixture.server("dev").requests).toHaveLength(0);
  });

  it("回滚全局资源时先校验 tenantCode，非 global 环境零远端请求", async () => {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    await new OperationLogStore(fixture.store.directory).save(record("feature-operation", new Date().toISOString(), {
      command: "eadp permission apply feature",
      actions: [{
        id: "feature-create", type: "create-entity", service: "sei-basic", resource: "feature",
        entityId: "feature-1", expected: { code: "FEATURE" }, deleteMethod: "DELETE", status: "applied"
      }]
    }));
    const error = await runExpectError(fixture.program(), ["rollback", "feature-operation"]);
    expect(error).toContain("必须使用 global 租户");
    expect(fixture.server("dev").requests).toHaveLength(0);
  });
});
