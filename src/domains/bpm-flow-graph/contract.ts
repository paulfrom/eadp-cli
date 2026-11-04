import type { ResourceContract } from "../../resource/core/contracts.js";

export const bpmFlowGraphContract: ResourceContract = {
  id: "bpm-flow-graph",
  title: "BPM 流程图配置",
  description: "按流程类型比较或迁移流程图设计稿；只写目标草稿，不发布。",
  service: "sei-bpm",
  query: { path: "__handler__/bpm-flow-graph", method: "POST" },
  read: "handler",
  identityFields: [],
  compareFields: ["graph"],
  writableFields: [],
  tenant: { policy: "non-global" },
  capabilities: ["compare", "sync"],
  help: [
    "使用 --select flow=<流程类型 code/名称/Entity code>；同步源环境最新设计稿到目标草稿，不发布。",
    "节点能力以 eadp bpm graph nodes 为准（能力表随 CLI 发布，不读取外部源码）。",
    "网关条件只能使用目标环境业务实体发布的判定条件字段：eadp bpm graph conditions --env <环境> --flow <流程类型>；系统排他网关优先级最高。",
    "支持任务：Normal、SingleSign、Approve、CounterSign、ParallelTask、SerialTask（type=UserTask + nodeType）、ServiceTask、ManualTask、ReceiveTask、AgentTask、PoolTask；网关：ExclusiveGateway、ManualExclusiveGateway（type=ExclusiveGateway + busType）、ParallelGateway、InclusiveGateway；事件：StartEvent、EndEvent、TerminateEndEvent。",
    "CallActivity（子流程）、ProjectPosition（项目岗位）、非空 smartAudit/ruleConfig 一律 blocked。",
    "人工任务必须带 nodeType、非空 executor、nodeConfig.normal 页面；审批/会签恰好 2 条出口且 1 条 uel.agree；系统排他/包容恰好 1 条 uel.isDefault；单 StartEvent、至少 1 个 EndEvent。",
    "bpm graph validate 同时输出 valid（能否搬运）与 designValid（设计器能否保存），并按系统条件清单校验网关条件；--strict 把 designIssues 视为失败。",
    "源流程类型下没有任何设计稿时无法从零建图，请先在 BPM 设计器落稿（或使用 bpm graph import）。"
  ].join("\n"),
  filtering: { time: false },
  handler: "bpm-flow-graph",
  selectors: [{
    name: "flow",
    valuePlaceholder: "code-or-name",
    description: "流程类型 code、名称或 Entity code",
    required: true
  }]
};
