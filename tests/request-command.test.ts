import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
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

describe("request 命令", () => {
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
          token: "secret"
        }
      }
    });

    await createProgram(store).parseAsync(
      ["request", "POST", "/api/save", "--body", bodyFile],
      { from: "user" }
    );

    expect(JSON.parse(capturedBody)).toEqual({ name: "岗位类别" });
  });
});
