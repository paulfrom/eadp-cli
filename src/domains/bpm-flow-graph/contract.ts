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
    "需要目标环境已存在流程类型；建议先运行 resource sync bpm 或直接使用 resource sync bpm-migration。",
    "支持节点 type：StartEvent、EndEvent、TerminateEndEvent、UserTask、MailTask、ManualTask、ScriptTask、ServiceTask、ReceiveTask、AgentTask、PoolTask、ExclusiveGateway、InclusiveGateway、ParallelGateway、EventGateway。",
    "CallActivity（子流程）、ProjectPosition（项目岗位）、非空 smartAudit/ruleConfig 一律 blocked。",
    "UserTask 必须带 nodeType、非空 executor、nodeConfig.normal 页面；连线 target 必须指向存在的节点。",
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
