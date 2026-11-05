/** Public, stable diagnostics introduced for graph file workflows. */
export const BPM_GRAPH_ERROR_CODES = [
  {
    code: "GRAPH_IMPORT_VERIFY_FAILED",
    scope: "import.verify",
    meaning: "草稿写入已成功，但回读缺失、回读失败或内容与本地文件不同",
    fix: "查看 verify.readBack 和 verify.graphs[].differences；不要重复写草稿，先排查服务端转换或回读故障"
  },
  {
    code: "GRAPH_SERVER_VALIDATION_FAILED",
    scope: "import.write",
    meaning: "服务端拒绝图字段；错误 detail.locations 给出节点、JSON 路径、期望类型、实际值与修复提示",
    fix: "按 locations 修正规范化文件后重新预览，不要直接修改目标环境 ID"
  },
  {
    code: "CONDITION_LABEL_MISSING",
    scope: "designIssues",
    meaning: "携带 logicUel 或 groovyUel 的边缺少非空 uel.name",
    fix: "为 edgeId/jsonPath 指向的边补充业务条件标题；--strict 会拒绝导入"
  },
  {
    code: "CONDITION_OVERLAP",
    scope: "designIssues",
    meaning: "同一系统排他网关的两条出边条件可能同时成立",
    fix: "调整条件使其互斥；确实允许多命中时改用包容网关"
  },
  {
    code: "CONDITION_COVERAGE_INCOMPLETE",
    scope: "designIssues",
    meaning: "没有默认边且现有条件不能证明覆盖全部输入",
    fix: "补齐条件全集，或增加一条 uel.isDefault=true 的默认边"
  },
  {
    code: "NODE_UNREACHABLE",
    scope: "designIssues",
    meaning: "节点从 StartEvent 不可达",
    fix: "补齐入口路径或删除无业务用途节点"
  },
  {
    code: "EDGE_DANGLING",
    scope: "designIssues",
    meaning: "边缺少 targetId 或目标节点不存在",
    fix: "按 edgeId/jsonPath 修正 targetId 或删除悬空边"
  },
  {
    code: "GRAPH_CYCLE_UNEXPECTED",
    scope: "designIssues",
    meaning: "图中存在不含显式 isReverse 驳回边的环",
    fix: "删除误接回边；真实驳回/重审环必须在驳回边上设置 isReverse=true"
  },
  {
    code: "EDGE_ID_DUPLICATE",
    scope: "designIssues",
    meaning: "两条或多条边声明了相同 id",
    fix: "为每条边分配全图唯一 id"
  },
  {
    code: "EXECUTOR_NOT_FOUND",
    scope: "resolve-executor",
    meaning: "中文名或 code 没有匹配到人员、岗位或岗位类别",
    fix: "核对目标环境记录，使用准确中文名或 code；不要猜测绑定"
  },
  {
    code: "EXECUTOR_AMBIGUOUS",
    scope: "resolve-executor",
    meaning: "输入同时匹配多个候选或多种绑定类型",
    fix: "从 candidates/detail.candidates 中选择准确 code 和 bindingType 后重试"
  }
] as const;
