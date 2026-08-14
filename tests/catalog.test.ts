/**
 * 接口目录：加载唯一性、inspect api 展示、call 目录接口的 dry-run 与参数校验。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { findEndpoint, loadCatalog } from "../src/interface-catalog/loader.js";
import {
  captureOutput,
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

describe("接口目录加载", () => {
  it("接口 ID 唯一且数量稳定", async () => {
    const endpoints = await loadCatalog();
    const ids = endpoints.map((endpoint) => endpoint.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(endpoints.length).toBe(15);
  });

  it("给号保存接口声明 high 风险与必填字段", async () => {
    const endpoint = await findEndpoint("serial-number-config-save");
    expect(endpoint.domain).toBe("serial-number");
    expect(endpoint.method).toBe("POST");
    expect(endpoint.risk).toBe("high");
    expect(endpoint.requestSchema?.required).toContain("entityClassName");
    expect(endpoint.requestSchema?.required).not.toContain("tenantCode");
  });

  it("包含组织、权限、用户与 BPM 的请求定义", async () => {
    const endpoints = await loadCatalog();
    const ids = new Set(endpoints.map((endpoint) => endpoint.id));
    expect(ids.has("resource-find-by-page")).toBe(true);
    expect(ids.has("permission-menu-tree")).toBe(true);
    expect(ids.has("permission-employee-quick-search")).toBe(true);
    expect(ids.has("bpm-find-by-page")).toBe(true);
  });
});

describe("inspect api", () => {
  it("按领域列出接口摘要并描述单接口参数", async () => {
    const output = captureOutput();
    try {
      await createProgram().parseAsync(["inspect", "api", "--domain", "organization"], { from: "user" });
      const listed = JSON.parse(output.text()) as Array<Record<string, unknown>>;
      expect(listed).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "permission-employee-by-code", name: "permission.employee.findByCode" })
      ]));
      output.clear();
      await createProgram().parseAsync(["inspect", "api", "permission-role-menu-feature-tree"], { from: "user" });
      const described = JSON.parse(output.text()) as { queryParameters: Array<Record<string, unknown>> };
      expect(described.queryParameters).toEqual([
        expect.objectContaining({ name: "featureRoleId", required: true })
      ]);
    } finally {
      output.restore();
    }
  });

  it("--domains 列出业务领域且不能与其他筛选同时使用", async () => {
    const output = captureOutput();
    try {
      await createProgram().parseAsync(["inspect", "api", "--domains"], { from: "user" });
      expect(JSON.parse(output.text())).toEqual(expect.arrayContaining(["serial-number", "permission"]));
    } finally {
      output.restore();
    }
    const error = await runExpectError(createProgram(), [
      "inspect", "api", "--domains", "--domain", "organization"
    ]);
    expect(error).toContain("--domains 不能与接口 ID 或 --domain 同时使用");
  });
});

describe("call 目录接口", () => {
  it("dry-run 校验查询参数并构建完整 URL", async () => {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "call", "permission-role-menu-feature-tree", "--env", "dev",
      "--query", "featureRoleId=role-1", "--dry-run"
    ])) as { url: string; environment: string; method: string };
    expect(output.url).toBe(
      `${fixture.baseUrl("dev")}/api-gateway/sei-basic/featureRoleFeature/getMenuFeatureTree?featureRoleId=role-1`
    );
    expect(output.environment).toBe("dev");
    expect(output.method).toBe("GET");
  });

  it("高风险接口未确认（--yes/--dry-run）时拒绝执行", async () => {
    const fixture = await createFixture({
      environments: [{ name: "global", tenantCode: "global", token: "secret" }]
    });
    const error = await runExpectError(fixture.program(), [
      "call", "serial-number-config-save", "--env", "global",
      "--data", JSON.stringify(validSerialNumberBody())
    ]);
    expect(error).toContain("高风险操作，请先使用 --dry-run");
    expect(fixture.server("global").requests).toHaveLength(0);
  });

  it("已登记接口不支持 --header", async () => {
    const error = await runExpectError(createProgram(), [
      "call", "permission-role-menu-feature-tree", "-H", "x-extra:1", "--dry-run"
    ]);
    expect(error).toContain("已登记接口不支持 --header");
  });
});

function validSerialNumberBody(): Record<string, unknown> {
  return {
    appModuleCode: "BASIC",
    appModuleName: "基础应用",
    entityClassName: "com.example.Entity",
    configType: "CODE_TYPE",
    name: "编号",
    expressionConfig: "#{00000}",
    minNumber: 0,
    maxNumber: 0,
    useDeleted: false,
    cycleStrategy: "MAX_CYCLE",
    activated: true,
    genFlag: true,
    publicFlag: true,
    tenantIsolation: true,
    configItem: [
      {
        elementName: "流水号编码",
        elementCode: "SERIAL_CODE",
        elementValue: "5",
        isolation: false,
        linkCharacter: "EMPTY",
        sort: 0
      }
    ]
  };
}
