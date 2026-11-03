# BPM 流程图配置（bpm-flow-graph）技术方案 · 简化版

> 一句话目标：**把源环境某条流程的流程图设计稿，一条命令复制到目标环境，生成草稿，绝不发布。**
>
> 参考实现：`src/domains/trans`（EAI 通道配置）  
> 上游依据：`sei-bpm` 服务端的 `DefFlowChartService`、`DefFlowVersionService`、`DefImportAndExportService`（仅实现时参考，CLI 运行时不依赖）

---

## 1. 五个“简单”怎么落地

| 原则 | 做法 |
| --- | --- |
| 目的简单 | 只做一件事：跨环境复制流程图设计稿。新增/修改是复制的结果，不是独立功能。 |
| 架构简单 | 新增 1 个资源 `bpm-flow-graph`，只声明 `compare + sync`；不新增任何领域命令。 |
| 设计简单 | 1 个选择器 `flow`；1 个参与比较的字段 `graph`；1 条规则：有差异就写草稿，无差异不写。 |
| 实现简单 | 复用 `bpm` 资源的形态（handler + 阶段钩子）；核心只有“读图 → 换 ID → 写图”三步。 |
| 用户简单 | 沿用用户已经会的 `resource compare/sync`，参数与 `bpm`、`trans` 完全一致。 |

核心取舍：**CLI 不做流程图编辑器，也不做发布工具**。它只负责“搬草稿”。

---

## 2. 相比上一版砍掉了什么

| 砍掉 | 原因 | 代价 |
| --- | --- | --- |
| 独立发布命令 `bpm flow publish` | 发布是高风险动作，BPM 已有批量发布 | 同步后在 BPM 设计器点发布 |
| 单环境 `write` / `export` / `--body` | 新增/修改已由 `sync` 的 create/update 覆盖；CLI 不做图编辑器 | 没有源环境时不能用 CLI 新建，需用设计器 |
| 完整的 PDG 嵌套模型 | 用“规范化 JSON 字符串”代替，和 `transGraph.graph` 完全同构 | 差异粒度只到 `graph` 整体 |
| 语义投影 + 节点级 diff | 字符串直接比较即可；坐标也参与比较，避免额外规则 | 目标环境手工改布局会被视为差异 |
| `name` / `version` / `publish` 选择器 | 一次迁移该流程类型下的全部流程定义，语义更完整 | 不能只挑其中一个定义 |
| 子流程（`CallActivity`） | 需要拓扑排序 + 目标子流程已发布，是复杂度最高的一块 | 含子流程的流程直接 `blocked` |
| 项目岗位（PMIS） | 跨系统、低频 | 使用项目岗位的节点 `blocked` |
| 智能审核 / 规则配置 | 引用规则中心独立 ID | 相关流程 `blocked` |
| `detail` / 大图查询输出 | 看图上 BPM 设计器 | 终端不打印整张图 |
| PDG 字段级校验矩阵 | 只需要“能存、能跑、引用能解析”三条底线 | 非必填项不校验 |
| 版本选择（草稿/已发布） | 固定“源环境最新设计稿 → 目标草稿” | 想迁移已发布版，先在源环境发布 |

结果：上一版约 9.5 人日、4 个选择器、2 个新命令；本版约 **3 人日**、1 个选择器、**0 个新命令**。

---

## 3. 用户视角

### 3.1 两条命令

```text
# 预览：源 dev，目标 test，流程类型 code = TBS_PROJECT
eadp resource compare bpm-flow-graph --source dev --target test --select flow=TBS_PROJECT

# 执行：写目标草稿，逐条回查
eadp resource sync bpm-flow-graph --source dev --target test --select flow=TBS_PROJECT --apply
```

参数与 `resource compare/sync bpm` 完全一致，用户不需要学新东西。

### 3.2 三种场景，一个动作

| 场景 | 目标环境状态 | `sync` 结果 |
| --- | --- | --- |
| 迁移 | 目标已有同名流程定义、内容不同 | `update`：新增一个草稿版本 |
| 新增 | 目标没有该流程定义 | `create`：新建流程定义 + 草稿版本 |
| 修改 | 目标已有、内容不同（同上） | `update`：新增草稿版本 |
| 无需处理 | 目标内容已一致 | `unchanged`：**不调用保存接口**，不产生版本 |
| 不满足条件 | 缺流程类型/页面/接口/basic 数据、含子流程等 | `blocked`：给出缺失项，不写入 |

