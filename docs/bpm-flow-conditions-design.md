# BPM 系统判定条件（条件字段清单与网关优先级）

> 日期：2026-11-04  
> 状态：已实现  
> 原则：**网关条件只能用目标环境业务实体发布的条件字段；系统排他网关优先级最高。**

---

## 1. 问题

设计流程图时，AI 容易出现两类错误：

1. **不加载系统提供的判定条件**：凭中文标题、节点名称或历史样例猜测变量名，写出 `#{fileTypeCode==...}` 这类并不存在的变量；设计器保存连线前会用业务实体发布的条件属性校验表达式，这类表达式保存不了。
2. **分流选型倒置**：明明系统条件字段就能判定路径，却用了人工排他网关（`ManualExclusiveGateway`）让运行时的人来选路；人工选路不可复现、不可审计，且绕开了系统已有的判定能力。

因此 CLI 必须提供“把系统判定条件读出来”的只读能力，并把它写进选型规范。

## 2. 远端契约

判定条件由业务实体发布，条件属性就是网关表达式可以引用的变量：

| 用途 | 端点 | 方式 | 返回 |
| --- | --- | --- | --- |
| 读取条件字段清单 | `conBusinessEntity/getConditionPropertiesExplain` | GET `businessEntityCode=<业务实体 code>` | `[{ code, name, initValue, remark }]` |
| 校验单条表达式 | `conBusinessEntity/validateExpression` | POST `{ flowTypeId, expression }` | 成功/失败 |

字段含义：

| 字段 | 含义 | 用在哪 |
| --- | --- | --- |
| `code` | 引擎变量名，例如 `fileType` | `groovyUel`：`#{fileType=="信用-客户"}` |
| `name` | 中文业务名称，例如 `文件类型` | `logicUel`：`文件类型=="信用-客户"` |
| `initValue` | 引擎校验表达式时的初始值 | 判断空值与比较符语义 |
| `remark` | 业务实体给出的说明 | 理解字段业务含义 |

流程类型通过 `businessEntityId` 关联业务实体，业务实体的 `code` 就是查询参数。

## 3. CLI 能力

### 3.1 `eadp bpm graph conditions`

```text
eadp bpm graph conditions --env <目标环境> --flow <流程类型 code/名称/Entity code>
```

输出 `kind=eadp.bpm.graph.conditions.v1`：

```json
{
  "environment": "dev",
  "flow": { "code": "XMZLSP" },
  "businessEntity": { "code": "com.example.Project" },
  "conditions": [
    { "code": "fileType", "name": "文件类型", "initValue": null, "remark": "资料类型" }
  ],
  "operators": [{ "name": "等于", "code": "==" }],
  "priority": { "rule": "...", "order": [...] }
}
```

只读：只调用 `getConditionPropertiesExplain`，不写任何数据。

### 3.2 `eadp bpm graph validate` 的条件校验

校验目标环境时同步读取该流程类型的条件清单，并逐条检查系统排他/包容网关的连线：

| 情况 | 结论 | 错误码 |
| --- | --- | --- |
| `groovyUel` 引用了清单外的变量 | 设计级问题 | `CONDITION_VARIABLE_UNKNOWN` |
| `logicUel` 引用了清单外的中文条件 | 设计级问题 | `CONDITION_PROPERTY_UNKNOWN` |
| 非默认路径没有表达式 | 设计级问题 | `CONDITION_EXPRESSION_MISSING` |
| 只有中文条件、没有可执行表达式 | 设计级问题 | `CONDITION_EXPRESSION_MISSING` |
| 条件清单读取失败 | 警告，图结构结论照常给出 | `CONDITION_CATALOG_UNAVAILABLE` |

设计级问题计入 `designIssues`，`--strict` 时使 `valid=false`。这与设计器行为一致：设计器保存连线前调用 `validateExpression`，表达式引用未知变量时拒绝保存。

审批节点的 `uel.agree` 出口、人工排他网关、并行网关不参与条件校验——它们本来就不承载系统判定条件。

## 4. 变量提取规则

`groovyUel` 的变量提取：

1. 去掉字符串字面量；
2. 取标识符，排除关键字（`true`/`false`/`null` 等）；
3. 排除属性访问（`.` 之后）与平台变量（`approveResult`）；
4. 剩余标识符即业务条件变量。

`logicUel` 的中文条件识别：

1. 去掉字符串字面量；
2. 按名称长度倒序移除已知条件名称（与设计器替换顺序一致）；
3. 去掉运算符、括号与数字；
4. 剩下的中文片段即清单外的条件。

## 5. 网关选型优先级

| 优先级 | 节点 | 适用 |
| --- | --- | --- |
| 1 | `ExclusiveGateway` 系统排他 | 条件字段能判定的业务分流，一律使用 |
| 2 | `InclusiveGateway` 系统包容 | 可能同时命中多条路径 |
| 3 | `ParallelGateway` 并行 | 无条件并行 |
| 4 | `ManualExclusiveGateway` 人工排他 | 系统条件字段无法判定时的兜底 |

优先级同时写进三处，保证 AI 在三个入口都能看到：

- `eadp bpm graph guide`：`conditionSource.priority` 与新增的 `load-conditions` 工作流步骤；
- `eadp bpm graph nodes`：`ExclusiveGateway` 的 `summary`/`requiredInputs`、`ManualExclusiveGateway` 的 `notFor`；
- `eadp bpm graph conditions`：命令输出中的 `priority`。

## 6. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/domains/bpm-flow-graph/conditions.ts` | 条件字段读取、变量提取、条件校验、优先级常量 |
| `src/domains/bpm-flow-graph/references.ts` | `conditionProperties(businessEntityCode)` 只读缓存 |
| `src/domains/bpm-flow-graph/draft.ts` | 校验时加载条件清单并合并结论 |
| `src/commands/bpm.ts` | `bpm graph conditions` 命令 |
| `src/domains/bpm-flow-graph/guide.ts` | `conditionSource`、工作流步骤、禁止事项 |
| `src/domains/bpm-flow-graph/node-usage.ts` | 网关节点场景与追问 |
| `tests/bpm-graph-conditions.test.ts` | 命令、条件校验与表达式解析回归 |
