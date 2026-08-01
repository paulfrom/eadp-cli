import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("env add", () => {
  it("一个环境名称直接保存 URL 和 Token，并可设为默认环境", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);

    await createProgram(store).parseAsync(
      [
        "env",
        "add",
        "dev",
        "--url",
        "http://10.232.2.126",
        "--token",
        "admin-token",
        "--default"
      ],
      { from: "user" }
    );
    await createProgram(store).parseAsync(
      [
        "env",
        "add",
        "dev2",
        "--url",
        "http://10.232.2.126",
        "--token",
        "readonly-token"
      ],
      { from: "user" }
    );

    const config = await store.load();
    expect(config.currentEnvironment).toBe("dev");
    expect(config.environments.dev).toMatchObject({
      baseUrl: "http://10.232.2.126",
      token: "admin-token"
    });
    expect(config.environments.dev2).toMatchObject({
      baseUrl: "http://10.232.2.126",
      token: "readonly-token"
    });
    expect(config.environments.dev).not.toHaveProperty("accounts");
  });
});
