/** Structurally complete minimal graph used by guide and regression tests. */
export const BPM_GRAPH_GOLDEN_SAMPLE = {
  kind: "eadp.bpm.graph.v1",
  flow: "REPLACE_WITH_FLOW_CODE",
  graphs: [{
    name: "金额审批示例",
    graph: {
      process: {
        name: "金额审批示例",
        startUEL: {},
        nodes: {
          StartEvent_1: {
            id: "StartEvent_1",
            type: "StartEvent",
            name: "开始",
            x: 120,
            y: 100,
            target: [{ targetId: "Normal_1", uel: {} }],
            nodeConfig: {}
          },
          Normal_1: {
            id: "Normal_1",
            type: "UserTask",
            nodeType: "Normal",
            name: "发起人填写",
            x: 120,
            y: 260,
            target: [{ targetId: "ExclusiveGateway_1", uel: {} }],
            nodeConfig: {
              normal: { pageUrl: "/replace-with/approved-page" },
              executor: [{ type: "StartUser", userType: "StartUser" }],
              event: {},
              notify: null
            }
          },
          ExclusiveGateway_1: {
            id: "ExclusiveGateway_1",
            type: "ExclusiveGateway",
            busType: "ExclusiveGateway",
            name: "金额判断",
            x: 120,
            y: 420,
            target: [
              {
                targetId: "Approve_1",
                uel: {
                  name: "大额",
                  logicUel: "金额>1000",
                  groovyUel: "#{amount>1000}"
                }
              },
              {
                targetId: "EndEvent_1",
                uel: { name: "小额或直接结束", isDefault: true }
              }
            ],
            nodeConfig: {}
          },
          Approve_1: {
            id: "Approve_1",
            type: "UserTask",
            nodeType: "Approve",
            name: "发起人审批",
            x: 120,
            y: 580,
            target: [
              { targetId: "EndEvent_1", uel: { name: "同意", agree: true } },
              {
                targetId: "Normal_1",
                uel: { name: "驳回修改", agree: false, isReverse: true }
              }
            ],
            nodeConfig: {
              normal: { pageUrl: "/replace-with/approved-page" },
              executor: [{ type: "StartUser", userType: "StartUser" }],
              event: {},
              notify: null
            }
          },
          EndEvent_1: {
            id: "EndEvent_1",
            type: "EndEvent",
            name: "结束",
            x: 120,
            y: 740,
            target: [],
            nodeConfig: { notify: null }
          }
        }
      }
    }
  }]
} as const;

export const GOLDEN_SAMPLE_REPLACEMENTS = [
  "flow 改为目标流程类型 code。",
  "pageUrl 改为目标环境已登记页面的 pcUrl；两处可使用同一页面。",
  "金额/amount 必须替换为 eadp bpm graph conditions 实际返回的 name/code，并用 graph expression 重新生成表达式。",
  "示例执行人使用 StartUser；若业务要求固定人员或岗位，先用 graph resolve-executor 唯一解析后替换。",
  "替换后先运行 graph validate --strict 和 graph import 预览；import --apply 仍只写草稿。"
] as const;
