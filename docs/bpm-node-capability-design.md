# BPM 节点能力（CLI 内置能力表）

> 日期：2026-11-02  
> 状态：已实现  
> 原则：**能力表随 CLI 发布，不读取、不依赖任何外部源码或仓库；CLI 仍然不做画布编辑器。**

---

## 1. 目标与边界

CLI 需要在不连接浏览器、不读取外部项目的前提下，回答三个问题：

1. **这个节点是什么？** `type` 只是引擎类型；真正决定节点语义的是 `nodeType`（任务子类型）或 `busType`（网关子类型）。
2. **这张图能不能搬？** 跨环境不可表达的内容（子流程、项目岗位、智能审核）必须 `blocked`。
3. **设计器会不会允许保存？** 出口数、同意线、默认路径、节点必填项等规则必须能离线判断。

同时明确不做：

- 不做画布编辑器、自动布局、发布。
- 不从表结构或字段猜测生成画布。
- 不读取、导入、解析任何外部项目源码；能力表是 CLI 自带数据。

---

## 2. 内置能力表

新增 `src/domains/bpm-flow-graph/node-catalog.ts`：

- `NODE_RULES`：19 个当前节点 + 3 个历史节点（`MailTask`、`ScriptTask`、`EventGateway`）。
- `NODE_USAGE`：每个节点的适用示例、不适用场景、选择前所需信息和不确定时的追问。
- `CATALOG_VERSION`：能力表版本，由 `eadp bpm graph nodes` 输出。
- `resolveNodeKind(node)`：从 `type` + `nodeType`/`busType` 解析出节点 `kind`，并返回稳定错误码。
- `listNodeRules()` / `describeNodeRule()`：供命令与测试使用；输出合并结构约束与场景指导。

每个节点记录：

```ts
{
  kind, title, group, engineType, discriminator,
  usage: {
    summary,
    exampleScenarios, // 哪些业务场景适用
    notFor,           // 哪些场景明确不适用
    requiredInputs,   // 选择前必须明确的信息
    askWhenUnclear    // 不确定时必须提出的问题
  },
  configKeys, normal, serviceRequired, executor,
  edges: { minIn, minOut, maxOut?, agreeEdge?, defaultEdge?, reverseWarning? },
  migration: { policy: "supported" | "blocked", reason? },
  legacy?
}
```

`discriminator` 说明 `kind` 存在哪个字段：

| discriminator | 含义 | 例子 |
| --- | --- | --- |
| `type` | 事件或独立引擎类型 | `StartEvent`、`ServiceTask` |
| `nodeType` | 人工任务子类型 | `type=UserTask` + `nodeType=Approve` |
| `busType` | 网关子类型 | `type=ExclusiveGateway` + `busType=ManualExclusiveGateway` |

### 2.1 节点清单

| 节点 | group | 引擎 type | 子类型字段 | 关键规则 |
| --- | --- | --- | --- | --- |
| StartEvent | event | StartEvent | — | 至少 1 条出口；全图恰好 1 个 |
| EndEvent | event | EndEvent | — | 至少 1 条入口 |
| TerminateEndEvent | event | TerminateEndEvent | — | 至少 1 条入口 |
| Normal | task | UserTask | nodeType | 执行人、工作界面必填 |
| SingleSign | task | UserTask | nodeType | 同上 |
| Approve | task | UserTask | nodeType | 恰好 2 条出口、1 条同意线、逆向提示 |
| CounterSign | task | UserTask | nodeType | 恰好 2 条出口、1 条同意线、会签比例必填 |
| ParallelTask | task | UserTask | nodeType | 执行人、工作界面必填 |
| SerialTask | task | UserTask | nodeType | 同上 |
| ServiceTask | task | ServiceTask | nodeType | 服务事件可空 |
| ManualTask | task | ManualTask | nodeType | 无节点配置 |
| ReceiveTask | task | ReceiveTask | nodeType | 服务事件必填 |
| AgentTask | task | AgentTask | nodeType | 服务事件、执行人、提示词、超时必填 |
| PoolTask | task | PoolTask | nodeType | 池代码、工作界面、服务事件必填 |
| CallActivity | task | CallActivity | nodeType | migration blocked |
| ExclusiveGateway | gateway | ExclusiveGateway | busType | 至少 2 条出口、恰好 1 条默认路径、逆向提示 |
| ManualExclusiveGateway | gateway | ExclusiveGateway | busType | 至少 2 条出口、**不要求**默认路径、逆向提示 |
| ParallelGateway | gateway | ParallelGateway | busType | 至少 1 条出口 |
| InclusiveGateway | gateway | InclusiveGateway | busType | 恰好 1 条默认路径、逆向提示 |

