import { CliError } from "../errors.js";

/** EADP PageInfo.rows is intentionally fixed for every paged request. */
export const EADP_PAGE_SIZE = 500;

export interface PageInfo {
  page: number;
  rows: typeof EADP_PAGE_SIZE;
}

export interface EadpPage<T> {
  page: number;
  records: number;
  total: number;
  summaryInfo: unknown;
  rows: T[];
}

export interface ReadAllPagesOptions<T> {
  endpoint: string;
  fetchPage: (pageInfo: PageInfo) => Promise<unknown>;
  isItem: (value: unknown) => value is T;
  /** Upper bound against a broken total that would otherwise loop forever. */
  maxPages?: number;
  /** Response rows member; EADP uses `rows`, contracts may restate it. */
  rowsField?: string;
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
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new CliError(`${options.endpoint} 分页上限无效`);
  }

  let expectedRecords: number | undefined;
  let expectedTotal: number | undefined;
  let accumulatedRows = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const data = await options.fetchPage({ page: pageNumber, rows: EADP_PAGE_SIZE });
    const page = parseEadpPage(data, options.endpoint, options.isItem, options.rowsField);

    if (page.page !== pageNumber) {
      throw new CliError(
        `${options.endpoint} 返回页码 ${page.page}，但请求的是第 ${pageNumber} 页`
      );
    }
    if (expectedRecords === undefined) {
      expectedRecords = page.records;
      expectedTotal = page.total;
    } else if (page.records !== expectedRecords || page.total !== expectedTotal) {
      throw new CliError(`${options.endpoint} 分页总数在不同页面之间不一致`);
    }

    validateEadpPageBounds(page, options.endpoint, pageNumber, accumulatedRows);
    if (page.total === 0) {
      return;
    }
    const nextAccumulatedRows = accumulatedRows + page.rows.length;
    if (pageNumber === page.total) {
      if (nextAccumulatedRows !== page.records) {
        throw new CliError(
          `${options.endpoint} 分页记录不完整：已读取 ${nextAccumulatedRows}/${page.records} 条`
        );
      }
      yield page.rows;
      return;
    }
    accumulatedRows = nextAccumulatedRows;
    yield page.rows;
  }

  throw new CliError(`${options.endpoint} 分页数量异常`);
}

/**
 * Parse the inner EADP `data` page. The outer success envelope is handled by
 * the HTTP clients before this function is called.
 */
export function parseEadpPage<T>(
  value: unknown,
  endpoint: string,
  isItem: (value: unknown) => value is T,
  rowsField = "rows"
): EadpPage<T> {
  if (!isRecord(value)) {
    throw new CliError(`${endpoint} 返回格式无效：分页 data 必须是对象`);
  }
  const page = readNonNegativeInteger(value.page, `${endpoint} page`, true);
  const records = readNonNegativeInteger(value.records, `${endpoint} records`);
  const total = readNonNegativeInteger(value.total, `${endpoint} total`);
  if (!("summaryInfo" in value)) {
    throw new CliError(`${endpoint} 返回格式无效：缺少 summaryInfo`);
  }
  if (!rowsField.trim() || !Array.isArray(value[rowsField])) {
    throw new CliError(`${endpoint} 返回格式无效：缺少 ${rowsField}`);
  }
  const rows = value[rowsField] as unknown[];
  const invalidIndex = rows.findIndex((row) => !isItem(row));
  if (invalidIndex >= 0) {
    throw new CliError(`${endpoint} 返回格式无效：${rowsField}[${invalidIndex}] 不是记录`);
  }
  if (rows.length > EADP_PAGE_SIZE) {
    throw new CliError(
      `${endpoint} 第 ${page} 页返回 ${rows.length} 条，超过 ${EADP_PAGE_SIZE} 条上限`
    );
  }

  return {
    page,
    records,
    total,
    summaryInfo: value.summaryInfo,
    rows: rows as T[]
  };
}

function validateEadpPageBounds(
  page: EadpPage<unknown>,
  endpoint: string,
  pageNumber: number,
  accumulatedRows: number
): void {
  const expectedTotal = page.records === 0
    ? 0
    : Math.ceil(page.records / EADP_PAGE_SIZE);
  if (page.total !== expectedTotal) {
    throw new CliError(
      `${endpoint} total 页数 ${page.total} 与 records=${page.records} 不一致`
    );
  }
  if (page.total === 0) {
    if (pageNumber !== 1 || page.page !== 1 || page.records !== 0 || page.rows.length !== 0) {
      throw new CliError(`${endpoint} 空分页响应的 page、records 或 rows 不一致`);
    }
    return;
  }
  if (pageNumber > page.total) {
    throw new CliError(`${endpoint} 返回页码超过 total 页数`);
  }
  if (pageNumber < page.total && page.rows.length !== EADP_PAGE_SIZE) {
    throw new CliError(
      `${endpoint} 第 ${pageNumber} 页提前结束：返回 ${page.rows.length}/${EADP_PAGE_SIZE} 条`
    );
  }
  if (accumulatedRows > page.records) {
    throw new CliError(`${endpoint} 已读取记录数超过 records=${page.records}`);
  }
}

function readNonNegativeInteger(
  value: unknown,
  field: string,
  positive = false
): number {
  if (!Number.isInteger(value) || (positive ? (value as number) < 1 : (value as number) < 0)) {
    throw new CliError(`${field} 必须是${positive ? "正" : "非负"}整数`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
