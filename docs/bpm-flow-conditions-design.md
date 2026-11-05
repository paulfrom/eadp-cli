# BPM 系统判定条件与表达式配置

条件字段来自目标环境；只维护一份中文条件；表达式与设计器使用同一服务端校验。本文描述当前 CLI 行为，具体规则以 `src/domains/bpm-flow-graph/conditions.ts`、`expression.ts` 和对应测试为准。

## 1. 问题

设计流程图时，AI 容易出现四类错误：

1. **自造条件变量**：凭中文标题、节点名称或历史样例猜测变量名，写出业务实体没有发布的条件。
2. **分流选型倒置**：系统条件字段已经能判定路径，却使用人工排他网关。
3. **双表达式不一致**：分别手写 `logicUel` 和 `groovyUel`，两者变量、运算符或值不同；或者误用 `${...}`、裸表达式，而服务端只接受 `#{...}`。
4. **只查变量、不查语法**：变量存在不代表 JUEL 可执行，括号、运算符、空值和值类型仍需由目标环境校验。

外部源码只作为实现时的行为参考；CLI 运行时不读取 `sei-bpm` 或 `sei-bpm-web`。

## 2. 源码契约依据

### 2.1 `sei-bpm-web`

`Process/Definition/PublicForm/Expression/ConfigModal/index.js` 表明：

- 编辑框维护使用条件 `name` 的 `logicUel`；
- 条件名称按长度倒序替换成 `code`，生成 `#{...}` 包裹的 `groovyUel`；
- 勾选默认路径会清空两个表达式；
- 保存前调用 `conBusinessEntity/validateExpression`，传入 `flowTypeId` 和完整 `groovyUel`。

CLI 使用上述双字段契约，并明确一个边界：字符串字面量中的同名文本不替换。例如：

```text
logicUel  = 文件类型=="文件类型"
groovyUel = #{fileType=="文件类型"}
```

右侧仍然是业务值，不能被误替换为变量 `fileType`。

### 2.2 `sei-bpm`

`ExpressionUtil`、`ConBusinessEntityService` 和 `GroovyAndElUtil` 表明：

- `validateExpression` 先提取 `#{...}` 中的内容；
- 读取业务实体条件属性的 `initValue` 构造变量上下文；
- 使用 JUEL 校验表达式；求值为 `false` 仍是合法表达式，只有语法/变量/类型等导致校验失败才拒绝；
- 流程启动条件和系统网关运行时也使用同一份 `groovyUel`。

| 用途 | 端点 | 方式 | 参数 |
| --- | --- | --- | --- |
| 条件字段清单 | `conBusinessEntity/getConditionPropertiesExplain` | GET | `businessEntityCode` |
| 单条表达式校验 | `conBusinessEntity/validateExpression` | POST | `{ flowTypeId, expression }` |

字段含义：

| 字段 | 含义 | 用在哪 |
| --- | --- | --- |
| `code` | 引擎变量名，例如 `fileType` | `groovyUel`：`#{fileType=="信用-客户"}` |
| `name` | 中文业务名称，例如 `文件类型` | `logicUel`：`文件类型=="信用-客户"` |
| `initValue` | 服务端校验时使用的初始值 | JUEL 语法、空值与值类型校验 |
| `remark` | 业务实体给出的说明 | 理解字段业务含义 |

## 3. CLI 能力

### 3.1 读取条件字段

```text
eadp bpm graph conditions --env <目标环境> --flow <流程类型 code/名称/Entity code>
```

输出 `kind=eadp.bpm.graph.conditions.v1`，包含：

- `conditions`：`code/name/initValue/remark`；
- `operators`：设计器提供的比较、逻辑和括号运算符；
- `expression.command`：下一步生成表达式的可执行命令；
- `priority`：网关选型优先级，系统排他网关最高。

该命令只读取条件清单，不写业务数据。

### 3.2 从一份中文条件生成双表达式

```text
eadp bpm graph expression \
  --env dev \
  --flow TBS_PROJECT \
  --logic '文件类型=="信用-客户"&&累计授信金额（客户）>=3000000'
```

输出：

```json
{
  "kind": "eadp.bpm.graph.expression.v1",
  "validated": true,
  "validatedBy": "conBusinessEntity/validateExpression",
  "expression": {
    "logicUel": "文件类型==\"信用-客户\"&&累计授信金额（客户）>=3000000",
    "groovyUel": "#{fileType==\"信用-客户\"&&customerCreditAmount>=3000000}"
  }
}
```