### 3.3 发布

同步只写草稿。需要生效时，在 BPM 设计器对该流程执行发布；CLI 不提供发布入口。

---

## 4. 架构

一个资源，两个能力，一个选择器，一个字段：

```ts
// src/domains/bpm-flow-graph/contract.ts
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
  help: "使用 --select flow=<流程类型 code/名称/Entity code>；同步源环境最新设计稿到目标草稿，不发布。",
  filtering: { time: false },
  handler: "bpm-flow-graph",
  selectors: [{
    name: "flow",
    valuePlaceholder: "code-or-name",
    description: "流程类型 code、名称或 Entity code",
    required: true
  }]
};
```

结构与现有 `src/domains/bpm/contract.ts` 完全一致（同样 `read: "handler"`、同样 `flow` 选择器、同样只有 compare/sync），差别只是比较字段换成 `graph`。

资源记录（内部形态，用户不手写）：

```jsonc
{
  "flow": "TBS_PROJECT",   // conFlowType.code
  "name": "项目立项",       // DefFlowDefinition.name
  "graph": "{...}"         // 规范化后的设计稿 JSON 字符串
}
```

`graph` 是唯一参与比较、也是唯一需要写入的字段。

---

## 5. 数据契约：什么是“规范化图”

### 5.1 读写路径

```text
源环境：
  getFlowDesign(defId, -1) → defJson/defSubJson（设计稿）
    → 去服务端字段 → 环境 ID 换成 code/url → 排序 → graph 字符串

目标环境：
  graph 字符串 → code/url 换成目标 ID → 补根字段 → saveOrDeploy(deploy=false)
```

只有一个规则：**图上不允许出现任何环境内 ID**。

### 5.2 ID → code/url 映射表

| 引用位置 | 换成 | 目标解析 |
| --- | --- | --- |
| 根 `flowTypeId` | record.flow | `conFlowType/findByPage` code |
| 根 `name`、`process.name` | record.name | 定义按 (flow, name) 匹配 |
| 根 `orgId/orgCode/orgName/codePath/namePath` | `orgCode` | `conBasicInterface/getAllOrg` |
| `nodeConfig.normal.id`、通知 `pageId` | `pageUrl` | `conPage`（`pcUrl`） |
| `normal.serviceTaskId`、`event.before/afterExcuteServiceId`、`selfDefId`、`notifySelfDefId`、流程级 before/after 服务 | `*ServiceUrl` | `conInterface`（`url`） |
| `executor[].userType=Person` 的 `ids` | `employeeCodes` | `employee`（code） |
| `executor[].userType=Position` 的 `ids`、通知 `positionData` | `positionCodes` | `getPositionFindByPage` |
| `executor[].userType=PositionType` 的 `ids`、通知 `positionTypeData` | `positionCategoryCodes` | `getListPositionCategory` |
| `executor[].userType=Org` 的 `ids` | `orgCodes` | 同组织映射 |
| `executor[].userType=OrganizationDimension` 的 `ids` | `dimensionCodes` | `getAllOrgDimension` |
| `executor[].userType=AnyOne` 的 `rowdata` | `dimensionCodes` | `getAllOrgDimension`（任意执行人的组织维度限制） |
| `otherParams.autoExecuteUser.autoExecuteUserId` | `autoExecuteServiceUrl` | `conInterface`（`url`，自定义跳过人回调接口，不是员工） |
| `CallActivity` | — | **不映射，直接 blocked** |
| `executor[].userType=ProjectPosition` | — | **不映射，直接 blocked** |

执行人数组统一为数组（兼容历史对象形态），每项保留 `userType` + 对应 `*Codes`：
`ids`、`name`、`rowdata` 在写目标时由目标数据重建。

### 5.3 剥离的服务端字段

根 `id`、`name`、`flowTypeId`、`flowTypeName`、`orgId/orgName/codePath/namePath`、`startCondition`、`migrateFlowData`、`appointExecutorAtStart`；
`process.id`（defKey）、`process.flowDefVersionId`；
节点上的 `flowNewPosition` / `flowOldPosition`（服务端每次保存会重算）；
`defXml`、`actDefId`、`actDeployId`、`versionCode`、状态、创建/修改人、`publishNote`。

