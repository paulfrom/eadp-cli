import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  EXECUTOR_CODE_FIELDS,
  listExecutorCandidates,
  resolveExecutorBinding,
  type ExecutorBinding
} from "../src/domains/bpm-flow-graph/executor-resolver.js";
import {
  createResourceClient,
  type ResourceClient,
  type ResourceRecord
} from "../src/resource/core/client.js";
import {
  cleanupAll,
  createMockServer,
  eadpPage,
  trackServer,
  type MockEadpServer
} from "./helpers/index.js";

const EMPLOYEE_PATH = "/api-gateway/sei-basic/employee/findByPage";
const POSITION_PATH = "/api-gateway/sei-bpm/conBasicInterface/getPositionFindByPage";
const POSITION_CATEGORY_PATH = "/api-gateway/sei-bpm/conBasicInterface/getListPositionCategory";
const DECLARED_PATHS = [EMPLOYEE_PATH, POSITION_PATH, POSITION_CATEGORY_PATH].sort();

interface ExecutorRows {
  employees: ResourceRecord[];
  positions: ResourceRecord[];
  positionCategories: ResourceRecord[];
}

const DEFAULT_ROWS: ExecutorRows = {
  employees: [
    { id: "employee-1", code: "E1001", userName: "张三", name: "Zhang San" },
    { id: "employee-2", code: "E1002", name: "李四" },
    { id: "employee-3", code: "E1003", userName: "张三丰" }
  ],
  positions: [
    { id: "position-1", code: "P1001", name: "项目经理" },
    { id: "position-2", code: "P1002", name: "项目助理" }
  ],
  positionCategories: [
    { id: "category-1", code: "PC01", name: "项目经理类别" }
  ]
};

afterEach(async () => {
  await cleanupAll();
});

describe("BPM 统一执行人解析", () => {
  it("按人员 userName/name/code、岗位与岗位类别 name/code 精确解析并映射 code 字段", async () => {
    const { client } = await setup();
    const person: ExecutorBinding = {
      bindingType: "Person",
      code: "E1001",
      name: "张三",
      sourceId: "employee-1"
    };
    const position: ExecutorBinding = {
      bindingType: "Position",
      code: "P1001",
      name: "项目经理",
      sourceId: "position-1"
    };
    const positionType: ExecutorBinding = {
      bindingType: "PositionType",
      code: "PC01",
      name: "项目经理类别",
      sourceId: "category-1"
    };
    const cases: Array<[string, ExecutorBinding, string]> = [
      ["张三", person, "employeeCodes"],
      ["Zhang San", person, "employeeCodes"],
      ["E1001", person, "employeeCodes"],
      ["项目经理", position, "positionCodes"],
      ["P1001", position, "positionCodes"],
      ["项目经理类别", positionType, "positionCategoryCodes"],
      ["PC01", positionType, "positionCategoryCodes"]
    ];

    for (const [query, expected, codeField] of cases) {
      const resolved = await resolveExecutorBinding(client, ` \t${query}\n`);
      expect(resolved).toEqual(expected);
      expect(EXECUTOR_CODE_FIELDS[resolved.bindingType]).toBe(codeField);
    }
  });

  it("不做子串或大小写模糊匹配", async () => {
    const { client, server } = await setup();

    expect(await listExecutorCandidates(client, "张")).toEqual([]);
    expect(await listExecutorCandidates(client, "e1001")).toEqual([]);
    expect(await listExecutorCandidates(client, "项目经理类")).toEqual([]);
    expectOnlyDeclaredPaths(server);
  });

  it("0 候选抛 EXECUTOR_NOT_FOUND，并保留空候选列表", async () => {
    const { client, server } = await setup();

    const error = await captureCliError(resolveExecutorBinding(client, " 不存在 "));
    expect(error).toMatchObject({
      code: "EXECUTOR_NOT_FOUND",
      candidates: [],
      detail: { query: "不存在", candidates: [] }
    });
    expect(error.message).toContain("精确匹配");
    expectOnlyDeclaredPaths(server);
  });

  it("三类同查后才判断唯一性，多候选错误同时提供字符串与结构化候选", async () => {
    const { client, server } = await setup({
      employees: [{ id: "employee-shared", code: "E-SHARED", userName: "共享" }],
      positions: [{ id: "position-shared", code: "P-SHARED", name: "共享" }],
      positionCategories: [{ id: "category-shared", code: "PC-SHARED", name: "共享" }]
    });

    const error = await captureCliError(resolveExecutorBinding(client, "共享"));
    expect(error).toMatchObject({
      code: "EXECUTOR_AMBIGUOUS",
      candidates: [
        "Person:共享(E-SHARED)",
        "Position:共享(P-SHARED)",
        "PositionType:共享(PC-SHARED)"
      ],
      detail: {
        query: "共享",
        candidates: [
          {
            bindingType: "Person",
            code: "E-SHARED",
            name: "共享",
            sourceId: "employee-shared"
          },
          {
            bindingType: "Position",
            code: "P-SHARED",
            name: "共享",
            sourceId: "position-shared"
          },
          {
            bindingType: "PositionType",
            code: "PC-SHARED",
            name: "共享",
            sourceId: "category-shared"
          }
        ]
      }
    });
    expectOnlyDeclaredPaths(server);
  });

  it("同类型同名记录仍保留为多个候选", async () => {
    const { client } = await setup({
      employees: [
        { id: "employee-a", code: "E-A", userName: "同名" },
        { id: "employee-b", code: "E-B", userName: "同名" }
      ],
      positions: [],
      positionCategories: []
    });

    const error = await captureCliError(resolveExecutorBinding(client, "同名"));
    expect(error.code).toBe("EXECUTOR_AMBIGUOUS");
    expect(error.candidates).toEqual(["Person:同名(E-A)", "Person:同名(E-B)"]);
  });

  it("空白 query 按 0 候选处理且不访问远端", async () => {
    const { client, server } = await setup();

    expect(await listExecutorCandidates(client, " \n ")).toEqual([]);
    const error = await captureCliError(resolveExecutorBinding(client, "\t"));
    expect(error).toMatchObject({
      code: "EXECUTOR_NOT_FOUND",
      candidates: [],
      detail: { query: "", candidates: [] }
    });
    expect(server.requests).toHaveLength(0);
  });

  it("本地过滤覆盖岗位后续分页", async () => {
    const positions = Array.from({ length: 500 }, (_, index) => ({
      id: `position-${index}`,
      code: `P${String(index).padStart(4, "0")}`,
      name: `岗位${index}`
    }));
    positions.push({ id: "position-500", code: "P0500", name: "目标岗位" });
    const { client, server } = await setup({
      employees: [],
      positions,
      positionCategories: []
    });

    expect(await resolveExecutorBinding(client, "P0500")).toEqual({
      bindingType: "Position",
      code: "P0500",
      name: "目标岗位",
      sourceId: "position-500"
    });
    const positionPages = server.requests
      .filter((request) => request.path === POSITION_PATH)
      .map((request) => (request.body as {
        pageInfo: { page: number; rows: number };
      }).pageInfo);
    expect(positionPages).toEqual([
      { page: 1, rows: 500 },
      { page: 2, rows: 500 }
    ]);
    expectOnlyDeclaredPaths(server);
  });
});

