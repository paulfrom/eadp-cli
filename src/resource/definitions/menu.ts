import type { ResourceContract } from "../core/contracts.js";

export const menuContract: ResourceContract = {
  id: "menu",
  title: "菜单树",
  description: "菜单树由专用 TypeScript 工作流按 code、parentCode、featureCode 处理。",
  service: "sei-basic",
  query: { path: "menu/getMenuTree", method: "GET" },
  read: "tree",
  identityFields: ["code"],
  compareFields: ["code", "name", "rank", "iconCls", "parentCode", "featureCode"],
  writableFields: [],
  tenant: { policy: "global" },
  capabilities: ["query", "compare", "sync"],
  help: "菜单比较/迁移使用菜单树专用处理器，按 URL 作为边界，不接受或复制源 ID。",
  filtering: { time: false },
  handler: "menu",
  selectors: [{
    name: "code",
    valuePlaceholder: "code",
    description: "菜单代码；省略时比较完整菜单树",
    required: false
  }]
};