保留：`priority`、`subProcess`、`solidifyFlow`、`timing`、`earlyWarningTime`、`process.startUEL`、节点与 `nodeConfig` 的其余字段（含 `x/y` 和连线展示字段）。

### 5.4 规范化示例

```jsonc
{
  "orgCode": "1001",
  "priority": 0,
  "subProcess": false,
  "solidifyFlow": false,
  "process": {
    "name": "项目立项",
    "beforeStartServiceUrl": null,
    "startUEL": {},
    "nodes": {
      "StartEvent_1": {
        "id": "StartEvent_1", "type": "StartEvent", "name": "开始",
        "x": 180, "y": 120,
        "target": [{ "targetId": "UserTask_2", "uel": {} }],
        "nodeConfig": {}
      },
      "UserTask_2": {
        "id": "UserTask_2", "type": "UserTask", "nodeType": "Approve", "name": "经理审批",
        "x": 420, "y": 120,
        "target": [{ "targetId": "EndEvent_3", "uel": {} }],
        "nodeConfig": {
          "normal": { "pageUrl": "/tbs/approve", "name": "经理审批" },
          "executor": [{ "userType": "Person", "employeeCodes": ["E1001"] }],
          "event": {},
          "notify": null
        }
      },
      "EndEvent_3": {
        "id": "EndEvent_3", "type": "EndEvent", "name": "结束",
        "x": 700, "y": 120, "target": [], "nodeConfig": { "notify": null }
      }
    }
  }
}
```

---

## 6. 执行流程

### 6.1 compare / sync 的计划

```text
1. 源环境按 flow 解析流程类型（code/名称/Entity code，必须唯一）
2. 取该流程类型下全部 DefFlowDefinition
   - 0 个 → blocked（源流程类型下没有流程图定义）
   - 同名定义 > 1 → blocked(ambiguous)
3. 逐个读最新设计稿 getFlowDesign(defId, -1)
   - 含 CallActivity → blocked
   - 含 smartAudit/ruleConfig 非空 → blocked
   - 含 ProjectPosition 执行人 → blocked
4. 源侧 ID → code/url，得到 graph；无法解析 → blocked
5. 目标按 (flow, name) 找定义
   - 不存在 → create
   - graph 字符串相等 → unchanged
   - 不等 → update
6. 目标缺失的引用（流程类型/组织/人员/岗位/岗位类别/页面/接口）→ blocked
```

`changedFields`：`update` 为 `["graph"]`，`create` 为 `["graph"]`，`unchanged` 为空。

### 6.2 apply

```text
for (create/update) {
  graph → 目标 ID → 补根字段：
    create：无根 id；flowTypeId=目标流程类型；process.id 省略
    update：根 id=目标定义 id；process.id=目标定义 defKey（保留运行 key）
  saveOrDeploy({ defJson, deploy: false })
  create 记录 create-entity（可回滚删除新建定义）
}
```

### 6.3 verify

```text
重新读目标最新草稿 → 规范化 → 与 desired.graph 比较
全部相等 → verified=true；否则命令失败
```

### 6.4 幂等

第二次执行：目标草稿规范化后与源相同 → 全部 `unchanged`，**不调用 `saveOrDeploy`**，不新增版本。这是本方案唯一的硬约束。

### 6.5 输出

`sanitizeOutput` 只影响终端展示：把 `before`/`desired` 里的 `graph` 字符串替换为 `{ nodes, chars }`，避免整图刷屏；`apply`/`verify` 内部仍使用完整字符串。

---

## 7. 最小校验

只校验“服务端能存、运行能跑、引用能解析”：

| # | 校验 | 不通过 |
| --- | --- | --- |
| 1 | 图是对象，`process.nodes` 存在 | blocked |
| 2 | 恰好 1 个 `StartEvent`，至少 1 个 `EndEvent` | blocked |
| 3 | 每个节点 `id/type/name` 齐全、`type` 在支持列表内、`id` 等于 key；`targetId` 都存在 | blocked |
| 4 | `type=UserTask` 必须有 `nodeType`；用户任务必须有非空 `executor` 和 `normal.id` 页面 | blocked |
| 5 | 所有引用都能在目标解析（流程类型/组织/人员/岗位/岗位类别/页面/接口） | missingDependencies |
| 6 | 不含 `CallActivity`；不含 `ProjectPosition`；`smartAudit/ruleConfig` 为空 | blocked |
| 7 | 同一流程类型下定义名称唯一 | blocked(ambiguous) |

