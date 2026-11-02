import type { ResourceContract } from "../../resource/core/contracts.js";

/**
 * Combined entry point for a full BPM migration: the skeleton (business
 * module/entity/pages/interfaces/flow type) is planned and applied before the
 * flow graph. The two atomic resources stay independently usable.
 */
export const bpmMigrationContract: ResourceContract = {
  id: "bpm-migration",
  title: "BPM 迁移（骨架 + 流程图）",
  description: "按流程类型一次比较或迁移 BPM 骨架与流程图草稿；先骨架后图，只写草稿，不发布。",
  service: "sei-bpm",
  query: { path: "__handler__/bpm-migration", method: "POST" },
  read: "handler",
  identityFields: [],
  compareFields: [],
  writableFields: [],
  tenant: { policy: "non-global" },
  capabilities: ["compare", "sync"],
  help: "组合入口：按顺序执行 bpm（骨架）与 bpm-flow-graph（图）。使用 --select flow=<流程类型 code/名称/Entity code>；只写草稿，不发布。",
  filtering: { time: false },
  handler: "bpm-migration",
  dependencies: ["bpm", "bpm-flow-graph"],
  selectors: [{
    name: "flow",
    valuePlaceholder: "code-or-name",
    description: "流程类型 code、名称或 Entity code",
    required: true
  }]
};
