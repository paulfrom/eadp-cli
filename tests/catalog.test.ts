import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findEndpoint, loadCatalog } from "../src/interface-catalog/loader.js";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("接口目录", () => {
  it("加载给号服务保存接口及参数说明", async () => {
    const endpoint = await findEndpoint("serial-number-config-save");

    expect(endpoint.domain).toBe("serial-number");
    expect(endpoint.method).toBe("POST");
    expect(endpoint.risk).toBe("high");
    expect(endpoint.requestSchema?.required).toContain("entityClassName");
    expect(endpoint.requestSchema?.required).not.toContain("tenantCode");
  });

  it("接口 ID 唯一", async () => {
    const endpoints = await loadCatalog();
    const ids = endpoints.map((endpoint) => endpoint.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(endpoints.length).toBe(15);
  });

  it("包含当前 CLI 的组织、权限、用户和 BPM 请求定义", async () => {
    const endpoints = await loadCatalog();
    const ids = new Set(endpoints.map((endpoint) => endpoint.id));

    expect(ids.has("resource-find-by-page")).toBe(true);
    expect(ids.has("permission-menu-tree")).toBe(true);
    expect(ids.has("permission-employee-quick-search")).toBe(true);
    expect(ids.has("bpm-find-by-page")).toBe(true);

    const quickSearch = await findEndpoint("permission-employee-quick-search");
    expect(quickSearch.method).toBe("POST");
    expect(quickSearch.path).toBe("/api-gateway/sei-basic/employee/quickSearch");
    expect(quickSearch.requestSchema?.required).toEqual(
      expect.arrayContaining(["quickSearchValue", "pageInfo", "filters", "sortOrders"])
    );

    const menuQuery = await findEndpoint("permission-role-menu-feature-tree");
    expect(menuQuery.queryParameters).toEqual([
      expect.objectContaining({ name: "featureRoleId", required: true })
    ]);
  });

  it("inspect api 暴露接口名称和接口参数", async () => {
    const output = captureOutput();
    await createProgram().parseAsync(["inspect", "api", "--domain", "organization"], {
      from: "user"
    });
    const listed = JSON.parse(output.text()) as Array<Record<string, unknown>>;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "permission-employee-by-code",
          name: "permission.employee.findByCode"
        })
      ])
    );

    vi.restoreAllMocks();
    const describeOutput = captureOutput();
    await createProgram().parseAsync(
      ["inspect", "api", "permission-role-menu-feature-tree"],
      { from: "user" }
    );
    const described = JSON.parse(describeOutput.text()) as Record<string, unknown>;
    expect(described.queryParameters).toEqual([
      expect.objectContaining({ name: "featureRoleId", required: true })
    ]);
  });

  it("call 支持已登记接口的查询参数并在 dry-run 中显示", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-catalog-test-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: "http://127.0.0.1:18080",
          token: "secret",
          tenantCode: "tenant-a"
        }
      }
    });

    const output = captureOutput();
    await createProgram(store).parseAsync(
      [
        "call",
        "permission-role-menu-feature-tree",
        "--env",
        "dev",
        "--query",
        "featureRoleId=role-1",
        "--dry-run"
      ],
      { from: "user" }
    );
    const request = JSON.parse(output.text()) as Record<string, unknown>;
    expect(request.url).toBe(
      "http://127.0.0.1:18080/api-gateway/sei-basic/featureRoleFeature/getMenuFeatureTree?featureRoleId=role-1"
    );
  });

  it("给号保存请求使用 env add 获得的 tenantCode，覆盖调用方输入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-catalog-test-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "global",
      environments: {
        global: {
          baseUrl: "http://127.0.0.1:18080",
          token: "secret",
          tenantCode: "global"
        }
      }
    });
    const output = captureOutput();
    const body = serialNumberBody();
    body.tenantCode = "caller-supplied";

    await createProgram(store).parseAsync(
      [
        "call",
        "serial-number-config-save",
        "--data",
        JSON.stringify(body),
        "--dry-run"
      ],
      { from: "user" }
    );

    const request = JSON.parse(output.text()) as { body: Record<string, unknown> };
    expect(request.body.tenantCode).toBe("global");
  });

  it("非 global 环境不能通过 call 调用给号配置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-catalog-test-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(directory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: "http://127.0.0.1:18080",
          token: "secret",
          tenantCode: "tenant-a"
        }
      }
    });

    const body = {
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
      tenantCode: "global",
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

    await expect(
      createProgram(store).parseAsync(
        [
          "call",
          "serial-number-config-save",
          "--env",
          "dev",
          "--data",
          JSON.stringify(body),
          "--dry-run"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
  });

  it("动态请求模板不能被 call 直接执行", async () => {
    await expect(
      createProgram().parseAsync(["call", "resource-find-by-page"], { from: "user" })
    ).rejects.toThrow("动态请求模板");
  });
});

function captureOutput(): { text: () => string } {
  let value = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    value += String(chunk);
    return true;
  });
  return { text: () => value };
}

function serialNumberBody(): Record<string, unknown> {
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