历史节点只保留迁移兼容，`graph nodes` 默认不展示；`--include-legacy` 时展示并标记 `legacy: true`。

---

## 3. 校验分层：一次解析，两份结论

`src/domains/bpm-flow-graph/analysis.ts` 对规范化图做纯离线分析，返回：

```ts
{
  blockingIssues, // 能否安全跨环境写入
  designIssues,   // 设计器是否允许保存
  warnings        // 不阻塞、但需要人确认的风险
}
```

### 3.1 blockingIssues（迁移契约）

- `process` / `process.nodes` 缺失。
- 节点 `type` 缺失或不受支持；`nodeType`/`busType` 与 `type` 不一致。
- 节点 `id` 与键不一致、缺少 `name`、连线目标不存在。
- `CallActivity`、`ProjectPosition`、非空 `smartAudit/ruleConfig`。
- 人工任务缺少执行人或工作界面。
- 执行人类型不受支持（历史类型只给 warning）。
- 不是恰好 1 个 `StartEvent`，或没有 `EndEvent`。

这些规则保持既有 `blocked` 语义，不因为新增设计校验而改变。

### 3.2 designIssues（设计器等价规则）

对应设计器保存前的检查：

| 规则 | 适用节点 | 错误码 |
| --- | --- | --- |
| 开始节点至少 1 条出口 | StartEvent | `NODE_EXIT_MISSING` |
| 结束节点至少 1 条入口 | EndEvent / TerminateEndEvent | `NODE_ENTRY_MISSING` |
| 其他节点必须有出入口 | task / gateway | `NODE_ENTRY_MISSING` / `NODE_EXIT_MISSING` |
| 审批/会签恰好 2 条出口 | Approve / CounterSign | `NODE_EXIT_COUNT` |
| 审批/会签恰好 1 条 `uel.agree=true` | Approve / CounterSign | `NODE_AGREE_EDGE` |
| 系统/人工排他至少 2 条出口 | Exclusive / ManualExclusive | `NODE_EXIT_COUNT` |
| 系统排他/包容恰好 1 条 `uel.isDefault=true` | Exclusive / Inclusive | `NODE_DEFAULT_EDGE` |
| 节点配置不能为空 | 有 `configKeys` 的任务 | `NODE_CONFIG_EMPTY` |
| 常规必填项 | 会签比例、池代码、智能体字段等 | `NODE_REQUIRED_FIELD_MISSING` |
| 服务事件必填 | ReceiveTask / AgentTask / PoolTask | `NODE_SERVICE_MISSING` |
| 工作界面必填 | 人工任务 / PoolTask | `NODE_PAGE_MISSING` |

`NODE_REVERSE_NOT_SET` 属于 **warning**：设计器只是弹窗确认，不阻止保存。

### 3.3 warnings

- 历史节点类型（`MailTask` 等）。
- 历史执行人类型（`Org`、`OrganizationDimension`）。
- 执行人组合缺分片（`PositionTypeAndOrg` 只有一个分片）。
- 逆向标识未设置。

---

## 4. 执行人保真

设计器的执行人不是“一个类型 + 一组 id”，而是“组合类型 + 分片”：

```json
[
  { "type": "PositionTypeAndOrg", "userType": "PositionType", "ids": "..." },
  { "type": "PositionTypeAndOrg", "userType": "Org", "ids": "..." }
]
```

CLI 现在：

1. 规范化时保留 `type`，以 `(type, userType)` 区分分片。
2. 写回时每个分片重新带上 `type`，不再依赖设计器的兼容反推。
3. `SelfDefinition` 的 `name` 从目标环境同 URL 的接口记录重建。
4. `PositionTypeAndOrg` 必须同时存在 `PositionType` 与 `Org` 两个分片；缺一个给 `NODE_EXECUTOR_COMPOSITE_INCOMPLETE`。
5. `ProjectPosition` 继续 blocked；`OrganizationDimension` 作为历史类型给 warning。

规范化后的执行人示例：

```json
[
  { "type": "Person", "userType": "Person", "employeeCodes": ["E1001"] },
  { "type": "PositionTypeAndOrg", "userType": "PositionType", "positionCategoryCodes": ["PM"] },
  { "type": "PositionTypeAndOrg", "userType": "Org", "orgCodes": ["1001"] }
]
```

写回目标后：

