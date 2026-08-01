import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("ConfigStore", () => {
  it("持久化一个名称对应一个 URL 和 Token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-config-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);

    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: "http://10.232.2.126",
          tokenEnv: "EADP_DEV_ADMIN_TOKEN"
        },
        dev2: {
          baseUrl: "http://10.232.2.126",
          token: "readonly-secret"
        }
      }
    });

    const loaded = await store.load();
    expect(loaded.environments.dev?.tokenEnv).toBe("EADP_DEV_ADMIN_TOKEN");
    expect(loaded.environments.dev2?.token).toBe("readonly-secret");
    expect(await readFile(store.filePath, "utf8")).not.toContain("accounts:");
  });

  it("配置文件不存在时返回空配置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-config-"));
    temporaryDirectories.push(directory);

    await expect(new ConfigStore(directory).load()).resolves.toEqual({
      environments: {}
    });
  });

  it("自动把旧账号配置迁移为多个独立环境", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-config-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await writeFile(
      store.filePath,
      [
        "currentEnvironment: dev",
        "environments:",
        "  dev:",
        "    baseUrl: http://10.232.2.126",
        "    defaultAccount: admin",
        "    accounts:",
        "      admin:",
        "        token: admin-token",
        "      readonly:",
        "        token: readonly-token"
      ].join("\n"),
      "utf8"
    );

    const migrated = await store.load();

    expect(migrated.environments.dev?.token).toBe("admin-token");
    expect(migrated.environments["dev-readonly"]?.token).toBe("readonly-token");
    const persisted = await readFile(store.filePath, "utf8");
    expect(persisted).not.toContain("accounts:");
    expect(persisted).toContain("dev-readonly:");
  });
});
