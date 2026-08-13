import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

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

describe("env add", () => {
  it("保存 Token 前获取并记录 tenantCode，并可设为默认环境", async () => {
    const baseUrl = await startTenantServer();
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);

    await createProgram(store).parseAsync(
      ["env", "add", "dev", "--url", baseUrl, "--token", "admin-token", "--default"],
      { from: "user" }
    );
    await createProgram(store).parseAsync(
      ["env", "add", "dev2", "--url", baseUrl, "--token", "readonly-token"],
      { from: "user" }
    );

    const config = await store.load();
    expect(config.currentEnvironment).toBe("dev");
    expect(config.environments.dev).toMatchObject({
      baseUrl,
      token: "admin-token",
      tenantCode: "global"
    });
    expect(config.environments.dev2).toMatchObject({
      baseUrl,
      token: "readonly-token",
      tenantCode: "tenant-a"
    });
    expect(config.environments.dev).not.toHaveProperty("accounts");
  });

  it("NormalUser 禁止注册环境且不覆盖已有配置", async () => {
    const baseUrl = await startTenantServer();
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-normal-user-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: { baseUrl, token: "old-token", tenantCode: "tenant-a" }
      }
    });

    await expect(
      createProgram(store).parseAsync(
        ["env", "add", "dev", "--url", baseUrl, "--token", "normal-token"],
        { from: "user" }
      )
    ).rejects.toThrow("NormalUser");

    expect((await store.load()).environments.dev).toMatchObject({
      baseUrl,
      token: "old-token",
      tenantCode: "tenant-a"
    });
  });

  it("未知 authorityPolicy 也禁止注册环境", async () => {
    const baseUrl = await startTenantServer();
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-unknown-policy-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);

    await expect(
      createProgram(store).parseAsync(
        ["env", "add", "dev", "--url", baseUrl, "--token", "unknown-policy-token"],
        { from: "user" }
      )
    ).rejects.toThrow("UnknownPolicy");

    expect((await store.load()).environments).not.toHaveProperty("dev");
  });

  it("获取用户信息失败时不保存新 Token 或新 tenantCode", async () => {
    const baseUrl = await startTenantServer();
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: { baseUrl, token: "old-token", tenantCode: "tenant-a" }
      }
    });

    await expect(
      createProgram(store).parseAsync(
        ["env", "add", "dev", "--url", baseUrl, "--token", "bad-token"],
        { from: "user" }
      )
    ).rejects.toThrow("HTTP 401");

    expect((await store.load()).environments.dev).toMatchObject({
      baseUrl,
      token: "old-token",
      tenantCode: "tenant-a"
    });
  });

  it("租户接口 success=false 时即使携带 tenantCode 也不保存环境", async () => {
    const baseUrl = await startTenantServer();
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-envelope-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);

    await expect(
      createProgram(store).parseAsync(
        ["env", "add", "dev", "--url", baseUrl, "--token", "failed-envelope"],
        { from: "user" }
      )
    ).rejects.toThrow("EADP 请求失败：invalid token");

    expect((await store.load()).environments).not.toHaveProperty("dev");
  });

  it("移除环境，并在移除默认环境时清空默认值", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-remove-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: "http://dev.example.com",
          token: "dev-token",
          tenantCode: "tenant-a"
        },
        test: {
          baseUrl: "http://test.example.com",
          token: "test-token",
          tenantCode: "tenant-b"
        }
      }
    });

    await createProgram(store).parseAsync(["env", "remove", "dev"], {
      from: "user"
    });

    const config = await store.load();
    expect(config.environments).not.toHaveProperty("dev");
    expect(config.environments).toHaveProperty("test");
    expect(config.currentEnvironment).toBeUndefined();
  });

  it("拒绝移除不存在的环境且不修改配置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-remove-missing-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: "http://dev.example.com",
          token: "dev-token",
          tenantCode: "tenant-a"
        }
      }
    });

    await expect(
      createProgram(store).parseAsync(["env", "remove", "missing"], {
        from: "user"
      })
    ).rejects.toThrow("环境不存在：missing");
    expect((await store.load()).currentEnvironment).toBe("dev");
  });

  it("env list 显示 Authorization 认证来源且不泄露凭证", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-env-list-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "implicit",
      environments: {
        implicit: {
          baseUrl: "http://implicit.example.com",
          tenantCode: "tenant-a",
          authorization: "Bearer should-not-leak"
        }
      }
    });

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram(store).parseAsync(["env", "list"], { from: "user" });
      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain('"tokenSource": "config:authorization"');
      expect(output).not.toContain("should-not-leak");
    } finally {
      write.mockRestore();
    }
  });
});

async function startTenantServer(): Promise<string> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== "/api-gateway/sei-basic/account/getByApiKey") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, message: "not found" }));
      return;
    }
    const token = request.headers["x-api-token"];
    if (requestUrl.searchParams.get("apiKey") !== token) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, message: "invalid apiKey" }));
      return;
    }
    if (token === "bad-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, message: "invalid token" }));
      return;
    }
    if (token === "failed-envelope") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          message: "invalid token",
          data: { tenantCode: "must-not-be-used" }
        })
      );
      return;
    }
    const authorityPolicy =
      token === "admin-token"
        ? "GlobalAdmin"
        : token === "readonly-token"
          ? "TenantAdmin"
          : token === "unknown-policy-token"
            ? "UnknownPolicy"
            : "NormalUser";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        data: {
          tenantCode: token === "admin-token" ? "global" : "tenant-a",
          authorityPolicy
        }
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器未分配端口");
  }
  return `http://127.0.0.1:${address.port}`;
}