把 `expression` 对象用于 `process.startUEL` 或系统排他/包容网关连线的 `uel`。默认路径不要配置表达式。

生成规则：

1. 只接受已经确认业务语义的 `logicUel`；条件名称来自 `graph conditions`；
2. 条件名称最长优先替换成对应 `code`，字符串字面量保持不变；
3. 自动添加完整的 `#{...}`，不要自行嵌套或改用 `${...}`；
4. 调用目标环境 `validateExpression` 成功后才输出 `validated=true`；失败则命令失败，不输出可用表达式。

### 3.3 整图校验

`eadp bpm graph validate` 与 `eadp bpm graph import` 使用同一份目标条件清单，并检查流程启动条件、系统排他网关和系统包容网关：

| 情况 | 错误码 |
| --- | --- |
| `groovyUel` 引用了清单外变量 | `CONDITION_VARIABLE_UNKNOWN` |
| `logicUel` 引用了清单外中文条件 | `CONDITION_PROPERTY_UNKNOWN` |
| 非默认路径没有表达式，或只有中文条件 | `CONDITION_EXPRESSION_MISSING` |
| 不是完整非空 `#{...}`，或服务端 JUEL 校验拒绝 | `CONDITION_EXPRESSION_INVALID` |
| `logicUel` 与 `groovyUel` 不是同一条件 | `CONDITION_EXPRESSION_MISMATCH` |
| 条件清单读取失败或为空 | 警告 `CONDITION_CATALOG_UNAVAILABLE` |

上述表达式问题进入 `designIssues`，使 `designValid=false`；`--strict` 时同时使 `valid=false`，导入计划变为 `blocked`。

本地格式和变量检查通过后，CLI 调用目标环境 `validateExpression`。`conditions.expressionValidation` 输出：

- `attempted`：参与服务端校验的表达式位置数；
- `validated`：服务端接受的位置数；
- `failed`：服务端拒绝的位置数。

相同表达式文本在启动条件、多条连线或多张图中复用时，一次命令只发起一次远端校验，再把结果应用到各位置。服务端明确拒绝会转为 `CONDITION_EXPRESSION_INVALID`；网络、超时和 HTTP 异常直接终止命令，不得伪装成表达式错误或继续写入。

审批节点的 `uel.agree` 出口、人工排他网关、并行网关不参与该系统条件校验。

## 4. 本地解析规则

`groovyUel` 变量提取：

1. 去掉字符串字面量；
2. 取标识符，排除 `true/false/null` 等关键字；
3. 排除 `.`/`?.` 后的属性或方法名，以及平台变量 `approveResult`；
4. 剩余标识符即业务条件变量。

因此既支持设计器按钮生成的简单比较，也不会把已有表达式中的 `contains`、`size` 误当成业务变量。

`logicUel/groovyUel` 一致性比较使用同一份条件清单做名称到代码的转换；只忽略字符串外的空白，不忽略变量、运算符、值或括号的差异。

## 5. 网关选型优先级

| 优先级 | 节点 | 适用 |
| --- | --- | --- |
| 1 | `ExclusiveGateway` 系统排他 | 条件字段能判定的业务分流，一律使用 |
| 2 | `InclusiveGateway` 系统包容 | 可能同时命中多条路径 |
| 3 | `ParallelGateway` 并行 | 无条件并行 |
| 4 | `ManualExclusiveGateway` 人工排他 | 系统无法判定时的兜底 |

该优先级同时出现在 `graph guide`、`graph nodes`、`graph conditions` 和 `eadp-operator` 参考中。

## 6. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/domains/bpm-flow-graph/expression.ts` | 双表达式生成、`#{...}` 格式、语义一致性、单条服务端校验 |
| `src/domains/bpm-flow-graph/conditions.ts` | 条件清单、变量提取、整图本地/远端校验与去重 |
| `src/domains/bpm-flow-graph/references.ts` | `conditionProperties(businessEntityCode)` 只读缓存 |
| `src/domains/bpm-flow-graph/draft.ts` | `validate/import` 合并表达式结论与统计 |
| `src/commands/bpm.ts` | `graph conditions/expression/validate/import` |
| `src/domains/bpm-flow-graph/guide.ts` | 自包含表达式配置步骤和禁止事项 |
| `tests/bpm-graph-conditions.test.ts` | 命令、格式、语义一致性、服务端校验与去重回归 |
