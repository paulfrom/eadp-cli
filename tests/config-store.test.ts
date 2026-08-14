import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { trackDirectory } from "./helpers/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eadp-config-"));
  temporaryDirectories.push(directory);
  trackDirectory(directory);
  return directory;
}

describe("ConfigStore：一个环境名称对应一个 URL 与一个 Token", () => {
  it("持久化 name → baseUrl + token/tokenEnv，不含 accounts", async () => {
    const directory = await makeDirectory();
    const store = new ConfigStore(directory);

    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: { baseUrl: "http://10.232.2.126", tokenEnv: "EADP_DEV_ADMIN_TOKEN" },
        dev2: { baseUrl: "http://10.232.2.126", token: "readonly-secret" }
      }
    });

    const loaded = await store.load();
    expect(loaded.environments.dev?.tokenEnv).toBe("EADP_DEV_ADMIN_TOKEN");
    expect(loaded.environments.dev2?.token).toBe("readonly-secret");
    expect(await readFile(store.filePath, "utf8")).not.toContain("accounts:");
  });

  it("配置文件不存在时返回空配置", async () => {
    const store = new ConfigStore(await makeDirectory());
    await expect(store.load()).resolves.toEqual({ environments: {} });
  });

  it("拒绝同时配置 token 与 tokenEnv", async () => {
    const store = new ConfigStore(await makeDirectory());
    await expect(store.save({
      environments: {
        dev: { baseUrl: "http://localhost", token: "a", tokenEnv: "EADP_DEV_TOKEN" }
      }
    })).rejects.toThrow("环境不能同时配置 token 和 tokenEnv");
  });
});
