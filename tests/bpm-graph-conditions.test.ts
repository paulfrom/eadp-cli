/**
 * bpm graph 系统判定条件：
 * - `graph conditions` 只读列出目标环境业务实体发布的条件字段并给出网关优先级；
 * - `validate` 按同一份清单校验网关条件，识别系统未提供的变量与中文条件；
 * - 表达式解析只取业务变量，不误伤平台变量与字面量。
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeGraphConditions,
  buildConditionExpression,
  extractConditionVariables,
  extractUnknownPropertyNames
} from "../src/domains/bpm-flow-graph/conditions.js";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  expectNoWrites,
  runCommand,
  runExpectError,
  type MockEadpServer
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

type RecordValue = Record<string, unknown>;

const CONDITION_PROPERTIES: RecordValue[] = [
  { code: "fileType", name: "文件类型", initValue: null, remark: "资料类型" },
  { code: "approvalType", name: "审批类型", initValue: null, remark: null },
  { code: "customerCreditAmount", name: "累计授信金额（客户）", initValue: 0, remark: null }
];

function registerRoutes(server: MockEadpServer): void {
  server.onEndsWith("/conFlowType/findByPage", (context) => {
    context.json(eadpPage([
      { id: "flow-1", code: "TBS_PROJECT", name: "项目立项流程", businessEntityId: "entity-1" }
    ]));
  });
  server.onEndsWith("/conBusinessEntity/findByPage", (context) => {
    context.json(eadpPage([
      { id: "entity-1", code: "com.example.Project", name: "项目实体" }
    ]));
  });
  server.onEndsWith("/conBusinessEntity/getConditionPropertiesExplain", (context) => {
    context.json(CONDITION_PROPERTIES);
  });
  server.onEndsWith("/conBusinessEntity/validateExpression", (context) => {
    const body = context.body as RecordValue;
    if (body.expression === "#{fileType==}") {
      context.raw({ success: false, message: "表达式语法错误", data: null });
      return;
    }
    if (body.expression === "#{fileType!=}") {
      context.fail("validation unavailable", 500);
      return;
    }
    context.json(null);
  });
  server.onEndsWith("/conPage/findByPage", (context) => {
    context.json(eadpPage([]));
  });
  server.onEndsWith("/conInterface/findByPage", (context) => {
    context.json(eadpPage([]));
  });
  server.onEndsWith("/defFlowDefinition/findByPage", (context) => {
    context.json(eadpPage([]));
  });
}

async function setup(): Promise<Awaited<ReturnType<typeof createFixture>>> {
  const fixture = await createFixture({
    environments: [{ name: "target", tenantCode: "tenant-a", token: "target-token" }]
  });
  registerRoutes(fixture.server("target"));
  return fixture;
}

function gatewayGraph(groovyUel: string, logicUel: string): RecordValue {
  return {
    process: {
      name: "项目资料审批",
      startUEL: {},
      nodes: {
        StartEvent_1: {
          id: "StartEvent_1",
          type: "StartEvent",
          name: "开始",
          target: [{ targetId: "ExclusiveGateway_2", uel: {} }],
          nodeConfig: {}
        },
        ExclusiveGateway_2: {
          id: "ExclusiveGateway_2",
          type: "ExclusiveGateway",
          busType: "ExclusiveGateway",
          name: "系统排他网关",
          target: [
            {
              targetId: "EndEvent_3",
              uel: { name: "信用客户", logicUel, groovyUel }
            },
            {
              targetId: "EndEvent_3",
              uel: { name: "默认", logicUel: "", groovyUel: "", isDefault: true }
            }
          ],
          nodeConfig: {}
        },
        EndEvent_3: {
          id: "EndEvent_3",
          type: "EndEvent",
          name: "结束",
          target: [],
          nodeConfig: { notify: null }
        }
      }
    }
  };
}

async function writeGraphFile(
  directory: string,
  graph: RecordValue
): Promise<string> {
  const file = join(directory, "graph.json");
  await writeFile(
    file,
    `${JSON.stringify({
      kind: "eadp.bpm.graph.v1",
      flow: "TBS_PROJECT",
      graphs: [{ name: "项目资料审批", graph }]
    }, null, 2)}\n`,
    "utf8"
  );
  return file;
}

describe("bpm graph 系统判定条件", () => {
  it("graph conditions 列出系统发布的条件字段并给出网关优先级", async () => {
    const fixture = await setup();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "conditions", "--env", "target", "--flow", "TBS_PROJECT"
    ])) as RecordValue;
    expect(output).toMatchObject({
      kind: "eadp.bpm.graph.conditions.v1",
      environment: "target",
      flow: { code: "TBS_PROJECT" },
      businessEntity: { code: "com.example.Project" }
    });
    const conditions = output.conditions as RecordValue[];
    expect(conditions).toHaveLength(3);
    expect(conditions[0]).toMatchObject({ code: "fileType", name: "文件类型" });
    expect(conditions[2]).toMatchObject({
      code: "customerCreditAmount",
      name: "累计授信金额（客户）",
      initValue: 0
    });

    const priority = output.priority as RecordValue;
    const order = priority.order as RecordValue[];
    expect(order[0]).toMatchObject({ rank: 1, kind: "ExclusiveGateway" });
    expect(order[order.length - 1]).toMatchObject({ kind: "ManualExclusiveGateway" });
    expect(priority.rule).toContain("系统排他网关");
    expect((output.expression as RecordValue).command).toContain("eadp bpm graph expression");

    const request = fixture.server("target").requests.find((item) =>
      item.path.endsWith("/conBusinessEntity/getConditionPropertiesExplain")
    );
    expect(request?.query.get("businessEntityCode")).toBe("com.example.Project");
    expectNoWrites(fixture.server("target"), /(save|delete|deploy|write)/i);
  });

  it("graph expression 从中文条件生成并远程校验 groovyUel，且不替换字符串字面量", async () => {
    const fixture = await setup();
    const logic = "文件类型==\"文件类型\"&&累计授信金额（客户）>= 3000000";
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "expression", "--env", "target", "--flow", "TBS_PROJECT",
      "--logic", logic
    ])) as RecordValue;
    expect(output).toMatchObject({
      kind: "eadp.bpm.graph.expression.v1",
      environment: "target",
      flow: { code: "TBS_PROJECT" },
      expression: {
        logicUel: logic,
        groovyUel: "#{fileType==\"文件类型\"&&customerCreditAmount>= 3000000}"
      },
      validated: true,
      validatedBy: "conBusinessEntity/validateExpression"
    });
    const request = fixture.server("target").requests.find((item) =>
      item.path.endsWith("/conBusinessEntity/validateExpression")
    );
    expect(request?.body).toEqual({
      flowTypeId: "flow-1",
      expression: "#{fileType==\"文件类型\"&&customerCreditAmount>= 3000000}"
    });
  });

  it("graph expression --file 一次返回条件矩阵且相同表达式只校验一次", async () => {
    const fixture = await setup();
    const file = join(fixture.directory, "conditions.json");
    const logicA = "文件类型==\"信用-客户\"";
    const logicB = "累计授信金额（客户）>=3000000";
    await writeFile(file, JSON.stringify({
      expressions: [
        { key: "credit", logicUel: logicA },
        { key: "credit-copy", logicUel: logicA },
        { key: "amount", logicUel: logicB }
      ]
    }), "utf8");
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "expression", "--env", "target", "--flow", "TBS_PROJECT", "--file", file
    ])) as RecordValue;
    expect(output).toMatchObject({
      kind: "eadp.bpm.graph.expression.batch.v1",
      valid: true,
      attempted: 3,
      validated: 3,
      failed: 0,
      serverCalls: 2
    });
    const expressions = output.expressions as RecordValue[];
    expect(expressions).toHaveLength(3);
    expect(expressions.map((item) => item.key)).toEqual(["credit", "credit-copy", "amount"]);
    expect(expressions[0]!.expression).toEqual(expressions[1]!.expression);
    expect(expressions[2]!.expression).toEqual({
      logicUel: logicB,
      groovyUel: "#{customerCreditAmount>=3000000}"
    });
    expect(fixture.server("target").count(
      "POST", /\/conBusinessEntity\/validateExpression$/
    )).toBe(2);
  });

  it("表达式生成器拒绝清单外的中文条件", () => {
    expect(() => buildConditionExpression("客户类型==\"信用-客户\"", [{
      code: "fileType",
      name: "文件类型"
    }])).toThrowError(/系统未提供的判定条件：客户类型/);
  });

  it("validate 按系统条件清单校验网关条件", async () => {
    const fixture = await setup();
    const unknown = await writeGraphFile(
      fixture.directory,
      gatewayGraph("#{customerType==\"信用-客户\"}", "客户类型==\"信用-客户\"")
    );
    const validated = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", unknown
    ])) as RecordValue;
    expect(validated).toMatchObject({ conditions: { checked: true, propertyCount: 3 } });
    const entry = (validated.graphs as RecordValue[])[0]!;
    const codes = (entry.designIssues as RecordValue[]).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      "CONDITION_VARIABLE_UNKNOWN",
      "CONDITION_PROPERTY_UNKNOWN"
    ]));
    expect(entry.designValid).toBe(false);

    const known = await writeGraphFile(
      fixture.directory,
      gatewayGraph("#{fileType==\"信用-客户\"}", "文件类型==\"信用-客户\"")
    );
    const passed = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", known
    ])) as RecordValue;
    const passedEntry = (passed.graphs as RecordValue[])[0]!;
    const passedCodes = (passedEntry.designIssues as RecordValue[]).map((issue) => issue.code);
    expect(passedCodes).not.toContain("CONDITION_VARIABLE_UNKNOWN");
    expect(passedCodes).not.toContain("CONDITION_PROPERTY_UNKNOWN");
    expect(passed).toMatchObject({
      valid: true,
      designValid: true,
      conditions: {
        expressionValidation: { attempted: 1, validated: 1, failed: 0 }
      }
    });
  });

  it("校验 #{...} 格式以及 logicUel/groovyUel 一致性", () => {
    const properties = CONDITION_PROPERTIES.map((property) => ({
      code: String(property.code),
      name: String(property.name)
    }));
    const malformed = analyzeGraphConditions(
      JSON.stringify(gatewayGraph("${fileType==\"信用-客户\"}", "")),
      properties
    );
    expect(malformed.designIssues.map((issue) => issue.code)).toContain(
      "CONDITION_EXPRESSION_INVALID"
    );

    const mismatch = analyzeGraphConditions(
      JSON.stringify(gatewayGraph(
        "#{fileType==\"信用-客户\"}",
        "审批类型==\"信用-客户\""
      )),
      properties
    );
    expect(mismatch.designIssues.map((issue) => issue.code)).toContain(
      "CONDITION_EXPRESSION_MISMATCH"
    );

    const formattingOnly = analyzeGraphConditions(
      JSON.stringify(gatewayGraph(
        "#{ fileType == \"信用-客户\" }",
        "文件类型==\"信用-客户\""
      )),
      properties
    );
    expect(formattingOnly.designIssues.map((issue) => issue.code)).not.toContain(
      "CONDITION_EXPRESSION_MISMATCH"
    );
  });

  it("validate 合并设计器服务端 JUEL 校验失败", async () => {
    const fixture = await setup();
    const file = await writeGraphFile(
      fixture.directory,
      gatewayGraph("#{fileType==}", "文件类型==")
    );
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ])) as RecordValue;
    const entry = (output.graphs as RecordValue[])[0]!;
    const invalid = (entry.designIssues as RecordValue[]).find((issue) =>
      issue.code === "CONDITION_EXPRESSION_INVALID"
    );
    expect(invalid?.message).toContain("表达式语法错误");
    expect(output).toMatchObject({
      designValid: false,
      conditions: {
        expressionValidation: { attempted: 1, validated: 0, failed: 1 }
      }
    });

    const preview = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--strict"
    ])) as RecordValue;
    expect(preview.summary).toMatchObject({ blocked: 1, create: 0 });
    expect(fixture.server("target").count("POST", /\/defFlowVersion\/saveOrDeploy$/)).toBe(0);
  });

  it("表达式校验发生 HTTP 故障时终止导入且不写草稿", async () => {
    const fixture = await setup();
    const file = await writeGraphFile(
      fixture.directory,
      gatewayGraph("#{fileType!=}", "文件类型!=")
    );
    const message = await runExpectError(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--strict", "--apply"
    ]);
    expect(message).toContain("HTTP 500");
    expect(fixture.server("target").count("POST", /\/defFlowVersion\/saveOrDeploy$/)).toBe(0);
  });

  it("启动条件和网关使用相同表达式时只远程校验一次", async () => {
    const fixture = await setup();
    const graph = gatewayGraph(
      "#{fileType==\"信用-客户\"}",
      "文件类型==\"信用-客户\""
    );
    (graph.process as RecordValue).startUEL = {
      groovyUel: "#{fileType==\"信用-客户\"}",
      logicUel: "文件类型==\"信用-客户\""
    };
    const file = await writeGraphFile(fixture.directory, graph);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ])) as RecordValue;
    expect(output).toMatchObject({
      conditions: {
        expressionValidation: { attempted: 2, validated: 2, failed: 0 }
      }
    });
    expect(fixture.server("target").count(
      "POST",
      /\/conBusinessEntity\/validateExpression$/
    )).toBe(1);
  });

  it("import --strict 拒绝使用系统未提供条件的图", async () => {
    const fixture = await setup();
    const file = await writeGraphFile(
      fixture.directory,
      gatewayGraph("#{customerType==\"信用-客户\"}", "客户类型==\"信用-客户\"")
    );
    const preview = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT", "--file", file, "--strict"
    ])) as RecordValue;
    const change = (preview.changes as RecordValue[])[0]!;
    expect(change.action).toBe("blocked");
    expect((change.blockingIssues as RecordValue[]).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CONDITION_VARIABLE_UNKNOWN"])
    );
    expect(preview.summary).toMatchObject({ blocked: 1, create: 0 });
  });

  it("非默认路径缺少表达式时报设计级问题，审批出口不受影响", () => {
    const verdict = analyzeGraphConditions(
      JSON.stringify(gatewayGraph("", "")),
      CONDITION_PROPERTIES.map((property) => ({
        code: String(property.code),
        name: String(property.name)
      }))
    );
    expect(verdict.designIssues.map((issue) => issue.code)).toContain(
      "CONDITION_EXPRESSION_MISSING"
    );

    const approve = analyzeGraphConditions(JSON.stringify({
      process: {
        name: "项目资料审批",
        startUEL: {},
        nodes: {
          StartEvent_1: {
            id: "StartEvent_1",
            type: "StartEvent",
            name: "开始",
            target: [{ targetId: "Approve_2", uel: {} }],
            nodeConfig: {}
          },
          Approve_2: {
            id: "Approve_2",
            type: "UserTask",
            nodeType: "Approve",
            name: "经理审批",
            target: [
              { targetId: "EndEvent_3", uel: { agree: true, groovyUel: "${approveResult == true}" } },
              { targetId: "EndEvent_3", uel: { agree: false, isReverse: true } }
            ],
            nodeConfig: {
              normal: { pageUrl: "/tbs/approve" },
              executor: [{ userType: "Position", positionCodes: ["01007"] }],
              event: {},
              notify: null
            }
          },
          EndEvent_3: {
            id: "EndEvent_3",
            type: "EndEvent",
            name: "结束",
            target: [],
            nodeConfig: { notify: null }
          }
        }
      }
    }), [{ code: "fileType", name: "文件类型" }]);
    expect(approve.designIssues).toHaveLength(0);
  });

  it("表达式解析只取业务变量", () => {
    expect(extractConditionVariables("#{fileType==\"信用-客户\"}")).toEqual(["fileType"]);
    expect(extractConditionVariables("#{fileType==\"a\"&&customerCreditAmount>=3000000 }"))
      .toEqual(["customerCreditAmount", "fileType"]);
    expect(extractConditionVariables("${approveResult == true}")).toEqual([]);
    expect(extractConditionVariables("#{oneTimePayment==true}")).toEqual(["oneTimePayment"]);
    expect(extractConditionVariables(
      "#{expenseTypeCategories.contains('业务招待费')&&expenseTypeCategories.size()==1&&!creatorAccount=='10001489'}"
    )).toEqual(["creatorAccount", "expenseTypeCategories"]);
    expect(extractUnknownPropertyNames("文件类型==\"信用-客户\"", ["文件类型"])).toEqual([]);
    expect(extractUnknownPropertyNames(
      "累计授信金额（客户）>=3000000",
      ["累计授信金额（客户）"]
    )).toEqual([]);
    expect(extractUnknownPropertyNames("客户类型==\"信用-客户\"", ["文件类型"])).toEqual(["客户类型"]);
  });

  it("guide 与 nodes 写明先加载系统条件、系统排他网关优先级最高", async () => {
    const fixture = await setup();
    const guide = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "guide"
    ])) as RecordValue;
    const steps = guide.workflow as RecordValue[];
    const loadStep = steps.find((step) => step.step === "load-conditions");
    expect(loadStep?.command).toContain("eadp bpm graph conditions");
    const conditionSource = guide.conditionSource as RecordValue;
    expect(conditionSource.command).toContain("eadp bpm graph conditions");
    expect(conditionSource.expressionCommand).toContain("eadp bpm graph expression");
    expect(steps.find((step) => step.step === "build-expressions")?.command).toContain(
      "eadp bpm graph expression"
    );
    expect((conditionSource.priority as RecordValue).order[0]).toContain("ExclusiveGateway");
    expect(JSON.stringify(guide.prohibitions)).toContain("不得自造条件变量名");

    const nodes = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "nodes", "--kind", "ExclusiveGateway"
    ])) as RecordValue;
    const usage = (nodes.nodes as RecordValue[])[0]!.usage as RecordValue;
    expect(usage.summary).toContain("优先级最高");
    expect((usage.requiredInputs as string[])[0]).toContain("eadp bpm graph conditions");

    const manual = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "nodes", "--kind", "ManualExclusiveGateway"
    ])) as RecordValue;
    const manualUsage = (manual.nodes as RecordValue[])[0]!.usage as RecordValue;
    expect(manualUsage.notFor).toEqual(
      expect.arrayContaining(["系统条件字段已经可以判定该分流"])
    );
  });
});
