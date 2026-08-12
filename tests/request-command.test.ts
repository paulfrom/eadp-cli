import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
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

describe("call 原始请求", () => {
  it("--body 从文件读取并发送 JSON 请求体", async () => {
    let capturedBody = "";
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      capturedBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"success":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const directory = await mkdtemp(join(tmpdir(), "eadp-request-"));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, "body.json");
    await writeFile(bodyFile, '{"name":"岗位类别"}', "utf8");
    const store = new ConfigStore(join(directory, "config"));
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

    await createProgram(store).parseAsync(
      ["call", "POST", "/api/save", "--body", bodyFile],
      { from: "user" }
    );

    expect(JSON.parse(capturedBody)).toEqual({ name: "岗位类别" });
  });

  it("非 global 环境不能通过原始 call 绕过功能项的 global 限制", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"success":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const directory = await mkdtemp(join(tmpdir(), "eadp-request-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(join(directory, "config"));
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

    await expect(
      createProgram(store).parseAsync(
        ["call", "GET", "/api-gateway/sei-basic/feature/findByPage"],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(requestCount).toBe(0);
  });

  it.each([
    "featureGroup",
    "serialNumberConfig"
  ])("非 global 环境不能通过原始 call 绕过真实 %s 后端路径的 global 限制", async (resource) => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"success":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const directory = await mkdtemp(join(tmpdir(), "eadp-request-backend-path-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(join(directory, "config"));
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

    await expect(
      createProgram(store).parseAsync(
        ["call", "GET", `/api-gateway/sei-basic/${resource}/findByPage`],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(requestCount).toBe(0);
  });
});
