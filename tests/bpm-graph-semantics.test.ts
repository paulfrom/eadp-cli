import { describe, expect, it } from "vitest";
import { inspectCanonicalGraph } from "../src/domains/bpm-flow-graph/analysis.js";
import { stableStringify } from "../src/domains/bpm-flow-graph/graph.js";
import { BPM_GRAPH_GOLDEN_SAMPLE } from "../src/domains/bpm-flow-graph/golden.js";
import { mapGraphServerError } from "../src/domains/bpm-flow-graph/server-errors.js";
import { CliError } from "../src/errors.js";
import type { ResourceRecord } from "../src/resource/core/client.js";

type RecordValue = Record<string, unknown>;

function sample(): RecordValue {
  return JSON.parse(JSON.stringify(BPM_GRAPH_GOLDEN_SAMPLE.graphs[0]!.graph)) as RecordValue;
}

function nodes(graph: RecordValue): RecordValue {
  return (graph.process as RecordValue).nodes as RecordValue;
}

function inspect(graph: RecordValue) {
  return inspectCanonicalGraph(stableStringify(graph));
}

function designCodes(graph: RecordValue): string[] {
  return inspect(graph).designIssues.map((issue) => issue.code ?? "");
}

describe("bpm graph 语义校验", () => {
  it("golden sample 覆盖排他网关、条件边、默认边和显式驳回环，无新增语义问题", () => {
    const verdict = inspect(sample());
    expect(verdict.designIssues.map((issue) => issue.code)).not.toEqual(
      expect.arrayContaining([
        "CONDITION_LABEL_MISSING",
        "CONDITION_OVERLAP",
        "CONDITION_COVERAGE_INCOMPLETE",
        "NODE_UNREACHABLE",
        "EDGE_DANGLING",
        "GRAPH_CYCLE_UNEXPECTED",
        "EDGE_ID_DUPLICATE"
      ])
    );
  });

  it("表达式边 uel.name 空白时定位具体边并计入 designIssues", () => {
    const graph = sample();
    const gateway = nodes(graph).ExclusiveGateway_1 as RecordValue;
    ((gateway.target as RecordValue[])[0]!.uel as RecordValue).name = "  ";
    const issue = inspect(graph).designIssues.find((item) => item.code === "CONDITION_LABEL_MISSING");
    expect(issue).toMatchObject({
      scope: "edge",
      nodeId: "ExclusiveGateway_1",
      edgeId: "ExclusiveGateway_1->Approve_1[0]",
      jsonPath: "process.nodes.ExclusiveGateway_1.target[0].uel.name"
    });
    expect(issue?.message).toContain("ExclusiveGateway_1 -> Approve_1");
  });

  it("检测同一排他网关可重叠的条件区间", () => {
    const graph = sample();
    const gateway = nodes(graph).ExclusiveGateway_1 as RecordValue;
    (gateway.target as RecordValue[]).push({
      targetId: "EndEvent_1",
      uel: { name: "五百以上", groovyUel: "#{amount>500}", logicUel: "金额>500" }
    });
    const issue = inspect(graph).designIssues.find((item) => item.code === "CONDITION_OVERLAP");
    expect(issue?.message).toContain("ExclusiveGateway_1->Approve_1[0]");
    expect(issue?.message).toContain("ExclusiveGateway_1->EndEvent_1[2]");
  });

  it("检测条件全集缺口，并认可互补条件覆盖全集", () => {
    const graph = sample();
    const gateway = nodes(graph).ExclusiveGateway_1 as RecordValue;
    const targets = gateway.target as RecordValue[];
    (targets[0]!.uel as RecordValue).groovyUel = "#{amount>1000}";
    targets[1]!.uel = { name: "小于一千", groovyUel: "#{amount<1000}", logicUel: "金额<1000" };
    expect(designCodes(graph)).toContain("CONDITION_COVERAGE_INCOMPLETE");

    (targets[1]!.uel as RecordValue).groovyUel = "#{amount<=1000}";
    expect(designCodes(graph)).not.toContain("CONDITION_COVERAGE_INCOMPLETE");
  });

  it("不可达节点、悬空边、非预期环和重复边 id 均计入 designIssues", () => {
    const graph = sample();
    const graphNodes = nodes(graph);
    graphNodes.EndEvent_2 = {
      id: "EndEvent_2", type: "EndEvent", name: "孤立结束", target: [], nodeConfig: {}
    };
    (graphNodes.StartEvent_1 as RecordValue).target = [
      { targetId: "Normal_1", uel: {} },
      { id: "edge-shared", targetId: "Missing_1", uel: {} }
    ];
    (graphNodes.Normal_1 as RecordValue).target = [
      { id: "edge-shared", targetId: "ExclusiveGateway_1", uel: {} },
      { targetId: "Approve_1", uel: {} }
    ];
    (graphNodes.Approve_1 as RecordValue).target = [
      ...((graphNodes.Approve_1 as RecordValue).target as RecordValue[]),
      { targetId: "Normal_1", uel: { name: "误接回边" } }
    ];
    const codes = designCodes(graph);
    expect(codes).toEqual(expect.arrayContaining([
      "NODE_UNREACHABLE",
      "EDGE_DANGLING",
      "GRAPH_CYCLE_UNEXPECTED",
      "EDGE_ID_DUPLICATE"
    ]));
    const dangling = inspect(graph).designIssues.find((issue) => issue.code === "EDGE_DANGLING");
    expect(dangling?.edgeId).toBe("edge-shared");
  });
});