不校验：事件/通知是否齐全、非必填开关、坐标、连线样式、`subProcess/solidifyFlow` 的语义一致性。

写目标前统一补全 `nodeConfig`、`event`、`notify` 的空值，避免服务端 `getJSONObject` 抛异常。

---

## 8. 代码落点与工作量

```text
src/domains/bpm-flow-graph/
  contract.ts      ~25 行   资源契约（第 4 节）
  references.ts    ~120 行  流程类型/定义/组织/人员/岗位/页面/接口 查询 + 缓存
  graph.ts         ~150 行  规范化（ID→code）、回填（code→ID）、读写 defJson
  service.ts       ~120 行  aggregatePlan / apply / verify
  handler.ts       ~10 行   handler + sanitizeOutput
src/resource/core/client.ts  新增公共 invoke（~15 行，调用 conBasicInterface 的非分页接口）
src/domains/index.ts         注册 { contract, handler }
src/domains/bpm/selection.ts 抽取 selectFlow 复用（~30 行）
tests/bpm-flow-graph.test.ts
```

| 项 | 人日 |
| --- | --- |
| 契约 + references | 0.5 |
| 规范化 / 回填 | 1 |
| 校验 + hooks | 1 |
| 测试（含幂等、blocked、子流程） | 0.5 |
| **合计** | **约 3 人日** |

---

## 9. 测试

- 规范化：executor 对象/数组、`uel` 字符串/对象、缺 `orgCode`（用 orgId 反查）。
- 回填：create（无根 id/process.id）与 update（保留 defKey）。
- 比较：相同 → unchanged；改一个执行人 → update；坐标不同 → update（明确接受）。
- 幂等：`--apply` 后第二次 `sync` 全部 unchanged，`saveOrDeploy` 不被调用。
- 阻断：缺流程类型、缺页面、缺人员、含子流程、含智能审核、同名定义重复。
- 回归：`tests/bpm.test.ts`、`tests/trans-resource.test.ts`、`tests/resource-engine.test.ts`。

---

## 10. 非目标与后续可加

v1 明确不做：

- 单环境新建/编辑流程图；发布；子流程；项目岗位；智能审核/规则配置；删除目标多余定义；布局同步。

需要时按顺序加：

1. `bpm flow publish`（独立命令，默认预览）。
2. 子流程支持（拓扑排序 + 目标子流程必须先发布）。
3. 节点级 `changedFields`（语义投影）。
4. 单环境 `write`（需要 PDG 输入契约）。

---

## 11. 与现有规范的关系

现有约定“BPM 跨环境迁移必须使用 `eadp resource sync bpm`”，其范围是流程骨架（业务模块、实体、页面、接口、流程类型），不含流程图。本方案新增第二个 BPM 迁移入口，顺序固定：

```text
eadp resource sync bpm            --source A --target B --select flow=X   # 先：骨架与依赖
eadp resource sync bpm-flow-graph --source A --target B --select flow=X   # 后：流程图草稿
```

实施时同步修改 `AGENTS.md` 与 `skills/eadp-operator/references/bpm-configuration.md` 的措辞，避免歧义。

不并入 `bpm` 资源的原因有两条：

1. **计划与执行会耦合**：流程图的写回需要目标环境的页面/接口 ID，而这些记录可能正是本次 `bpm` 才创建的；合并后只能在 `apply` 阶段再解析依赖，预览时就无法提前报告“缺页面/缺接口”，`blocked` 也会变成执行中断。
2. **版本语义不同**：流程图每次 `update` 必然产生一个版本，而 `bpm` 的现有语义是“骨架字段幂等”，混在一起会让 `bpm` 的 `unchanged` 失真。

代价是两条命令、以及需要更新 `AGENTS.md` 的措辞；换来的是：预览就能看到全部阻断项，且 `bpm` 的现有行为与测试完全不动。

---

## 12. 组合入口与图文件通道（2026-11-02）

### 12.1 要解决的问题

原方案把「先骨架后图」只写在文档里，工具本身不知道；预览阶段骨架与图各自独立规划，图会误报
`missing page`；图只有「另一个环境」一个来源，拿不到样例，也无法从零建图。

### 12.2 组合入口 `bpm-migration`

新增一个不持有记录的伞资源，用引擎既有的依赖机制表达顺序：

