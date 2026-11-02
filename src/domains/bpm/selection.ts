import { CliError } from "../../errors.js";

type RecordValue = Record<string, unknown>;

/**
 * Resolve one BPM flow type by its own code/name or by its business entity's
 * code/name. Both `bpm` and `bpm-flow-graph` must resolve the selector the same
 * way so the two migration entries always target the same flow.
 */
export function selectFlow(
  flows: RecordValue[],
  entities: RecordValue[],
  selector: string
): RecordValue {
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = flows.filter((flow) => {
    if (sameText(flow.code, normalized) || sameText(flow.name, normalized)) return true;
    const entity = entities.find((item) => item.id === flow.businessEntityId);
    return entity !== undefined && (sameText(entity.code, normalized) || sameText(entity.name, normalized));
  });
  if (matches.length === 0) throw new CliError(`源环境未找到 BPM 流程：${selector}`);
  if (matches.length > 1) throw new CliError(`源环境 BPM 流程不唯一：${selector}（匹配 ${matches.length} 条）`);
  return matches[0]!;
}

function sameText(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase();
}
