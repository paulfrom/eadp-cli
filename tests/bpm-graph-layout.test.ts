import { describe, expect, it } from "vitest";
import type { GraphDraftFile } from "../src/domains/bpm-flow-graph/draft.js";
import { stableStringify } from "../src/domains/bpm-flow-graph/graph.js";
import {
  inspectGraphLayout,
  layoutGraphDraftFile
} from "../src/domains/bpm-flow-graph/layout.js";

type RecordValue = Record<string, unknown>;

function to(targetId: string, uel: unknown = {}): RecordValue {
  return { targetId, uel };
}

function task(id: string, x: number, y: number, target: RecordValue[] = []): RecordValue {
  return {
    id,
    type: "UserTask",
    nodeType: "Approve",
    name: id,
    x,
    y,
    target,
    nodeConfig: {}
  };
}

function event(
  id: string,
  type: "StartEvent" | "EndEvent",
  x: number,
  y: number,
  target: RecordValue[] = []
): RecordValue {
  return { id, type, name: id, x, y, target, nodeConfig: {} };
}

function gateway(id: string, x: number, y: number, target: RecordValue[]): RecordValue {
  return {
    id,
    type: "ExclusiveGateway",
    busType: "ExclusiveGateway",
    name: id,
    x,
    y,
    target,
    nodeConfig: {}
  };
}

function draftFile(nodes: RecordValue, name = "布局测试"): GraphDraftFile {
  return {
    kind: "eadp.bpm.graph.v1",
    flow: "TBS_PROJECT",
    graphs: [{
      name,
      graph: { process: { name, startUEL: {}, nodes } }
    }]
  };
}

function nodesOf(file: GraphDraftFile): RecordValue {
  const process = file.graphs[0]!.graph.process as RecordValue;
  return process.nodes as RecordValue;
}

function onlyMetrics(file: GraphDraftFile) {
  return inspectGraphLayout(file).graphs[0]!;
}

describe("bpm 图布局几何检查", () => {
  it("发现手工节点矩形重叠，并报告画布范围", () => {
    const file = draftFile({
      A: task("A", 0, 0),
      B: task("B", 80, 20),
      C: task("C", 500, 0)
    });
    expect(onlyMetrics(file)).toMatchObject({
      nodes: 3,
      edges: 0,
      throughNodeEdges: 0,
      crossingEdges: 0,
      overlappingNodes: 1,
      width: 660,
      height: 100
    });
  });

  it("发现 source-target 直线穿过中间节点", () => {
    const file = draftFile({
      A: task("A", 0, 0, [to("C")]),
      B: task("B", 280, 0),
      C: task("C", 600, 0)
    });
    expect(onlyMetrics(file)).toMatchObject({
      nodes: 3,
      edges: 1,
      throughNodeEdges: 1,
      crossingEdges: 0,
      overlappingNodes: 0
    });
  });

  it("发现不共享端点的真实线段交叉", () => {
    const file = draftFile({
      A: task("A", 0, 0, [to("B")]),
      B: task("B", 600, 400),
      C: task("C", 0, 400, [to("D")]),
      D: task("D", 600, 0)
    });
    expect(onlyMetrics(file)).toMatchObject({
      nodes: 4,
      edges: 2,
      crossingEdges: 1,
      overlappingNodes: 0
    });
  });

  it("忽略共享端点的边对，也不把共线重叠算作交叉", () => {
    const shared = draftFile({
      A: task("A", 0, 0, [to("B"), to("C")]),
      B: task("B", 600, 400),
      C: task("C", 600, 0)
    });
    expect(onlyMetrics(shared).crossingEdges).toBe(0);

    const collinear = draftFile({
      A: task("A", 0, 0, [to("D")]),
      B: task("B", 200, 0, [to("C")]),
      C: task("C", 400, 0),
      D: task("D", 600, 0)
    });
    expect(onlyMetrics(collinear).crossingEdges).toBe(0);
  });
});