describe("bpm graph 服务端异常定位", () => {
  function mapped(graph: RecordValue, message: string): CliError {
    const result = mapGraphServerError(
      new CliError(`EADP 请求失败：${message}`, 1, { code: "EADP_REQUEST_FAILED" }),
      { name: "金额审批示例", canonical: stableStringify(graph) }
    );
    expect(result).toBeInstanceOf(CliError);
    return result as CliError;
  }

  it("定位 nodeConfig.otherParams.autoExecuteUser 的对象类型与实际值", () => {
    const graph = sample();
    const approve = nodes(graph).Approve_1 as RecordValue;
    (approve.nodeConfig as RecordValue).otherParams = { autoExecuteUser: "张三" };
    const error = mapped(graph, "Cannot deserialize autoExecuteUser");
    expect(error.code).toBe("GRAPH_SERVER_VALIDATION_FAILED");
    expect(error.message).toContain("节点 发起人审批(Approve_1)");
    expect(error.message).toContain("process.nodes.Approve_1.nodeConfig.otherParams.autoExecuteUser");
    expect(error.message).toContain("期望类型 object");
    expect(error.message).toContain('实际值 "张三"');
    expect(error.message).toContain("修复提示");
  });

  it("定位 notify.before.notifySelfDefinition.type 的数组类型", () => {
    const graph = sample();
    const approve = nodes(graph).Approve_1 as RecordValue;
    (approve.nodeConfig as RecordValue).notify = {
      before: { notifySelfDefinition: { type: "MESSAGE" } }, after: {}
    };
    const error = mapped(graph, "notifySelfDefinition.type 期望集合");
    expect(error.message).toContain("nodeConfig.notify.before.notifySelfDefinition.type");
    expect(error.message).toContain("array<string>");
    expect(error.message).toContain('实际值 "MESSAGE"');
  });

  it("定位 process.beforeStartServiceUrl 的字符串类型", () => {
    const graph = sample();
    (graph.process as RecordValue).beforeStartServiceUrl = { id: "interface-1" };
    const error = mapped(graph, "beforeStartServiceUrl 类型错误");
    expect(error.message).toContain("流程 金额审批示例 字段 process.beforeStartServiceUrl");
    expect(error.message).toContain("期望类型 string");
    expect(error.message).toContain("EVENT");
  });

  it("定位重复 edge id 的两条边并给出唯一性修复提示", () => {
    const graph = sample();
    const gateway = nodes(graph).ExclusiveGateway_1 as RecordValue;
    const targets = gateway.target as RecordValue[];
    targets[0]!.id = "edge-duplicate";
    targets[1]!.id = "edge-duplicate";
    const error = mapped(graph, "Duplicate edge id: edge-duplicate");
    expect(error.code).toBe("GRAPH_SERVER_VALIDATION_FAILED");
    expect(error.message).toContain("unique string");
    expect(error.message).toContain("edge-duplicate");
    expect(error.message).toContain("target[0].id");
    expect(error.message).toContain("target[1].id");
  });
});