async function setup(rows: Partial<ExecutorRows> = {}): Promise<{
  client: ResourceClient;
  server: MockEadpServer;
}> {
  const state: ExecutorRows = {
    employees: rows.employees ?? DEFAULT_ROWS.employees,
    positions: rows.positions ?? DEFAULT_ROWS.positions,
    positionCategories: rows.positionCategories ?? DEFAULT_ROWS.positionCategories
  };
  const server = createMockServer();
  trackServer(server);
  server.onEndsWith("/employee/findByPage", (context) => {
    context.json(pageFor(context.body, state.employees));
  });
  server.onEndsWith("/conBasicInterface/getPositionFindByPage", (context) => {
    context.json(pageFor(context.body, state.positions));
  });
  server.onEndsWith("/conBasicInterface/getListPositionCategory", (context) => {
    context.json(state.positionCategories);
  });
  const client = createResourceClient({
    baseUrl: await server.baseUrl(),
    service: "sei-bpm",
    token: "executor-resolver-test"
  });
  return { client, server };
}

function pageFor<T>(body: unknown, rows: T[]): ReturnType<typeof eadpPage<T>> {
  const pageInfo = typeof body === "object" && body !== null &&
      "pageInfo" in body &&
      typeof body.pageInfo === "object" && body.pageInfo !== null &&
      "page" in body.pageInfo && "rows" in body.pageInfo
    ? body.pageInfo as { page: unknown; rows: unknown }
    : undefined;
  const page = typeof pageInfo?.page === "number" ? pageInfo.page : 1;
  const pageSize = typeof pageInfo?.rows === "number" ? pageInfo.rows : 500;
  const start = (page - 1) * pageSize;
  return eadpPage(rows.slice(start, start + pageSize), {
    page,
    records: rows.length,
    total: rows.length === 0 ? 0 : Math.ceil(rows.length / pageSize)
  });
}

function expectOnlyDeclaredPaths(server: MockEadpServer): void {
  expect([...new Set(server.requests.map((request) => request.path))].sort())
    .toEqual(DECLARED_PATHS);
  expect(server.requests.every((request) => request.method === "POST")).toBe(true);
}

async function captureCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("预期命令抛出 CliError，但实际成功");
}
