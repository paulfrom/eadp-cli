import { describe, expect, it } from "vitest";
import { findEndpoint, loadCatalog } from "../src/catalog/loader.js";

describe("接口目录", () => {
  it("加载给号服务保存接口及参数说明", async () => {
    const endpoint = await findEndpoint("serial-number-config-save");

    expect(endpoint.domain).toBe("serial-number");
    expect(endpoint.method).toBe("POST");
    expect(endpoint.risk).toBe("high");
    expect(endpoint.requestSchema?.required).toContain("entityClassName");
  });

  it("接口 ID 唯一", async () => {
    const endpoints = await loadCatalog();
    const ids = endpoints.map((endpoint) => endpoint.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