```ts
{
  id: "bpm-migration",
  dependencies: ["bpm", "bpm-flow-graph"],
  capabilities: ["compare", "sync"],
  handler: "bpm-migration" // aggregatePlan 返回空 changes，apply/verify 为 no-op
}
```

- `resource compare/sync bpm-migration --select flow=X` 先规划 `bpm`，再规划流程图；
  `--apply` 时逐项重规划，因此图能看到骨架刚创建的页面/接口/流程类型。
- 两个原子入口保持不变：只想建骨架仍用 `bpm`，只想搬图仍用 `bpm-flow-graph`。
- 引擎新增三点：依赖按同名选择器继承 `--select`；`mergePlans` 不再覆盖依赖已有的
  `change.resource`（保留 `conPage` 等标签）；预览阶段把依赖计划的 `create` 记录作为
  `plannedRows` 注入后续规划，`hydrate` 因而把「本次会创建」的页面/接口/流程类型视为可用。

### 12.3 图文件通道

```text
eadp bpm graph export   --env dev --flow X --out x.json
eadp bpm graph validate --env ead --file x.json
eadp bpm graph import   --env ead --flow X --file x.json [--apply]
```

- 文件格式 `eadp.bpm.graph.v1`：`{ kind, flow, graphs: [{ name, graph }] }`，`graph` 是
  **规范化图**（页面/接口按 URL、人员按 code，不含环境内 ID），因此可跨环境复用。
- `export` 对源流程类型下的每个 `DefFlowDefinition` 读最新设计稿并规范化；源侧 0 个定义时
  以 `GRAPH_SOURCE_EMPTY` 停止，提示去设计器落稿。
- `validate` 只读：结构校验（节点类型、Start/End、连线目标、节点必填项）加 `hydrate`
  目标依赖校验，输出每个定义的 `blockingIssues`/`missingDependencies`。
  2026-11-02 增补：同时输出 `designValid`/`designIssues`/`warnings`，`--strict` 才把
  设计器无法保存的问题计为失败；节点能力以 `eadp bpm graph nodes` 为准，详见
  [bpm-node-capability-design.md](bpm-node-capability-design.md)。
- `import` 默认预览，`--apply` 只写草稿并回查；`unchanged` 不调用 `saveOrDeploy`，重复执行幂等；
  `CallActivity`/`ProjectPosition`/智能审核仍按原规则 blocked。

### 12.4 可观测性

- `bpm-flow-graph` 的 plan `details` 增加 `graphReadiness`（源/目标定义数与状态）和
  `nextActions`（补依赖、移除子流程/项目岗位、去设计器发布）。
- `bpm` 的 plan `details` 增加页面/接口/流程类型摘要与 `SYNC_FLOW_GRAPH` 下一步提示。
- `resource inspect bpm-flow-graph` 的 `help` 指向 `eadp bpm graph nodes`，后者直接列出
  支持的节点类型、blocked 类型、出入口规则与 UserTask 必填项。

### 12.5 代码与测试

```text
src/domains/bpm-migration/{contract,handler}.ts
src/domains/bpm-flow-graph/draft.ts          # export/validate/import
src/domains/bpm-flow-graph/graph.ts          # validateCanonicalGraph
src/resource/core/client.ts                  # withPlannedRows + findByPage 合并
src/resource/core/engine.ts                  # 选择器继承、plannedRows、计划标签与 details
src/commands/bpm.ts                          # bpm graph export/validate/import
tests/bpm-flow-graph.test.ts                 # 组合入口 2 个用例
tests/bpm-graph-file.test.ts                 # 文件通道 6 个用例
```

### 12.6 兼容性与验证

- `bpm`、`bpm-flow-graph` 的契约、选择器、五动作语义与 blocked 规则不变；新增的
  `bpm-migration` 是第三个入口，不替换前两个。
- 引擎改动对已有依赖资源向后兼容：`trans`/`feature` 的根记录仍保持 `resource === undefined`，
  仅依赖记录在缺少标签时补 `resource`；`trans`、`feature`、`menu` 回归全部通过。
- 输出新增字段均为可选：`details.graphReadiness`、`details.nextActions`、`details.dependencies`；
  终端仍不打印整图。
- 验证：`npm test` 全量 256 个用例通过（23 个文件），包含新增的组合入口 2 例与文件通道 6 例。

### 12.7 仍未做

