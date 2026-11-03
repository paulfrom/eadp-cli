import { describe, expect, it } from "vitest";
import { inspectCanonicalGraph } from "../src/domains/bpm-flow-graph/analysis.js";
import {
  CATALOG_VERSION,
  describeNodeRule,
  listNodeRules,
  resolveNodeKind
} from "../src/domains/bpm-flow-graph/node-catalog.js";

type RecordValue = Record<string, unknown>;

function page(): RecordValue {
  return { pageUrl: "/tbs/approve", workPageName: "审批页" };
}

function personExecutor(): RecordValue[] {
  return [{ type: "Person", userType: "Person", employeeCodes: ["E1001"] }];
}

function canonicalGraph(task: RecordValue, gateway?: RecordValue): string {
  const nodes: RecordValue = {
    StartEvent_1: {
      id: "StartEvent_1",
      type: "StartEvent",
      name: "开始",
      target: [{ targetId: gateway ? "Gateway_2" : "UserTask_2", uel: {} }],
      nodeConfig: {}
    },
    UserTask_2: {
      id: "UserTask_2",
      type: "UserTask",
      nodeType: "Approve",
      name: "经理审批",
      target: [{ targetId: "EndEvent_3", uel: { agree: true } }],
      nodeConfig: {
        normal: page(),
        executor: personExecutor(),
        event: {},
        notify: null
      },
      ...task
    },
    EndEvent_3: {
      id: "EndEvent_3",
      type: "EndEvent",
      name: "结束",
      target: [],
      nodeConfig: { notify: null }
    }
  };
  if (gateway) {
    nodes.Gateway_2 = gateway;
    (nodes.StartEvent_1 as RecordValue).target = [{ targetId: "Gateway_2", uel: {} }];
    (nodes.UserTask_2 as RecordValue).target = [];
    (nodes.UserTask_2 as RecordValue).nodeType = "Normal";
  }
  return JSON.stringify({
    orgCode: "1001",
    process: { name: "项目立项", startUEL: {}, nodes }
  });
}

