import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATION_RETENTION_MS, OperationLogStore, type OperationRecord } from "../src/operations/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("OperationLogStore", () => {
  it("按 createdAt 的 UTC 日期聚合同日快照，并返回同 id 的最新快照", async () => {
    const directory = await makeDirectory();
    const store = new OperationLogStore(directory);
    const first = record("same-day", "2026-08-11T01:00:00.000Z");
    const latest = { ...first, updatedAt: "2026-08-11T02:00:00.000Z", status: "partial" as const };

    await store.save(first);
    await store.save(latest);

    const operationsDirectory = join(directory, "operations");
    await expect(readdir(operationsDirectory)).resolves.toEqual(["2026-08-11.jsonl"]);
    await expect(readFile(join(operationsDirectory, "2026-08-11.jsonl"), "utf8"))
      .resolves.toContain(`${JSON.stringify(first)}\n${JSON.stringify(latest)}\n`);
    await expect(store.load(first.id)).resolves.toMatchObject({ status: "partial", updatedAt: latest.updatedAt });
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

  it("按精确 24 小时清理混合同日记录，不误删保留记录", async () => {
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
    await expect(readdir(join(directory, "operations"))).resolves.toEqual(["2026-08-11.jsonl"]);
  });

  it("忽略旧 JSON，且清理不读取或修改旧 JSON", async () => {
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
    await expect(store.load(expired.id)).rejects.toThrow("不存在或已过期");
    await store.cleanup(new Date("2026-08-12T12:00:00.000Z"));
    await expect(readdir(operationsDirectory).then((names) => names.sort())).resolves.toEqual([
      "legacy-corrupt.json",
      `${expired.id}.json`,
      `${recent.id}.json`
    ]);
    await expect(readFile(recentPath, "utf8")).resolves.toBe(recentContents);
    await expect(readFile(expiredPath, "utf8")).resolves.toBe(expiredContents);
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

  it("目标快照格式损坏时报格式无效，目标不存在保留原错误", async () => {
    const directory = await makeDirectory();
    const operationsDirectory = join(directory, "operations");
    await mkdir(operationsDirectory, { recursive: true });
    const path = join(operationsDirectory, "2026-08-11.jsonl");
    await writeFile(path, JSON.stringify({
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

  it("拒绝非法 operation-id，并使用 1 天保留期", async () => {
    const store = new OperationLogStore(await makeDirectory());
    expect(OPERATION_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    await expect(store.load("../escape")).rejects.toThrow("operation-id 格式无效");
    await expect(store.save(record("bad/id", "2026-08-11T00:00:00.000Z"))).rejects.toThrow("operation-id 格式无效");
  });

  it("accepts a syntactically safe registered-service create action", async () => {
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
    await expect(store.load(custom.id)).resolves.toMatchObject({
      actions: [{ service: "sei-inventory", resource: "warehouse", tenantPolicy: "global" }]
    });

    custom.actions[0]!.service = "../unsafe";
    await expect(store.save(custom)).rejects.toThrow("服务或资源无效");
  });
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eadp-operation-log-"));
  temporaryDirectories.push(directory);
  return directory;
}

function record(id: string, createdAt: string): OperationRecord {
  return {
    version: 1,
    id,
    command: "eadp permission assign feature",
    environment: "dev",
    createdAt,
    updatedAt: createdAt,
    status: "completed",
    actions: []
  };
}
