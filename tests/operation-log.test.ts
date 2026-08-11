import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationLogStore, type OperationRecord } from "../src/operations/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("OperationLogStore", () => {
  it("保留30天内日志并清理已满30天的日志", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-operation-log-"));
    temporaryDirectories.push(directory);
    const store = new OperationLogStore(directory);
    const now = new Date("2026-08-11T12:00:00.000Z");
    await store.save(record("recent", "2026-07-13T12:00:00.001Z"));
    await store.save(record("expired", "2026-07-12T12:00:00.000Z"));

    await store.cleanup(now);

    await expect(store.load("recent")).resolves.toMatchObject({ id: "recent" });
    await expect(store.load("expired")).rejects.toThrow("不存在或已过期");
  });
});

function record(id: string, createdAt: string): OperationRecord {
  return {
    version: 1,
    id,
    command: "eadp assign feature",
    environment: "dev",
    createdAt,
    updatedAt: createdAt,
    status: "completed",
    actions: []
  };
}