describe("bpm 节点能力表", () => {
  it("按 type + nodeType/busType 解析节点 kind", () => {
    expect(resolveNodeKind({ type: "UserTask", nodeType: "Approve" })).toMatchObject({
      kind: "Approve",
      rule: { engineType: "UserTask", discriminator: "nodeType" }
    });
    expect(resolveNodeKind({
      type: "ExclusiveGateway",
      busType: "ManualExclusiveGateway"
    })).toMatchObject({
      kind: "ManualExclusiveGateway",
      rule: { engineType: "ExclusiveGateway" }
    });
    expect(resolveNodeKind({ type: "EndEvent" })).toMatchObject({
      kind: "EndEvent",
      rule: { group: "event" }
    });
  });

  it("拒绝把 UI kind 直接写在 type 上，并给出正确写法", () => {
    const manual = resolveNodeKind({ type: "ManualExclusiveGateway" });
    expect(manual.rule).toBeUndefined();
    expect(manual.issues[0]).toMatchObject({
      code: "NODE_KIND_MISMATCH",
      message: expect.stringContaining("ManualExclusiveGateway")
    });
    expect(manual.issues[0]?.fix).toContain("busType=ManualExclusiveGateway");

    const approve = resolveNodeKind({ type: "Approve" });
    expect(approve.rule).toBeUndefined();
    expect(approve.issues[0]?.fix).toContain("nodeType=Approve");
  });

  it("目录自包含，且历史类型只在显式包含时出现", () => {
    expect(CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(listNodeRules()).toHaveLength(19);
    expect(listNodeRules({ includeLegacy: true })).toHaveLength(22);
    expect(listNodeRules().some((rule) => rule.legacy)).toBe(false);
    expect(listNodeRules({ includeLegacy: true }).some((rule) => rule.kind === "MailTask")).toBe(true);
    expect(describeNodeRule(listNodeRules({ kind: "Approve" })[0]!)).toMatchObject({
      kind: "Approve",
      engineType: "UserTask",
      edges: { minOut: 2, maxOut: 2, agreeEdge: true }
    });
  });
});

describe("bpm 节点设计级校验", () => {
  it("审批只有 1 条出口：可迁移，但 designValid=false", () => {
    const verdict = inspectCanonicalGraph(canonicalGraph({
      target: [{ targetId: "EndEvent_3", uel: {} }]
    }));
    expect(verdict.blockingIssues).toHaveLength(0);
    expect(verdict.designIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NODE_EXIT_COUNT", "NODE_AGREE_EDGE"])
    );
    expect(verdict.designIssues.every((issue) => issue.nodeId === "UserTask_2")).toBe(true);
    expect(verdict.warnings.map((issue) => issue.code)).toContain("NODE_REVERSE_NOT_SET");
  });

  it("审批 2 条出口且 1 条同意线：designValid=true", () => {
    const verdict = inspectCanonicalGraph(canonicalGraph({
      target: [
        { targetId: "EndEvent_3", uel: { agree: true } },
        { targetId: "EndEvent_3", uel: { agree: false, isReverse: true } }
      ]
    }));
    expect(verdict.blockingIssues).toHaveLength(0);
    expect(verdict.designIssues).toHaveLength(0);
  });

  it("系统排他网关要求默认路径，人工排他网关不要求", () => {
    const system = inspectCanonicalGraph(canonicalGraph({}, {
      id: "Gateway_2",
      type: "ExclusiveGateway",
      busType: "ExclusiveGateway",
      name: "系统网关",
      target: [
        { targetId: "EndEvent_3", uel: {} },
        { targetId: "EndEvent_3", uel: { isReverse: true } }
      ],
      nodeConfig: {}
    }));
    expect(system.designIssues.map((issue) => issue.code)).toContain("NODE_DEFAULT_EDGE");

    const manual = inspectCanonicalGraph(canonicalGraph({}, {
      id: "Gateway_2",
      type: "ExclusiveGateway",
      busType: "ManualExclusiveGateway",
      name: "人工网关",
      target: [
        { targetId: "EndEvent_3", uel: { isReverse: true } },
        { targetId: "EndEvent_3", uel: {} }
      ],
      nodeConfig: {}
    }));
    expect(manual.designIssues.map((issue) => issue.code)).not.toContain("NODE_DEFAULT_EDGE");
  });

  it("缺少执行人/工作界面是阻塞项，缺服务事件是设计项", () => {
    const graph = JSON.parse(canonicalGraph({
      nodeConfig: { normal: { name: "经理审批" }, event: {}, notify: null }
    })) as RecordValue;
    const verdict = inspectCanonicalGraph(JSON.stringify(graph));
    expect(verdict.blockingIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NODE_EXECUTOR_MISSING", "NODE_PAGE_MISSING"])
    );

    const task = JSON.parse(canonicalGraph({
      nodeType: "ReceiveTask",
      type: "ReceiveTask",
      nodeConfig: { normal: { name: "触发" }, event: {}, notify: null }
    })) as RecordValue;
    const process = task.process as RecordValue;
    const nodes = process.nodes as RecordValue;
    delete (nodes.UserTask_2 as RecordValue).nodeType;
    (nodes.UserTask_2 as RecordValue).type = "ReceiveTask";
    (nodes.UserTask_2 as RecordValue).id = "UserTask_2";
    const receive = inspectCanonicalGraph(JSON.stringify(task));
    expect(receive.designIssues.map((issue) => issue.code)).toContain("NODE_SERVICE_MISSING");
  });

  it("历史类型只产生 warning，不阻塞迁移", () => {
    const graph = JSON.parse(canonicalGraph({})) as RecordValue;
    const process = graph.process as RecordValue;
    const nodes = process.nodes as RecordValue;
    const task = nodes.UserTask_2 as RecordValue;
    task.type = "MailTask";
    task.nodeType = "MailTask";
    delete task.nodeConfig;
    const verdict = inspectCanonicalGraph(JSON.stringify(graph));
    expect(verdict.blockingIssues).toHaveLength(0);
    expect(verdict.warnings.map((issue) => issue.code)).toContain("NODE_LEGACY_KIND");
  });
});
