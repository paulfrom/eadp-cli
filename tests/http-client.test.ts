import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { sendRequest } from "../src/http/client.js";

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
});

describe("sendRequest", () => {
  it("注入 x-api-token 并发送 JSON 请求体", async () => {
    let capturedToken = "";
    let capturedBody = "";
    const baseUrl = await listen(async (request) => {
      capturedToken = String(request.headers["x-api-token"]);
      capturedBody = await readBody(request);
      return { success: true, data: { id: "ok" } };
    });

    const result = await sendRequest({
      baseUrl,
      path: "/api/save",
      method: "POST",
      token: "top-secret",
      body: { name: "岗位类别" }
    });

    expect(capturedToken).toBe("top-secret");
    expect(JSON.parse(capturedBody)).toEqual({ name: "岗位类别" });
    expect(result.data).toEqual({ success: true, data: { id: "ok" } });
  });

  it("Authorization 优先于 Token，并移除 x-api-token", async () => {
    let capturedAuthorization = "";
    let capturedToken: string | undefined;
    const baseUrl = await listen(async (request) => {
      capturedAuthorization = String(request.headers.authorization);
      capturedToken = request.headers["x-api-token"];
      return { success: true, data: { id: "ok" } };
    });

    await sendRequest({
      baseUrl,
      path: "/api/implicit",
      method: "GET",
      token: "display-token",
      authorization: "Bearer implicit-secret",
      headers: { "x-api-token": "stale-token" }
    });

    expect(capturedAuthorization).toBe("Bearer implicit-secret");
    expect(capturedToken).toBeUndefined();
  });

  it("EADP success=false 时返回失败且不泄露 Token", async () => {
    const baseUrl = await listen(async () => ({
      success: false,
      message: "没有权限"
    }));

    await expect(
      sendRequest({
        baseUrl,
        path: "/api/save",
        method: "POST",
        token: "must-not-leak"
      })
    ).rejects.toThrow("EADP 请求失败：没有权限");

    try {
      await sendRequest({
        baseUrl,
        path: "/api/save",
        method: "POST",
        token: "must-not-leak"
      });
    } catch (error) {
      expect(String(error)).not.toContain("must-not-leak");
    }
  });
});

async function listen(
  responseFactory: (request: IncomingMessage) => Promise<unknown>
): Promise<string> {
  const server = createServer(async (request, response) => {
    const data = await responseFactory(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器启动失败");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
