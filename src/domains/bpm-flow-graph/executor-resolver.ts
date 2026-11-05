import { CliError } from "../../errors.js";
import { readAllPages } from "../../http/pagination.js";
import {
  isRecord,
  type ResourceClient,
  type ResourceRecord
} from "../../resource/core/client.js";

const POSITIONS_PATH = "conBasicInterface/getPositionFindByPage";
const POSITION_CATEGORIES_PATH = "conBasicInterface/getListPositionCategory";

export type ExecutorBindingType = "Person" | "Position" | "PositionType";

/** A portable executor identity; sourceId is informational and never portable. */
export interface ExecutorBinding {
  bindingType: ExecutorBindingType;
  code: string;
  name: string;
  sourceId?: string;
}

/** Canonical graph executor field used for each supported binding type. */
export const EXECUTOR_CODE_FIELDS = {
  Person: "employeeCodes",
  Position: "positionCodes",
  PositionType: "positionCategoryCodes"
} as const;

/**
 * Find every exact person/position/position-category match in one environment.
 * Matching is deliberately case-sensitive after trimming: a code is not a
 * fuzzy search expression, and equally named records of different types must
 * remain visible as separate candidates.
 */
export async function listExecutorCandidates(
  client: ResourceClient,
  query: string
): Promise<ExecutorBinding[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery === "") return [];

  const basicClient = client.forService("sei-basic");
  const [employees, positions, positionCategories] = await Promise.all([
    basicClient.findByPage("employee").then((page) => page.rows),
    readPositions(client),
    readPositionCategories(client)
  ]);

  return [
    ...matchingCandidates(employees, "Person", normalizedQuery, ["userName", "name", "code"]),
    ...matchingCandidates(positions, "Position", normalizedQuery, ["name", "code"]),
    ...matchingCandidates(positionCategories, "PositionType", normalizedQuery, ["name", "code"])
  ];
}

/** Resolve exactly one portable executor binding or fail with all candidates. */
export async function resolveExecutorBinding(
  client: ResourceClient,
  query: string
): Promise<ExecutorBinding> {
  const normalizedQuery = query.trim();
  const candidates = await listExecutorCandidates(client, normalizedQuery);
  if (candidates.length === 1) return candidates[0]!;

  const notFound = candidates.length === 0;
  throw new CliError(
    notFound
      ? `未找到与 ${JSON.stringify(normalizedQuery)} 精确匹配的人员、岗位或岗位类别`
      : `执行人 ${JSON.stringify(normalizedQuery)} 匹配到 ${candidates.length} 个候选，请改用唯一 code`,
    1,
    {
      code: notFound ? "EXECUTOR_NOT_FOUND" : "EXECUTOR_AMBIGUOUS",
      candidates: candidates.map(formatCandidate),
      detail: {
        query: normalizedQuery,
        candidates: candidates.map((candidate) => ({ ...candidate }))
      }
    }
  );
}

function matchingCandidates(
  rows: ResourceRecord[],
  bindingType: ExecutorBindingType,
  query: string,
  matchFields: readonly string[]
): ExecutorBinding[] {
  const result: ExecutorBinding[] = [];
  for (const row of rows) {
    if (!matchFields.some((field) => text(row[field]) === query)) continue;
    const code = text(row.code);
    if (!code) continue;
    const name = bindingType === "Person"
      ? text(row.userName) ?? text(row.name) ?? code
      : text(row.name) ?? code;
    const sourceId = text(row.id);
    result.push({
      bindingType,
      code,
      name,
      ...(sourceId === undefined ? {} : { sourceId })
    });
  }
  return result;
}

function readPositions(client: ResourceClient): Promise<ResourceRecord[]> {
  return readAllPages({
    endpoint: POSITIONS_PATH,
    isItem: isRecord,
    fetchPage: (pageInfo) => client.invoke(POSITIONS_PATH, "POST", {
      pageInfo,
      filters: [],
      sortOrders: []
    })
  });
}

async function readPositionCategories(client: ResourceClient): Promise<ResourceRecord[]> {
  // This declared endpoint requires a JSON body even though it has no filters.
  const data = await client.invoke(POSITION_CATEGORIES_PATH, "POST", {});
  if (!Array.isArray(data)) {
    throw new CliError(`${POSITION_CATEGORIES_PATH} 返回格式无效`);
  }
  return data.filter(isRecord);
}

function formatCandidate(candidate: ExecutorBinding): string {
  return `${candidate.bindingType}:${candidate.name}(${candidate.code})`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
