import type { ResourceRecord } from "../../resource/core/client.js";

export interface GraphSize {
  nodes: number;
  edges: number;
}

export interface GraphValueDifference {
  path: string;
  local: unknown;
  remote: unknown;
}

export interface CanonicalGraphDiff {
  equal: boolean;
  local: GraphSize;
  remote: GraphSize;
  differenceCount: number;
  /** Bounded terminal-friendly list; differenceCount remains authoritative. */
  differences: GraphValueDifference[];
}

export function graphSize(value: unknown): GraphSize {
  const process = isRecord(value) && isRecord(value.process) ? value.process : undefined;
  const nodes = process && isRecord(process.nodes) ? process.nodes : undefined;
  if (!nodes) return { nodes: 0, edges: 0 };
  let edges = 0;
  for (const node of Object.values(nodes)) {
    if (isRecord(node) && Array.isArray(node.target)) edges += node.target.length;
  }
  return { nodes: Object.keys(nodes).length, edges };
}

export function diffCanonicalGraphs(
  localCanonical: string,
  remoteCanonical: string,
  limit = 30
): CanonicalGraphDiff {
  const local = parse(localCanonical);
  const remote = parse(remoteCanonical);
  const differences: GraphValueDifference[] = [];
  let differenceCount = 0;
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        visit(index < left.length ? left[index] : MISSING, index < right.length ? right[index] : MISSING,
          `${path}[${index}]`);
      }
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        visit(key in left ? left[key] : MISSING, key in right ? right[key] : MISSING,
          path ? `${path}.${key}` : key);
      }
      return;
    }
    differenceCount += 1;
    if (differences.length < limit) {
      differences.push({
        path: path || "$",
        local: left === MISSING ? "<缺失>" : left,
        remote: right === MISSING ? "<缺失>" : right
      });
    }
  };
  visit(local, remote, "");
  return {
    equal: differenceCount === 0,
    local: graphSize(local),
    remote: graphSize(remote),
    differenceCount,
    differences
  };
}

const MISSING = Symbol("missing");

function parse(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