describe("bpm 纯本地自动布局", () => {
  it("系统排他网关、条件审批分支和驳回回边布局后三项均为 0", () => {
    const file = draftFile({
      Start: event("Start", "StartEvent", 900, 900, [to("Apply")]),
      Apply: task("Apply", 0, 0, [to("Gateway")]),
      Gateway: gateway("Gateway", 20, 20, [
        to("Manager", { groovyUel: "#{amount <= 10000}" }),
        to("Director", { groovyUel: "#{amount > 10000}" }),
        to("End", { isDefault: true })
      ]),
      Manager: task("Manager", 40, 40, [
        to("End", { agree: true }),
        to("Apply", { agree: false, isReverse: true })
      ]),
      Director: task("Director", 60, 60, [
        to("End", { agree: true }),
        to("Apply", { agree: false, isReverse: true })
      ]),
      End: event("End", "EndEvent", 80, 80)
    }, "条件审批与驳回");
    const before = stableStringify(file);

    const laidOut = layoutGraphDraftFile(file);
    const metrics = onlyMetrics(laidOut);
    expect(metrics).toMatchObject({
      nodes: 6,
      edges: 9,
      throughNodeEdges: 0,
      crossingEdges: 0,
      overlappingNodes: 0
    });
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.height).toBeGreaterThan(0);
    expect(stableStringify(file)).toBe(before);

    const nodes = nodesOf(laidOut);
    const start = nodes.Start as RecordValue;
    const apply = nodes.Apply as RecordValue;
    const exclusive = nodes.Gateway as RecordValue;
    const manager = nodes.Manager as RecordValue;
    const director = nodes.Director as RecordValue;
    const end = nodes.End as RecordValue;
    expect(start.y).toBeLessThan(apply.y as number);
    expect(apply.y).toBeLessThan(exclusive.y as number);
    expect(exclusive.y).toBeLessThan(manager.y as number);
    expect(manager.y).toBe(director.y);
    expect(manager.y).toBeLessThan(end.y as number);
    expect(Math.abs((manager.x as number) - (director.x as number))).toBeGreaterThanOrEqual(280);

    // Coordinates depend on topology, not on the old coordinates; a second pass is idempotent.
    expect(stableStringify(layoutGraphDraftFile(laidOut))).toBe(stableStringify(laidOut));
  });

  it("局部修复跨层直达边穿节点，同时保留驳回路径的可读性", () => {
    const file = draftFile({
      Start: event("Start", "StartEvent", 0, 0, [to("Apply")]),
      Apply: task("Apply", 0, 0, [to("Gateway")]),
      Gateway: gateway("Gateway", 0, 0, [
        to("Manager", { groovyUel: "#{approved == true}" }),
        to("End", { isDefault: true })
      ]),
      Manager: task("Manager", 0, 0, [
        to("End", { agree: true }),
        to("Apply", { agree: false, isReverse: true })
      ]),
      End: event("End", "EndEvent", 0, 0)
    }, "跨层直达边");

    const metrics = onlyMetrics(layoutGraphDraftFile(file));
    expect(metrics).toMatchObject({
      nodes: 5,
      edges: 6,
      throughNodeEdges: 0,
      crossingEdges: 0,
      overlappingNodes: 0
    });
  });

  it("逐图返回指标，且不修改待检查的草稿", () => {
    const first = draftFile({ A: task("A", 0, 0) }, "第一张图");
    const second = draftFile({ B: task("B", 300, 200) }, "第二张图");
    const file: GraphDraftFile = {
      ...first,
      graphs: [first.graphs[0]!, second.graphs[0]!]
    };
    const before = stableStringify(file);
    const inspection = inspectGraphLayout(file);
    expect(inspection.flow).toBe("TBS_PROJECT");
    expect(inspection.graphs.map((graph) => graph.name)).toEqual(["第一张图", "第二张图"]);
    expect(inspection.graphs.map((graph) => graph.nodes)).toEqual([1, 1]);
    expect(stableStringify(file)).toBe(before);
  });
});
