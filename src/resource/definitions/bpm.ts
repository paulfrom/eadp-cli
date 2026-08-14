import type { ResourceContract } from "../core/contracts.js";

export const bpmContract: ResourceContract = {
  id: "bpm",
  title: "BPM 聚合",
  description: "BPM 流程基础数据由专用聚合处理器按流程选择器比较或迁移。",
  service: "sei-bpm",
  query: { path: "__handler__/bpm", method: "POST" },
  read: "handler",
  identityFields: [],
  compareFields: [],
  writableFields: [],
  tenant: { policy: "non-global" },
  capabilities: ["compare", "sync"],
  help: "BPM 不使用普通资源 HTTP 引擎；使用 --flow 指定流程代码、名称或 Entity 代码。",
  filtering: { time: false },
  handler: "bpm",
  selectors: [{
    name: "flow",
    valuePlaceholder: "code-or-name",
    description: "BPM 流程代码、名称或 Entity 代码",
    required: true
  }]
};
