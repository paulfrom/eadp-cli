import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRequest } from "../src/http/client.js";
import {
  cleanupAll,
  createFixture,
  createMockServer,
  trackServer
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

describe("sendRequest：统一 HTTP 客户端", () => {
  it("注入 x-api-token 并发送 JSON 请求体", async () => {
    const server = createMockServer();
    trackServer(server);
    let capturedToken = "";
    let capturedBody = "";
    server.onRequest("POST", "/api/save", (context) => {
      capturedToken = String(context.headers["x-api-token"]);
      capturedBody = context.rawBody;
      context.raw({ success: true, data: { id: "ok" } });
    });
    const baseUrl = await server.start();

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
    const server = createMockServer();
    trackServer(server);
    let capturedAuthorization = "";
    let capturedToken: string | undefined;
    server.onRequest("GET", "/api/implicit", (context) => {
      capturedAuthorization = String(context.headers.authorization);
      capturedToken = context.headers["x-api-token"];
      context.raw({ success: true, data: { id: "ok" } });
    });
    const baseUrl = await server.start();

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
    const server = createMockServer();
    trackServer(server);
    server.onRequest("POST", "/api/save", (context) => {
      context.raw({ success: false, message: "没有权限" });
    });
    const baseUrl = await server.start();

    await expect(
      sendRequest({ baseUrl, path: "/api/save", method: "POST", token: "must-not-leak" })
    ).rejects.toThrow("EADP 请求失败：没有权限");

    try {
      await sendRequest({ baseUrl, path: "/api/save", method: "POST", token: "must-not-leak" });
    } catch (error) {
      expect(String(error)).not.toContain("must-not-leak");
    }
  });

  it("非 2xx 响应抛出 HTTP 状态与摘要", async () => {
    const server = createMockServer();
    trackServer(server);
    server.onRequest("GET", "/api/missing", (context) => {
      context.fail("not found", 404);
    });
    const baseUrl = await server.start();
    await expect(
      sendRequest({ baseUrl, path: "/api/missing", method: "GET" })
    ).rejects.toThrow("HTTP 404");
  });

  it("传输失败仅保留稳定诊断码且不泄露环境 URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect to https://secret.example"), { code: "ENOTFOUND" })
      })
    );
    try {
      const error = await sendRequest({
        baseUrl: "https://secret.example",
        path: "/private/path",
        method: "GET"
      }).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toMatchObject({
        code: "EADP_REQUEST_FAILED",
        message: "请求失败（ENOTFOUND）"
      });
      expect(String(error)).not.toContain("secret.example");
      expect(String(error)).not.toContain("private/path");
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("sendRequest：与 CLI 环境配置集成", () => {
  it("请求绑定环境 URL 与 Token，不使用其他环境地址", async () => {
    const fixture = await createFixture({
      environments: [
        { name: "alpha", tenantCode: "tenant-a", token: "alpha-token" },
        { name: "beta", tenantCode: "tenant-a", token: "beta-token" }
      ]
    });
    const seen: Array<{ host: string; token: string }> = [];
    for (const name of ["alpha", "beta"]) {
      fixture.server(name).onRequest("GET", "/probe", (context) => {
        seen.push({ host: context.headers.host ?? "", token: String(context.headers["x-api-token"]) });
        context.json({ ok: true });
      });
    }
    await sendRequest({
      baseUrl: fixture.baseUrl("alpha"),
      path: "/probe",
      method: "GET",
      token: "alpha-token"
    });
    await sendRequest({
      baseUrl: fixture.baseUrl("beta"),
      path: "/probe",
      method: "GET",
      token: "beta-token"
    });
    expect(seen).toEqual([
      { host: new URL(fixture.baseUrl("alpha")).host, token: "alpha-token" },
      { host: new URL(fixture.baseUrl("beta")).host, token: "beta-token" }
    ]);
  });
});
