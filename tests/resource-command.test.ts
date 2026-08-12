import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { ConfigStore } from "../src/config/store.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("query 和 sync 命令", () => {
  it.each([
    "feature-group",
    "featureGroup",
    "serial-number",
    "serialNumberConfig"
  ])("query %s 别名在非 global 环境先拒绝且不发请求", async (resource) => {
    let requestCount = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => {
        requestCount += 1;
        respond(response, { rows: [], total: 0 });
      },
      target: (_request, response) => respond(response, { rows: [], total: 0 })
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "tenant-a";
    });

    await expect(
      createProgram(store).parseAsync(
        ["query", resource, "--env", "source"],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(requestCount).toBe(0);
  });

  it("sync serial-number 按 entityClassName 幂等同步给号配置且不复制源 ID", async () => {
    const targetConfigs: Array<Record<string, unknown>> = [];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as { filters?: unknown[] };
        expect(body.filters).toEqual([
          { fieldName: "entityClassName", operator: "EQ", value: "com.example.Order" },
          { fieldName: "configType", operator: "EQ", value: "CODE_TYPE" }
        ]);
        respond(response, {
          rows: [{
            id: "source-config-id",
            appModuleCode: "ORDER",
            appModuleName: "订单",
            entityClassName: "com.example.Order",
            configType: "CODE_TYPE",
            name: "订单编号",
            expressionConfig: "#{00000}",
            minNumber: 1,
            maxNumber: 0,
            useDeleted: false,
            cycleStrategy: "MAX_CYCLE",
            returnStrategy: null,
            activated: true,
            genFlag: true,
            tenantCode: "source-tenant",
            publicFlag: true,
            tenantIsolation: true,
            isolationExpression: "",
            configItem: [{
              id: "source-item-id",
              configId: "source-config-id",
              elementName: "流水号编码",
              elementCode: "SERIAL_CODE",
              elementValue: "5",
              isolation: false,
              linkCharacter: "EMPTY",
              sort: 0
            }]
          }],
          total: 1
        });
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) {
          respond(response, { rows: targetConfigs, total: targetConfigs.length });
          return;
        }
        if (path.endsWith("/serialNumberConfig/save")) {
          const body = (await readBody(request)) as Record<string, unknown>;
          savedBodies.push(body);
          const saved = { ...body, id: "target-config-id" };
          targetConfigs.splice(0, targetConfigs.length, saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();
    const args = [
      "--compact", "sync", "serial-number",
      "--source", "source", "--target", "target",
      "--entity-class", "com.example.Order", "--apply"
    ];

    await createProgram(store).parseAsync(args, { from: "user" });
    await createProgram(store).parseAsync(args, { from: "user" });

    expect(savedBodies).toHaveLength(1);
    expect(savedBodies[0]).toMatchObject({
      entityClassName: "com.example.Order",
      configType: "CODE_TYPE",
      returnStrategy: "NEW",
      tenantCode: "global"
    });
    expect(savedBodies[0]).not.toHaveProperty("id");
    expect(savedBodies[0]!.configItem).toEqual([
      expect.not.objectContaining({ id: expect.anything(), configId: expect.anything() })
    ]);
    const results = output.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(results[0].kind).toBe("eadp.resource.sync.v1");
    expect(results[0].summary.create).toBe(1);
    expect(results[1].summary.unchanged).toBe(1);
  });

  it("sync serial-number 按 entityClassName 和目标 tenantCode 匹配，忽略其他租户同名配置", async () => {
    const targetConfigs: Array<Record<string, unknown>> = [{
      id: "other-tenant-config-id",
      entityClassName: "com.example.Order",
      configType: "CODE_TYPE",
      tenantCode: "other-tenant",
      name: "其他租户编号",
      returnStrategy: "NEW",
      configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
    }];
    const savedBodies: Array<Record<string, unknown>> = [];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as { filters?: unknown[] };
        expect(body.filters).toEqual([
          { fieldName: "entityClassName", operator: "EQ", value: "com.example.Order" },
          { fieldName: "configType", operator: "EQ", value: "CODE_TYPE" }
        ]);
        respond(response, {
          rows: [{
            entityClassName: "com.example.Order",
            configType: "CODE_TYPE",
            tenantCode: "source-tenant",
            name: "源租户编号",
            returnStrategy: "NEW",
            configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
          }],
          total: 1
        });
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) {
          respond(response, { rows: targetConfigs, total: targetConfigs.length });
          return;
        }
        if (path.endsWith("/serialNumberConfig/save")) {
          const body = (await readBody(request)) as Record<string, unknown>;
          savedBodies.push(body);
          const saved = { ...body, id: "target-global-config-id" };
          targetConfigs.push(saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "--compact", "sync", "serial-number",
        "--source", "source", "--target", "target",
        "--entity-class", "com.example.Order", "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 0 });
    expect(savedBodies).toHaveLength(1);
    expect(savedBodies[0]).not.toHaveProperty("id");
    expect(savedBodies[0]).toMatchObject({
      entityClassName: "com.example.Order",
      tenantCode: "global"
    });
  });

  it("sync serial-number 检测多个源租户映射到同一目标复合键并在写入前失败", async () => {
    let targetSaveCount = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) =>
        respond(response, {
          rows: [
            {
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "source-a",
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            },
            {
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "source-b",
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            }
          ],
          total: 2
        }),
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) {
          respond(response, { rows: [], total: 0 });
          return;
        }
        if (path.endsWith("/serialNumberConfig/save")) {
          targetSaveCount += 1;
          respond(response, { id: `target-${targetSaveCount}` });
          return;
        }
        respond(response, undefined, 404);
      }
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "sync", "serial-number",
          "--source", "source", "--target", "target"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("映射到目标环境后业务唯一键重复");
    expect(targetSaveCount).toBe(0);
  });

  it("sync serial-number 预览时按实体过滤目标环境，避免无关非法枚举记录导致查询失败", async () => {
    const expectedFilters = [
      { fieldName: "entityClassName", operator: "EQ", value: "com.test.cli.demo" },
      { fieldName: "configType", operator: "EQ", value: "CODE_TYPE" }
    ];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as { filters?: unknown[] };
        expect(body.filters).toEqual(expectedFilters);
        respond(response, {
          rows: [{
            id: "source-config-id",
            entityClassName: "com.test.cli.demo",
            configType: "CODE_TYPE",
            tenantCode: "source-tenant",
            name: "CLI 测试编号",
            returnStrategy: "NEW",
            configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
          }],
          total: 1
        });
      },
      target: async (request, response) => {
        const body = (await readBody(request)) as { filters?: unknown[] };
        if (!body.filters || body.filters.length === 0) {
          respond(
            response,
            "IllegalArgumentException: No enum constant com.changhong.sei.serial.entity.enumclass.ReturnStrategy.",
            500
          );
          return;
        }
        expect(body.filters).toEqual(expectedFilters);
        respond(response, { rows: [], total: 0 });
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "--compact", "sync", "serial-number",
        "--source", "source", "--target", "target",
        "--entity-class", "com.test.cli.demo"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.applied).toBe(false);
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 0 });
  });

  it("sync serial-number 新增时将缺失、null 和空白 returnStrategy 默认成 NEW", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) => {
        respond(response, {
          rows: [
            {
              entityClassName: "com.example.MissingStrategy",
              configType: "CODE_TYPE",
              tenantCode: "source-tenant",
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            },
            {
              entityClassName: "com.example.NullStrategy",
              configType: "CODE_TYPE",
              tenantCode: "source-tenant",
              returnStrategy: null,
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            },
            {
              entityClassName: "com.example.BlankStrategy",
              configType: "CODE_TYPE",
              tenantCode: "source-tenant",
              returnStrategy: "  ",
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            }
          ],
          total: 3
        });
      },
      target: (_request, response) => respond(response, { rows: [], total: 0 })
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["--compact", "sync", "serial-number", "--source", "source", "--target", "target"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.changes).toHaveLength(3);
    expect(result.changes.every(
      (change: { desired: { returnStrategy?: unknown } }) =>
        change.desired.returnStrategy === "NEW"
    )).toBe(true);
  });

  it("sync serial-number 将单条非法 configItem 标记为 blocked 并应用安全记录", async () => {
    const targetConfigs: Array<Record<string, unknown>> = [];
    const savedEntities: string[] = [];
    const { store } = await createFixtureServer({
      source: (_request, response) => {
        respond(response, {
          rows: [
            {
              id: "source-valid",
              entityClassName: "com.example.ValidOrder",
              configType: "CODE_TYPE",
              tenantCode: "source-tenant",
              name: "有效编号",
              configItem: [{ elementName: "流水号", elementCode: "SERIAL_CODE", sort: 0 }]
            },
            {
              id: "source-invalid",
              entityClassName: "com.example.InvalidOrder",
              configType: "CODE_TYPE",
              tenantCode: "source-tenant",
              name: "无效编号",
              configItem: null
            }
          ],
          total: 2
        });
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/serialNumberConfig/findByPage")) {
          respond(response, { rows: targetConfigs, total: targetConfigs.length });
          return;
        }
        if (path.endsWith("/serialNumberConfig/save")) {
          const body = (await readBody(request)) as Record<string, unknown>;
          savedEntities.push(String(body.entityClassName));
          const saved = { ...body, id: "target-valid" };
          targetConfigs.push(saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "--compact", "sync", "serial-number",
        "--source", "source", "--target", "target", "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(result.skippedBlocked).toBe(1);
    expect(result.verified).toBe(true);
    expect(savedEntities).toEqual(["com.example.ValidOrder"]);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: JSON.stringify({ entityClassName: "com.example.invalidorder", tenantCode: "global" }),
        action: "blocked",
        desired: null,
        blockingIssues: [expect.objectContaining({
          resource: "serial-number",
          field: "configItem",
          reason: "invalid"
        })]
      })
    ]));
    expect(result.blockingIssues).toEqual([
      expect.objectContaining({
        resource: "serial-number",
        field: "configItem",
        reason: "invalid"
      })
    ]);
  });

  it("query 给号配置时默认限定 CODE_TYPE，并按 entityClassName 校验唯一性", async () => {
    let requestBody: unknown;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        requestBody = await readBody(request);
        respond(response, {
          rows: [
            {
              id: "serial-1",
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "global"
            }
          ],
          total: 1
        });
      }
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "global";
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "query",
        "serialNumberConfig",
        "--env",
        "source",
        "--entity-class",
        "com.example.Order"
      ],
      { from: "user" }
    );

    expect(requestBody).toMatchObject({
      filters: [
        { fieldName: "entityClassName", operator: "EQ", value: "com.example.Order" },
        { fieldName: "configType", operator: "EQ", value: "CODE_TYPE" },
        {
          fieldName: "publicFlag",
          fieldType: "java.lang.Boolean",
          operator: "EQ",
          value: true
        }
      ]
    });
    const events = parseNdjson(output.text());
    expect(events.at(-1)?.identity).toEqual({
      fields: ["entityClassName", "tenantCode"],
      values: [{ entityClassName: "com.example.order", tenantCode: "global" }],
      exists: true,
      unique: true
    });
  });

  it("query 给号配置发现重复 entityClassName 时终止", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) =>
        respond(response, {
          rows: [
            {
              id: "serial-1",
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "global"
            },
            {
              id: "serial-2",
              entityClassName: "com.example.Order",
              configType: "BAR_TYPE",
              tenantCode: "global"
            }
          ],
          total: 2
        })
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "global";
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "query",
          "serialNumberConfig",
          "--env",
          "source",
          "--entity-class",
          "com.example.Order"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("业务唯一键 entityClassName+tenantCode 重复");
  });

  it("query 给号配置按 entityClassName 和 tenantCode 逐条判重并输出全部复合键", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) =>
        respond(response, {
          rows: [
            {
              id: "serial-global",
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "global"
            },
            {
              id: "serial-tenant-a",
              entityClassName: "com.example.Order",
              configType: "CODE_TYPE",
              tenantCode: "tenant-a"
            }
          ],
          total: 2
        })
    });
    await store.update((config) => {
      config.environments.source!.tenantCode = "global";
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "query",
        "serialNumberConfig",
        "--env",
        "source",
        "--entity-class",
        "com.example.Order"
      ],
      { from: "user" }
    );

    const events = parseNdjson(output.text());
    expect(events.at(-1)?.identity).toEqual({
      fields: ["entityClassName", "tenantCode"],
      values: [
        { entityClassName: "com.example.order", tenantCode: "global" },
        { entityClassName: "com.example.order", tenantCode: "tenant-a" }
      ],
      exists: true,
      unique: true
    });
  });

  it("query 给号配置缺少 tenantCode 时明确失败", async () => {
    const { store } = await createFixtureServer({
      source: (_request, response) =>
        respond(response, {
          rows: [{
            id: "serial-missing-tenant",
            entityClassName: "com.example.Order",
            configType: "CODE_TYPE"
          }],
          total: 1
        })
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "query",
          "serialNumberConfig",
          "--env",
          "source",
          "--entity-class",
          "com.example.Order"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("tenantCode");
  });

  it("query 自动读取全部分页结果", async () => {
    const requestedPages: number[] = [];
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as {
          pageInfo: { page: number; rows: number };
        };
        requestedPages.push(body.pageInfo.page);
        const rows =
          body.pageInfo.page === 1
            ? Array.from({ length: body.pageInfo.rows }, (_, index) => ({
                id: `feature-${index}`,
                code: `FEATURE_${index}`
              }))
            : [{ id: "feature-last", code: "FEATURE_LAST" }];
        respond(response, { rows, total: body.pageInfo.rows + 1 });
      },
      target: (_request, response) => respond(response, { rows: [], total: 0 })
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["query", "feature", "--env", "source"],
      { from: "user" }
    );

    const events = parseNdjson(output.text());
    const items = events
      .filter((event) => event.kind === "eadp.resource.query.item.v1")
      .map((event) => event.item);
    expect(requestedPages).toEqual([1, 2]);
    expect(items).toHaveLength(501);
    expect(events.at(-1)).toMatchObject({
      kind: "eadp.resource.query.summary.v1",
      total: 501
    });
  });

  it("query 聚合开发环境的 1855 条功能项", async () => {
    const requestedPages: number[] = [];
    const expectedCount = 1_855;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const body = (await readBody(request)) as {
          pageInfo: { page: number; rows: number };
        };
        const { page, rows: pageSize } = body.pageInfo;
        requestedPages.push(page);
        const start = (page - 1) * pageSize;
        const count = Math.max(0, Math.min(pageSize, expectedCount - start));
        const rows = Array.from({ length: count }, (_, index) => ({
          id: `feature-${start + index}`,
          code: `FEATURE_${start + index}`
        }));
        respond(response, { rows, total: 11 });
      },
      target: (_request, response) => respond(response, { rows: [], total: 0 })
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["query", "feature", "--env", "source"],
      { from: "user" }
    );

    const events = parseNdjson(output.text());
    const items = events
      .filter((event) => event.kind === "eadp.resource.query.item.v1")
      .map((event) => event.item as { id: string });
    expect(requestedPages).toEqual([1, 2, 3, 4]);
    expect(items).toHaveLength(expectedCount);
    expect(new Set(items.map((item) => item.id)).size).toBe(expectedCount);
    expect(events.at(-1)).toMatchObject({
      kind: "eadp.resource.query.summary.v1",
      total: expectedCount
    });
  });

  it("query 将月份转换成创建时间的左闭右开过滤条件", async () => {
    let requestBody: unknown;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        requestBody = await readBody(request);
        respond(response, {
          rows: [{ id: "feature-a", code: "NEW_FEATURE", createdDate: "2026-07-10 08:00:00" }],
          total: 1
        });
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "query",
        "feature",
        "--env",
        "source",
        "--created-in",
        "2026-07",
      ],
      { from: "user" }
    );

    expect(requestBody).toMatchObject({
      filters: [
        { fieldName: "createdDate", operator: "GE", value: "2026-07-01 00:00:00" },
        { fieldName: "createdDate", operator: "LT", value: "2026-08-01 00:00:00" }
      ]
    });
    const events = parseNdjson(output.text());
    expect(events.map((event) => event.kind)).toEqual([
      "eadp.resource.query.meta.v1",
      "eadp.resource.query.item.v1",
      "eadp.resource.query.summary.v1"
    ]);
    expect(events[1]?.item).toMatchObject({ code: "NEW_FEATURE" });
  });

  it("sync 功能项时按业务代码映射依赖和目标记录，默认只预览", async () => {
    let targetSaveCount = 0;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [
              {
                id: "source-feature-id",
                code: "NEW_FEATURE",
                name: "新功能",
                url: "/new",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleId: "source-app-id",
                appModuleCode: "BASIC",
                featureGroupId: "source-group-id",
                featureGroupCode: "BASE_CONFIG",
                createdDate: "2026-07-10 08:00:00"
              }
            ],
            total: 1
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: [], total: 0 });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "BASIC" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, [{ id: "target-group-id", code: "BASE_CONFIG" }]);
          return;
        }
        if (path.endsWith("/feature/save")) {
          targetSaveCount += 1;
          respond(response, { id: "target-feature-id" });
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "sync",
        "feature",
        "--source",
        "source",
        "--target",
        "target",
        "--created-in",
        "2026-07",
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.resource.sync.v1");
    expect(result.applied).toBe(false);
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 0 });
    expect(result.changes[0].desired).toMatchObject({
      code: "NEW_FEATURE",
      appModuleId: "target-app-id",
      featureGroupId: "target-group-id"
    });
    expect(result.changes[0].desired).not.toHaveProperty("id");
    expect(result.changes[0].desired).not.toHaveProperty("createdDate");
    expect(targetSaveCount).toBe(0);
  });

  it("sync 功能项时忽略源 specialProjectId 并保留目标环境关联", async () => {
    const { store } = await createFixtureServer({
      source: (request, response) => {
        if (requestPath(request).endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [{
              id: "source-feature-id",
              code: "FSSC-FMS-11",
              name: "新名称",
              featureType: "Operate",
              canMenu: false,
              tenantCanUse: true,
              mobileUse: false,
              appModuleCode: "FSSC",
              specialProjectId: "source-project-id"
            }],
            total: 1
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [{
              id: "target-feature-id",
              code: "FSSC-FMS-11",
              name: "旧名称",
              featureType: "Operate",
              canMenu: false,
              tenantCanUse: true,
              mobileUse: false,
              appModuleId: "target-app-id",
              specialProjectId: "target-project-id"
            }],
            total: 1
          });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "FSSC" }]);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["sync", "feature", "--source", "source", "--target", "target"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 0, update: 1, unchanged: 0, blocked: 0 });
    expect(result.changes[0].changedFields).not.toContain("specialProjectId");
    expect(result.changes[0].desired.specialProjectId).toBe("target-project-id");
  });

  it("sync 功能项时完整报告缺失依赖并仅应用安全记录", async () => {
    const targetFeatures: Array<Record<string, unknown>> = [];
    const savedCodes: string[] = [];
    const { store } = await createFixtureServer({
      source: (request, response) => {
        if (requestPath(request).endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [
              {
                id: "source-blocked",
                code: "ISRM-BLOCKED",
                name: "依赖缺失功能",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleCode: "ISRM",
                featureGroupCode: "ISRM-PA-OLD-2"
              },
              {
                id: "source-safe",
                code: "ISRM-SAFE",
                name: "安全功能",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleCode: "ISRM"
              }
            ],
            total: 2
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: targetFeatures, total: targetFeatures.length });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "ISRM" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, []);
          return;
        }
        if (path.endsWith("/feature/save")) {
          const body = (await readBody(request)) as Record<string, unknown>;
          savedCodes.push(String(body.code));
          targetFeatures.push({ ...body, id: "target-safe-id" });
          respond(response, targetFeatures[0]);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["sync", "feature", "--source", "source", "--target", "target", "--apply"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.skippedBlocked).toBe(1);
    expect(savedCodes).toEqual(["ISRM-SAFE"]);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({
      key: "ISRM-BLOCKED",
      action: "blocked",
      missingDependencies: [{
        resource: "feature-group",
        identityField: "code",
        value: "ISRM-PA-OLD-2",
        reason: "missing"
      }]
    });
    expect(result.missingDependencies).toEqual([{
      resource: "feature-group",
      identityField: "code",
      value: "ISRM-PA-OLD-2",
      reason: "missing"
    }]);
  });

  it("sync feature-group 按代码映射应用模块并创建后回查", async () => {
    const targetGroups: Array<Record<string, unknown>> = [];
    let sourceRequestPath: string | undefined;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        if (requestPath(request).endsWith("/featureGroup/findAll")) {
          sourceRequestPath = requestPath(request);
          // findAll has no request body; filtering is intentionally local.
          respond(response, [{
              id: "source-group-id",
              code: "ISRM-PA-OLD-2",
              name: "旧采购功能组",
              appModuleId: "source-app-id",
              appModuleCode: "ISRM"
            }, {
              id: "source-other-id",
              code: "OTHER-GROUP",
              name: "其他功能组",
              appModuleId: "source-app-id",
              appModuleCode: "ISRM"
          }]);
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, targetGroups);
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "ISRM" }]);
          return;
        }
        if (path.endsWith("/featureGroup/save")) {
          const body = (await readBody(request)) as Record<string, unknown>;
          const saved = {
            ...body,
            id: "target-group-id",
            appModuleCode: "ISRM"
          };
          targetGroups.push(saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "sync", "feature-group",
        "--source", "source",
        "--target", "target",
        "--code", "ISRM-PA-OLD-2",
        "--apply"
      ],
      { from: "user" }
    );

    expect(sourceRequestPath).toContain("/featureGroup/findAll");
    const result = JSON.parse(output.text());
    expect(result.resource).toBe("feature-group");
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 0 });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].key).toBe("ISRM-PA-OLD-2");
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(targetGroups[0]).toMatchObject({
      code: "ISRM-PA-OLD-2",
      name: "旧采购功能组",
      appModuleId: "target-app-id"
    });
    expect(targetGroups[0]?.appModuleId).not.toBe("source-app-id");
  });

  it("sync --apply 写入后重新查询验证", async () => {
    const targetFeatures: Array<Record<string, unknown>> = [];
    let savedBody: Record<string, unknown> | undefined;
    const { store } = await createFixtureServer({
      source: async (request, response) => {
        if (requestPath(request).endsWith("/feature/findByPage")) {
          respond(response, {
            rows: [
              {
                id: "source-id",
                code: "NEW_FEATURE",
                name: "新功能",
                featureType: "Operate",
                canMenu: false,
                tenantCanUse: true,
                mobileUse: false,
                appModuleCode: "BASIC"
              }
            ],
            total: 1
          });
          return;
        }
        respond(response, undefined, 404);
      },
      target: async (request, response) => {
        const path = requestPath(request);
        if (path.endsWith("/feature/findByPage")) {
          respond(response, { rows: targetFeatures, total: targetFeatures.length });
          return;
        }
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "target-app-id", code: "BASIC" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, []);
          return;
        }
        if (path.endsWith("/feature/save")) {
          savedBody = (await readBody(request)) as Record<string, unknown>;
          const saved = { ...savedBody, id: "target-id" };
          targetFeatures.push(saved);
          respond(response, saved);
          return;
        }
        respond(response, undefined, 404);
      }
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "sync",
        "feature",
        "--source",
        "source",
        "--target",
        "target",
        "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(savedBody).toMatchObject({
      code: "NEW_FEATURE",
      appModuleId: "target-app-id"
    });
  });

  it("迁移前先校验源和目标租户，任一不满足时不发起远程请求", async () => {
    let sourceRequestCount = 0;
    let targetRequestCount = 0;
    const { store } = await createFixtureServer({
      source: (_request, response) => {
        sourceRequestCount += 1;
        respond(response, { rows: [], total: 0 });
      },
      target: (_request, response) => {
        targetRequestCount += 1;
        respond(response, { rows: [], total: 0 });
      }
    });

    await store.update((config) => {
      config.environments.target!.tenantCode = "tenant-a";
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "sync",
          "feature",
          "--source",
          "source",
          "--target",
          "target"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(sourceRequestCount).toBe(0);
    expect(targetRequestCount).toBe(0);

    await store.update((config) => {
      config.environments.source!.tenantCode = "tenant-a";
      config.environments.target!.tenantCode = "global";
    });
    sourceRequestCount = 0;
    targetRequestCount = 0;

    await expect(
      createProgram(store).parseAsync(
        [
          "sync",
          "feature",
          "--source",
          "source",
          "--target",
          "target"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    expect(sourceRequestCount).toBe(0);
    expect(targetRequestCount).toBe(0);
  });
});

async function createFixtureServer(
  handlers: Record<
    "source" | "target",
    (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  >
): Promise<{ store: ConfigStore }> {
  const urls: Record<string, string> = {};
  for (const name of ["source", "target"] as const) {
    const server = createServer((request, response) => void handlers[name](request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }
    urls[name] = `http://127.0.0.1:${address.port}`;
  }
  const directory = await mkdtemp(join(tmpdir(), "eadp-resource-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: "source",
    environments: {
      source: { baseUrl: urls.source!, token: "source-secret", tenantCode: "global" },
      target: { baseUrl: urls.target!, token: "target-secret", tenantCode: "global" }
    }
  });
  return { store };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function captureOutput(): { text: () => string } {
  let value = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    value += String(chunk);
    return true;
  });
  return { text: () => value };
}

function parseNdjson(value: string): Array<Record<string, any>> {
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) : undefined;
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      success: status >= 200 && status < 300,
      message: status >= 400 ? "not found" : "ok",
      data
    })
  );
}