```json
[
  { "type": "Person", "userType": "Person", "ids": "u-1", "name": "张三" },
  { "type": "PositionTypeAndOrg", "userType": "PositionType", "ids": "pc-1", "name": "项目经理" },
  { "type": "PositionTypeAndOrg", "userType": "Org", "ids": "org-1", "name": "总部" }
]
```

`type` 和分片归属在 `export → import → verify` 后保持不变；`name` 使用目标环境记录重建。

---

## 5. 命令与输出

### 5.1 `eadp bpm graph nodes`

只读、不访问远端、不读取外部源码：

```bash
eadp bpm graph nodes
eadp bpm graph nodes --group task
eadp bpm graph nodes --kind Approve
```

输出 `eadp.bpm.graph.nodes.v1`，包含 `catalogVersion` 和每个节点的引擎类型、子类型字段、必填项、出入口规则、执行人要求、迁移策略及 `example` 骨架。`usage` 同时给出适用/不适用场景、选择前所需信息和不确定时的追问；AI 必须先确认业务语义，不能仅凭节点名称选型。

独立业务输入的完整设计流程见 [BPM 流程图配置最佳实践](bpm-flow-configuration-best-practices.md)，也可直接运行 `eadp bpm graph guide` 获取 CLI 内置版本。

### 5.2 `eadp bpm graph validate`

```bash
eadp bpm graph validate --env ead --file tbs.json
eadp bpm graph validate --env ead --file tbs.json --strict
```

输出：

```json
{
  "flowTypeFound": true,
  "valid": true,
  "designValid": false,
  "graphs": [{
    "name": "项目立项",
    "nodes": 3,
    "valid": true,
    "designValid": false,
    "blockingIssues": [],
    "designIssues": [{
      "code": "NODE_EXIT_COUNT",
      "nodeId": "UserTask_2",
      "nodeName": "经理审批",
      "message": "【经理审批】节点需要配置 2 条出口线，请检查"
    }],
    "warnings": [{ "code": "NODE_REVERSE_NOT_SET" }],
    "missingDependencies": []
  }]
}
```

- `valid`：能否安全搬运/写入草稿（原有语义）。
- `designValid`：设计器是否允许保存。
- `--strict`：`designIssues` 也计入 `valid=false`。

### 5.3 `eadp bpm graph import`

- 默认只按 `blockingIssues` 阻断；`designIssues` 作为提示输出。
- `--strict` 时设计器无法保存的图也拒绝导入。
- 只写草稿，`unchanged` 不调用 `saveOrDeploy`。

### 5.4 迁移入口

`resource sync bpm-flow-graph` / `bpm-migration` 继续只按 `blockingIssues` 决策；plan `details.graphWarnings` 汇总逆向标识、历史类型、执行人组合等 warning。

---

## 6. 代码落点

```text
src/domains/bpm-flow-graph/node-catalog.ts   节点能力表 + kind 解析 + 场景输出
src/domains/bpm-flow-graph/node-usage.ts      节点适用场景、反例、所需信息与追问
src/domains/bpm-flow-graph/guide.ts           独立业务输入的配置与验收最佳实践
src/domains/bpm-flow-graph/analysis.ts        blocking/design/warnings 分析
src/domains/bpm-flow-graph/graph.ts           规范化/回填；kind 校验；执行人保真
src/domains/bpm-flow-graph/draft.ts           validate/import 双结论与 --strict
src/domains/bpm-flow-graph/service.ts         plan details.graphWarnings
src/commands/bpm.ts                           bpm graph nodes / validate --strict / import --strict
```

---

## 7. 测试

- `tests/bpm-node-catalog.test.ts`：kind 解析、目录完整性、审批/网关规则、历史类型、阻塞与设计的边界。
- `tests/bpm-graph-file.test.ts`：`graph nodes` 输出、`designValid`、`--strict`、执行人组合 `type` 保留。
- `tests/bpm-flow-graph.test.ts`：迁移/幂等/阻断回归；`SelfDefinition` 显示名重建。
- 2026-11-03 增补场景指导与 `graph guide` 后，全量 273 个用例通过。

---

## 8. 非目标

- 不做画布编辑器、自动布局、发布。
- 不从未经确认的业务输入或猜测字段生成图；充分的独立业务输入按 `graph guide` 生成规范化文件，语义不确定时先提问。
- 不读取外部源码；能力表是 CLI 内置数据，版本由 `CATALOG_VERSION` 标识。
- 不改变 `bpm` / `bpm-flow-graph` / `bpm-migration` 的既有五动作语义。
