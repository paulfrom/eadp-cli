import { CliError } from "../errors.js";

export interface PageInfo {
  page: number;
  rows: number;
}

export interface ReadAllPagesOptions<T> {
  endpoint: string;
  fetchPage: (pageInfo: PageInfo) => Promise<unknown>;
  isItem: (value: unknown) => value is T;
  pageSize?: number;
  maxPages?: number;
}

export async function readAllPages<T>(
  options: ReadAllPagesOptions<T>
): Promise<T[]> {
  const items: T[] = [];
  for await (const page of iteratePages(options)) {
    items.push(...page);
  }
  return items;
}

export async function* iteratePages<T>(
  options: ReadAllPagesOptions<T>
): AsyncGenerator<T[]> {
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 10_000;

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await options.fetchPage({ page, rows: pageSize });
    if (!isRecord(data) || !Array.isArray(data.rows)) {
      throw new CliError(`${options.endpoint} 返回格式无效`);
    }
    yield data.rows.filter(options.isItem);
    if (data.rows.length < pageSize) {
      return;
    }
  }

  throw new CliError(`${options.endpoint} 分页数量异常`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
