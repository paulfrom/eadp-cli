# BPM 工作流优化落地记录

> 日期：2026-11-02  
> 范围：BPM 骨架配置（`bpm` / `bpm configure`）与流程图配置（`bpm-flow-graph`）的结合方式  
> 结论：新增组合入口与图文件通道；两个原子入口与既有五动作语义不变；全量 256 个用例通过。

## 1. 目标

把「先骨架后图」从文档约定变成工具约束，并补上「没有源图」时的合法写入路径，使这条工作流成立：

```text
bpm inspect → bpm configure（骨架）
  → 设计器落稿 或 bpm graph export/validate/import（图）
  → resource sync bpm-migration（骨架+图，草稿）
  → 设计器发布
```

## 2. 任务分解

| 阶段 | 任务 | 状态 | 验收 |
| --- | --- | --- | --- |
| P0 | `bpm-flow-graph` 的 `help` 暴露节点白名单、blocked 类型、UserTask 必填项 | 完成 | `resource inspect bpm-flow-graph` 断言含 `CallActivity`/`UserTask` |
| P0 | 图 plan 输出 `graphReadiness` 与 `nextActions` | 完成 | 组合入口预览断言 `state=source-only`、blocked 不误报 |
| P0 | `bpm` plan 输出页面/接口/流程类型摘要与下一步提示 | 完成 | `details.pages/interfaces/flowType/nextActions` |
| P1 | 新增组合入口 `bpm-migration`（依赖 `bpm` → `bpm-flow-graph`） | 完成 | 2 个集成用例（预览/落库/幂等） |
| P1 | 引擎：依赖继承同名 `--select`、保留 `change.resource`、计划标签不覆盖 | 完成 | `trans`/`feature` 回归全绿 |
| P1 | 预览把依赖计划将创建的记录注入后续规划 | 完成 | 组合入口预览 `create: 6, blocked: 0` |
| P2 | `bpm graph export/validate/import` 文件通道 | 完成 | 6 个用例（导出、校验、预览、落库、幂等、缺依赖、缺骨架、拒绝原始 defJson） |
| P3 | 语义/布局分离、CallActivity 放行、scaffold 生成器 | 未做 | 需要稳定 golden `defJson`，留待后续 |

## 3. 交付物

代码：

- `src/domains/bpm-migration/{contract,handler}.ts`：组合入口，不持有记录。
- `src/domains/bpm-flow-graph/draft.ts`：文件读写、导出、校验、导入计划/执行/回查。
- `src/domains/bpm-flow-graph/graph.ts`：新增 `validateCanonicalGraph`（规范化图的结构校验）。
- `src/domains/bpm-flow-graph/service.ts`：`readFlowDesign` 复用；plan details。
- `src/resource/core/client.ts`：`withPlannedRows` 与 `findByPage` 合并（仅无过滤查询）。
- `src/resource/core/engine.ts`：依赖选择器继承、plannedRows、计划标签、合并 details。
- `src/commands/bpm.ts`：`bpm graph export|validate|import`。
- `src/commands/resource.ts`：`inspect` 摘要增加 `dependencies`。
- `src/errors.ts`：新增稳定错误码 `GRAPH_SOURCE_EMPTY`。

文档/技能：

- `AGENTS.md`：三个入口的关系、禁止凭表造图、文件通道规则。
- `README.md`：组合入口与文件通道示例。
- `docs/bpm-flow-graph-design.md`：第 12 节（组合入口与文件通道）。
- `skills/eadp-operator/SKILL.md`、`references/bpm-configuration.md`、`references/bpm-flow-graph.md`。

测试：

- `tests/bpm-flow-graph.test.ts`：组合入口 2 例 + 契约发现 1 例。
- `tests/bpm-graph-file.test.ts`：文件通道 6 例。

## 4. 行为与兼容性

- `bpm`、`bpm-flow-graph` 的契约、选择器、五动作、blocked 规则不变。
- 新增 `bpm-migration` 是第三个入口，不替换前两个；只想建骨架或只搬图时仍用原入口。
- 引擎改动向后兼容：根记录仍保持 `resource === undefined`，依赖记录只在缺标签时补；
  `trans`、`feature`、`menu`、权限、回滚等回归全部通过。
- 输出新增字段均可选：`details.graphReadiness`、`details.nextActions`、`details.dependencies`；
  终端仍只打印 `{ nodes, chars }`，不打印整图。
- `bpm graph import` 只写草稿（`deploy: false`），`unchanged` 不调用 `saveOrDeploy`；
  `CallActivity`、`ProjectPosition`、智能审核仍 blocked。

## 5. 使用方式

```text
# 完整迁移（推荐）
eadp resource sync bpm-migration --source dev --target ead --select flow=TBS_PROJECT --apply

# 只建骨架 / 只搬图
eadp resource sync bpm --source dev --target ead --select flow=TBS_PROJECT --apply
eadp resource sync bpm-flow-graph --source dev --target ead --select flow=TBS_PROJECT --apply

# 没有源图：导出 → 校验 → 导入
eadp bpm graph export   --env dev --flow TBS_PROJECT --out tbs.json
eadp bpm graph validate --env ead --file tbs.json
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json --apply
```

文件格式 `eadp.bpm.graph.v1`：

```json
{
  "kind": "eadp.bpm.graph.v1",
  "flow": "TBS_PROJECT",
  "graphs": [
    { "name": "项目立项", "graph": { "process": { "nodes": { } } } }
  ]
}
```

`graph` 是规范化图：页面/接口按 URL、人员/岗位按 code、组织按代码，不含环境内 ID。

## 6. 验收记录

- `npm test -- --testTimeout=30000`：23 个测试文件、256 个用例全部通过。
- 关键场景：
  - 组合入口预览：骨架 5 个 create + 图 1 个 create，图不因「页面将由本次创建」而 blocked。
  - 组合入口 apply：先写骨架，再写图草稿，`verified: true`；第二次全部 `unchanged`，`saveOrDeploy` 只调用一次。
  - 文件通道：导出不含源环境 ID；导入目标后页面/执行人 ID 正确重映射；重复导入 `unchanged`。
  - 目标缺页面：`validate` 报 `missingDependencies`，零写入。
  - 目标缺流程类型：`import` 提示先运行 `resource sync bpm`/`bpm-migration`。
  - 原始 `defJson` 被拒绝，避免把设计器原始文件当可移植文件。

## 7. 边界与后续

- 仍不支持从「表一表二」直接生成画布；必须先有设计器草稿或 `export` 产出的规范图。
- 图比较仍是整图（含坐标）；布局漂移会产生 `update` 与新版本。
- `CallActivity`、`ProjectPosition`、智能审核仍 blocked；子流程放行需要拓扑序与目标已发布版本。
- 后续可做：语义/布局分离、golden `defJson` + scaffold 生成器、`bpm status` 单命令总览。
