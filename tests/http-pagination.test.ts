import { afterEach, describe, expect, it } from "vitest";
import { PermissionClient } from "../src/domains/permission/client.js";
import { EADP_PAGE_SIZE, readAllPages } from "../src/http/pagination.js";
import {
  cleanupAll,
  createFixture,
  createMockServer,
  eadpPage,
  runCommand,
  trackServer
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

describe("EADP 分页协议", () => {
  it("每次请求 500 条，按 total 页数读取并用 records 聚合", async () => {
    const firstRows = Array.from({ length: EADP_PAGE_SIZE }, (_, index) => ({ id: `a-${index}` }));
    const secondRows = [{ id: "b-500" }];
    const requests: Array<{ page: number; rows: number }> = [];
    const result = await readAllPages({
      endpoint: "demo/findByPage",
      isItem: isRecord,
      fetchPage: ({ page, rows }) => {
        requests.push({ page, rows });
        return Promise.resolve(page === 1
          ? eadpPage(firstRows, { page: 1, records: 501, total: 2 })
          : eadpPage(secondRows, { page: 2, records: 501, total: 2 }));
      }
    });

    expect(requests).toEqual([
      { page: 1, rows: EADP_PAGE_SIZE },
      { page: 2, rows: EADP_PAGE_SIZE }
    ]);
    expect(result).toHaveLength(501);
    expect(result.at(-1)).toEqual({ id: "b-500" });
  });

  it("空结果只请求第 1 页；精确 500 和 1000 条不多请求空页", async () => {
    const emptyRequests: Array<{ page: number; rows: number }> = [];
    const empty = await readAllPages({
      endpoint: "empty/findByPage",
      isItem: isRecord,
      fetchPage: (pageInfo) => {
        emptyRequests.push(pageInfo);
        return Promise.resolve(eadpPage([], { page: 1, records: 0, total: 0 }));
      }
    });
    expect(empty).toEqual([]);
    expect(emptyRequests).toEqual([{ page: 1, rows: EADP_PAGE_SIZE }]);

    for (const records of [500, 1000]) {
      const requests: Array<{ page: number; rows: number }> = [];
      const pages = Math.ceil(records / EADP_PAGE_SIZE);
      const result = await readAllPages({
        endpoint: `exact-${records}/findByPage`,
        isItem: isRecord,
        fetchPage: (pageInfo) => {
          requests.push(pageInfo);
          const rows = Array.from(
            { length: EADP_PAGE_SIZE },
            (_, index) => ({ id: `${pageInfo.page}-${index}` })
          );
          return Promise.resolve(eadpPage(rows, {
            page: pageInfo.page,
            records,
            total: pages
          }));
        }
      });
      expect(result).toHaveLength(records);
      expect(requests).toHaveLength(pages);
      expect(requests.every((request) => request.rows === EADP_PAGE_SIZE)).toBe(true);
    }
  });

  it("普通 resource 契约请求体使用 pageInfo.rows=500", async () => {
    const fixture = await createFixture();
    const bodies: Array<Record<string, unknown>> = [];
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      const body = context.body as Record<string, unknown>;
      bodies.push(body);
      const pageInfo = body.pageInfo as { page: number; rows: number };
      const rows = pageInfo.page === 1
        ? [{ code: "A", name: "A" }]
        : [];
      context.json(eadpPage(rows, { page: 1, records: 1, total: 1 }));
    });

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "feature", "--env", "source"
    ])) as { items: Array<Record<string, unknown>> };

    expect(output.items).toEqual([{ code: "A", name: "A" }]);
    expect(bodies).toHaveLength(1);
    expect((bodies[0]!.pageInfo as { page: number; rows: number }).rows).toBe(EADP_PAGE_SIZE);
  });

  it("permission quickSearch 也按 EADP 分页协议请求 500 条", async () => {
    const server = createMockServer();
    let body: Record<string, unknown> | undefined;
    server.onEndsWith("/employee/quickSearch", (context) => {
      body = context.body as Record<string, unknown>;
      context.json(eadpPage([{ id: "employee-1", userName: "张三" }]));
    });
    trackServer(server);
    const client = new PermissionClient({ baseUrl: await server.baseUrl() });
    const employees = await client.quickSearchEmployees("张三");

    expect(employees).toEqual([{ id: "employee-1", userName: "张三" }]);
    expect((body?.pageInfo as { page: number; rows: number }).rows).toBe(EADP_PAGE_SIZE);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