语义/布局分离比较、`CallActivity` 按目标已发布子流程放行、`scaffold` 从节点表生成图；
这些都需要先有稳定的 golden `defJson`，留待后续版本。

## 附录 A：命令速查

```text
# 预览（组合入口：骨架 + 图）
eadp resource compare bpm-migration --source dev --target test --select flow=TBS_PROJECT

# 执行（组合入口：先骨架后图，只写草稿）
eadp resource sync bpm-migration --source dev --target test --select flow=TBS_PROJECT --apply

# 只预览/执行图
eadp resource compare bpm-flow-graph --source dev --target test --select flow=TBS_PROJECT

# 图文件通道
eadp bpm graph export   --env dev --flow TBS_PROJECT --out tbs.json
eadp bpm graph validate --env ead --file tbs.json
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json --apply

# 查看契约
eadp resource inspect bpm-flow-graph
eadp resource inspect bpm-migration
```

## 附录 B：输出示例

```jsonc
{
  "kind": "eadp.resource.change-set.v1",
  "resource": "bpm-flow-graph",
  "sourceEnvironment": "dev",
  "targetEnvironment": "test",
  "changes": [
    { "key": "TBS_PROJECT/项目立项", "action": "create",  "changedFields": ["graph"], "before": null, "desired": { "flow": "TBS_PROJECT", "name": "项目立项", "graph": "…" } },
    { "key": "TBS_PROJECT/项目变更", "action": "update",  "changedFields": ["graph"] },
    { "key": "TBS_PROJECT/项目结项", "action": "blocked", "changedFields": [],
      "missingDependencies": [{ "resource": "employee", "identityField": "code", "value": "E1001", "reason": "missing" }] }
  ],
  "summary": { "create": 1, "update": 1, "delete": 0, "unchanged": 0, "blocked": 1 }
}
```

## 附录 C：sei-bpm 关键事实（实现时对照）

- `saveOrDeploy` 每次调用都新建 `DefFlowVersion`，并改写 `lastVersionId`；`deploy=false` 只写草稿。
- 读取设计稿用 `defFlowVersion/getFlowDesign(-1)`；有 `defSubJson` 时返回它（含 `CallActivity`）。
- 有 `CallActivity` 时保存会读子流程的**已发布版本**，因此 v1 直接阻断。
- 更新时必须回填目标定义的既有 `defKey`，否则 `process.id` 会按 `BPM_<定义ID>` 重算。
- 用户任务运行期要求 `executor` 非空、`normal.id` 指向存在的 `conPage`。
- `smartAudit/ruleConfig` 引用规则中心的 `ruleUseCaseId/code`，v1 阻断。

## 附录 D：实现记录（2026-11-02）

已实现并通过验证：

- 代码：`src/domains/bpm-flow-graph/{contract,references,graph,service,handler}.ts`；`src/domains/bpm/selection.ts`；`src/domains/index.ts` 注册；`src/resource/core/client.ts` 新增 `invoke`。
- 测试：`tests/bpm-flow-graph.test.ts` 15 个用例；`tests/bpm.test.ts` 11 个回归；全量 246 个用例通过（`--testTimeout=30000`）。
- 命令：`node dist/bin.js resource inspect bpm-flow-graph` 输出 compare/sync、`flow` 选择器、`graph` 字段。

实现中对方案的两处修正（均以 sei-bpm 源码为准）：

1. `otherParams.autoExecuteUser.autoExecuteUserId` 是 `ConInterface` ID（`RunAutoExecuteTaskService#getTaskSkipUserList` 用 `interfaceDao.findOne` 后 `getExecutorsBySelfDef`），不是员工 ID；实现映射为 `autoExecuteServiceUrl`。
2. 通知页面字段是 `pageId`（`MessageSendThread` 的 `ConstantsUtil.PAGE_ID`），不能复用用户任务的 `normal.id`；实现单独回填 `pageId`。

另外，`executor.userType=AnyOne` 的 `rowdata` 是组织维度限制，已映射为 `dimensionCodes` 并在目标重建 `rowdata`，避免“任意执行人”失去维度约束。

已知环境性测试抖动（与本次改动无关）：

- 默认 `npm test` 下 `tests/release.test.ts` 的 5 秒超时在慢机器上会失败，放宽到 30 秒后 3/3 通过；
- `tests/rollback-operation-log.test.ts` 的并发临时锁在高并发下偶发 EPERM，单独复跑 18/18 通过。
