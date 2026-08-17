# EADP CLI 同类项目调研——聚焦版（Terraform × Salesforce sf）

## 0. 选择说明与其他项目速览

### 0.1 为什么选这两个项目

| 类别 | 选定项目 | 选型理由 |
| --- | --- | --- |
| 基础设施/编排 | **Terraform**（hashicorp/terraform） | "plan/apply 分离 + 机器可读协议 + 幂等收敛"的行业标准；EADP 的 ChangeSet 信封、预览/`--apply`、写后验证、依赖编排与之**最直接对标**。EADP 已吸收其核心思想，剩余差距集中在"协议细节与审查闭环"，见第 2 节 |
| 元数据/环境同步 | **Salesforce CLI (sf)**（forcedotcom/cli） | 多环境元数据同步 CLI 中最成熟：source tracking（本地/远端差异）、preview→validate→start 三级、唯一键重映射与 EADP 跨环境资源同步**高度同构**。EADP 已实现唯一键查重/ID 重映射/写后验证，剩余差距集中在"增量能力与分级校验"，见第 3 节 |
---

## 1. EADP CLI 现状（最小上下文）

- **环境模型**：环境名直接绑定 URL+Token（`~/.eadp-cli/config.yaml`，`--token-env` 存变量名）。
- **资源模型**：`ResourceContract`（`src/resource/core/contracts.ts`）声明服务/接口、分页策略、
  业务唯一键、可比较/可写字段、租户策略、能力开关、创建默认值、安全回滚契约、删除契约；
  注册期强校验（能力组合、无环依赖、回滚契约完整性）。
- **执行模型**：通用引擎（`src/resource/core/engine.ts`）统一执行 query/write/compare/sync，
  阶段钩子（load/plan/aggregatePlan/apply/verify）；ChangeSet 信封
  （`src/resource/core/change-set.ts`）使用 create/update/delete/unchanged/blocked +
  missingDependencies。
- **安全模型**：默认预览（dry-run），`--apply` 才写入；写后回查验证；operationId 操作日志 +
  显式 `rollback`；blocked 门禁（依赖缺失标记 blocked 并跳过）；租户校验；失败立即停止、不自动重试。
- **AI 模型**：内置 `eadp-operator` Skill（随 npm 包分发，装到 Codex/WorkBuddy/Claude/Qoder 用户级
  skills 目录）；所有命令默认输出 JSON（`--output json|compact|compact-ndjson`）；
  `resource list/describe` 暴露能力边界；高层能力可在全新上下文仅凭 `--help` 被发现。

---

## 2. Terraform 深度分析

> 参考：https://github.com/hashicorp/terraform ；官方文档 developer.hashicorp.com（见附录 A）。

### 2.1 核心设计框架（6 个机制）

**① plan/apply 分离，计划文件是一等公民**
`terraform plan` 读取配置与 state，先 refresh（把 state 刷到真实世界），再对比"配置 vs state"，
生成执行计划（每个资源实例的动作：create/update/delete/no-op/replace/read）。`plan -out=tfplan`
把计划序列化为二进制文件，`apply tfplan` **原样执行已审查的计划**（apply 时不再重算配置）——
保证"审查过的计划"与"实际执行的变更"严格一致，防止审查后配置被改导致漂移执行。
这是"**计划即契约**"的核心：可保存、可版本化、可传输、可机器解析。

**② state 与后端**
state 是 Terraform 唯一的持久事实：保存资源地址（type.name）→ 远端对象 ID 与属性、敏感字段标记、
依赖元数据（销毁顺序）、serial/lineage。远程后端统一抽象为"读写 + 加锁"（LockID 防并发互相覆盖）。
`state mv/rm/import` 做重命名、放弃纳管、采纳已有资源。
> 与 EADP 的本质差异：EADP **没有持久 state，以远端环境为唯一事实源**、每次实时查询对比
> （天然双向漂移检测）。这一点 EADP 更接近 Pulumi 的 goal-state 模型，是设计立场，不必照搬 state。

**③ provider 插件模型与能力协商**
每个 provider 是独立进程，经 gRPC + 协议版本握手；`GetProviderSchema` 响应带
`server_capabilities`（GetProviderSchemaOptional / PlanResourceChange / MoveResourceState），
core 依据能力决定执行路径，老/新版本优雅降级。schema 声明字段的
required/optional/computed/sensitive/ForceNew 语义，**由 schema 元数据自动推导 diff 动作**，
core 不写死任何具体资源。
> 对应 EADP：`ResourceContract.capabilities` + 注册期强校验已是同构思想；差距在
> "能力协商是否在运行时路径判定"与"字段语义（ForceNew → 替换）是否驱动 diff 动作"。

**④ 依赖 DAG 与执行编排**
配置解析时构建 DAG（隐式属性引用 + 显式 `depends_on` + 模块/provider 级依赖）；apply 按
**拓扑序**执行、无依赖的资源并行（`-parallelism`）、destroy **反向**遍历；
`create_before_destroy` 让 replace 先建新再删旧，降低停机窗口。
> 对应 EADP：`ResourceContract.dependencies[]` + 注册期无环校验 + "父先子后创建、子先父后删除"
> 已是同构；差距在拓扑是否在预览阶段**显式输出**给人类/AI 审查。

**⑤ 机器可读协议与语义化退出码**
`terraform show -json` 输出**版本化 JSON 协议**：`format_version` +
`resource_changes[].change`（`actions` 是数组，可表达 ["delete","create"] 复合动作；
`before/after/after_unknown` 字段级前后值；`replace_paths` 触发替换的字段路径；
`relevant_attributes` 参与计算的配置路径；`resource_drift` 漂移记录）。人读 UI 与机器协议分离。
`plan -detailed-exitcode`：**0=无变更 / 1=失败 / 2=有变更**，CI 不解析文本即可判定。

**⑥ 漂移 / 幂等 / 失败处理**
- 漂移：plan 默认先 refresh；`plan/apply -refresh-only` 只把 state 刷到真实世界、不产生配置变更，
  专门用于漂移审计（JSON 有 `resource_drift` 段）；`import` 采纳"存在但未纳管"的资源。
- 幂等：diff 引擎对每个资源比较"配置 vs 刷新后的 state"，无差异 → `no-op`
  （"No changes. Infrastructure is up-to-date."），重复执行稳定收敛。
- 失败：apply 遍历 DAG，**一旦某资源失败，walker 停止调度新节点（fail-fast）**，已完成步骤写入
  state（**部分成功是常态**）；用户修复后重新 apply 收敛剩余部分——靠"state 即进度 + 重跑收敛"
  实现最终一致，**没有事务回滚**。

### 2.2 与 EADP CLI 的映射表

| Terraform 机制 | EADP 对应环节 | EADP 现状 | 差距 |
| --- | --- | --- | --- |
| plan/apply 分离 | `resource write/sync` 预览 + `--apply` | 同命令预览/执行，同 schema | 无"计划文件绑定"；预览即同一次调用，可加"applied 段回写回查结果" |
| state/后端 | —（设计立场不同） | 无持久 state，以远端为事实源 | 不照搬；可借鉴"本地审计基线"（见借鉴点 5） |
| provider 能力协商 | `ResourceContract.capabilities` + 注册期校验 | 注册期强校验（save+rollback 强制） | 缺运行时路径判定；缺 `replacementFields`（ForceNew 语义） |
| 依赖 DAG | `dependencies[]` + `assertDependencyGraphAcyclic` | 注册期无环校验 + 父先子后执行 | 拓扑未在 ChangeSet 中显式输出 |
| show -json | ChangeSet 信封 `changeSetKind: v1` | before/desired/changedFields/summary | 缺 `formatVersion`/字段级 `fieldDiffs`/`relevantAttributes` |
| -detailed-exitcode | 所有命令退出码 | 错误一律退出 1 | **缺语义化退出码**（0 收敛/1 有差异/2 失败） |
| refresh-only | `resource compare`（已只读） | compare 是"源 vs 目标"双环境 | 缺"目标 vs 自身基线"的单环境 refresh 审计 |
| no-op 收敛 | `unchanged` + summarizeChanges | 有 unchanged 动作 | 缺 `converged: true` 顶层收敛标记 |
| 失败处理 | fail-stop + operationId 日志 | 失败立即停止 | 缺结构化部分结果（区分 blocked 规划期跳过 / failed 执行期失败） |

### 2.3 提炼的借鉴要点（5 条，聚焦可执行）

**T1. 语义化退出码（P0）** —— `-detailed-exitcode` 思想
- 落地：`eadp resource compare/sync/write` 预览路径退出码：`0`=已收敛（summary 全 unchanged）、
  `1`=失败/中止、`2`=存在 create/update/delete/blocked 待处理差异；`--apply` 路径保持 0/1。
- 受益：CI 与 AI 零解析判断"是否有漂移"；Skill 同步工作流按退出码分支。
- 注意：与"失败立即停止"兼容——退出码只是机器信号，不改变业务规则。

**T2. 版本化 ChangeSet 协议 + 字段级 diff（P0）** —— `show -json` 思想
- 落地：信封增加 `formatVersion`（独立于 `changeSetKind`）；每条 change 增加
  `fieldDiffs: {field, before, after}[]`（仅比较契约声明的可比较字段），`--output compact`
  时省略以省 token；可选 `relevantAttributes`（差异判断依据）。
- 受益：AI 精确知道"改了哪个字段、从什么改成什么"，无需整记录 before/desired 传输。
- 测试：每个信封字段做 golden JSON 快照测试，防协议漂移。

**T3. 计划审查闭环（P1）** —— 计划文件绑定思想
- 落地：`sync --apply` 前输出可审查的 plan 摘要；apply 后把"回查结果"作为 `applied` 段写回
  同一信封（before → after → appliedVerified），一次调用即可证明收敛；
  配合 `converged: true` 顶层标记（create+update+delete+blocked === 0 时输出"已收敛"）。
- 受益：把"幂等"从口头承诺变成可机器验证的契约；AI 可机械对比"预览→确认→执行→回查"。

**T4. 依赖拓扑显式化（P1）** —— DAG 思想
- 落地：compare 的 ChangeSet 输出**拓扑执行顺序数组**（create 顺序 / delete 逆序），
  预览阶段即可审查依赖编排；`missingDependencies` 指明缺失节点在拓扑中的位置。
- 受益：解释"为什么 blocked、先补什么"；为"可独立迁移的依赖资源提供专用同步能力"规则提供依据。

**T5. 只读漂移基线（P1）** —— `-refresh-only` 思想
- 落地：新增 `eadp resource refresh <name> --env <env>`：重读目标环境全量记录，与"上次 apply 后
  回查快照"对比，输出 `drift` 段到 ChangeSet 信封；快照存 `~/.eadp-cli/snapshots/`，
  **只作审计基线、绝不作为事实源**（严守"以远端为准"）。
- 受益：获得"目标环境自身漂移"视角（compare 是源 vs 目标，refresh 是目标 vs 自身基线），
  可定时执行形成漂移审计。

---

## 3. Salesforce CLI (sf) 深度分析

> 参考：https://github.com/forcedotcom/cli ；官方文档 developer.salesforce.com（见附录 A）。

### 3.1 核心设计框架（6 个机制）

**① 环境别名与登录态解耦**
`sf org login web|device|jwt` 建立登录态，`--alias` 给环境起逻辑名；**别名只是指向持久化认证记录
的指针**（凭据落盘与别名解耦，可迁移、可改名、可换默认）。`sf org list` 枚举所有已登录 org
（含默认标记），`org display` 查看单环境详情（instanceUrl/username/accessToken）；默认目标
（target-org）可配置、可用 `-o/--target-org` 覆盖，CI 用环境变量注入。
> 对应 EADP：`eadp env add/list/remove` + `--default` + `--env` 覆盖已是同构；
> `env list` 已提供结构化 JSON；当前差距是缺少 `env check` 连通性与租户校验。

**② source tracking：本地/远端差异状态**
面向源代码格式项目：每个连接过的 org 在项目内 `.sf/orgs/<username>/` 保存
`localSourceTracking.json` 与 `remoteSourceTracking.json`（本地文件指纹 vs 远端 SourceMember
的 Tooling API 状态），算出"本地有远端无 / 两边都改了 / 远端有本地无"的**差异集**；
`deploy/retrieve` **默认只处理差异**（也可显式指定文件/manifest）；`reset tracking`/`delete
tracking` 重建/清除基线。
> 这是"增量同步"与"预览"的基础，也是 EADP 最值得借鉴的机制（EADP 目前每次 compare 全量拉取）。

**③ 部署流三级渐进：preview → validate → start**
- `deploy preview`：基于 source tracking **本地计算**将要部署的组件清单与状态
  （每条组件 **Success/Error/Warning 分级**），**不调用部署 API、不写 org**；`--json` 可机器消费。
- `deploy validate`：真正跑一次部署管线并运行 Apex 测试，但**不保存任何变更到 org**——
  用于发布前确认"能部署且测试能过"。
- `deploy start`：真实部署；`--dry-run` 只预览不写；部署是**异步作业**，返回 job id，
  断线可 `resume --job-id` 恢复、`cancel --job-id` 取消；结果按组件给 Success/Error 明细。

**④ 唯一键与数据库 ID 分离、目标 ID 重映射**
跨环境部署一律用**业务唯一键**（元数据 API name；数据 external id upsert）匹配，
数据库 ID 不跨环境；导入时按唯一键重新映射（连接引用、环境变量按 unique name 重新绑定）。
> 对应 EADP：`businessKey` 查重 + 目标 ID 重映射 + parentCode/featureCode 先父后子重映射
> **已实现**——该设计获行业验证（sf external id / pac 连接引用 / ServiceNow sys_id 同思路）。

**⑤ 写后验证与回滚语义**
Metadata API 部署支持 `rollbackOnError`：批内任一组件失败则**整体回滚（all-or-nothing）**；
Dataverse solution 导入事务性、失败回滚。长任务异步执行 + 取消/恢复。
> 对应 EADP：写后回查 + operationId 日志 + 显式 rollback 已实现；**取舍差异**：EADP 走多个
> 业务接口无法平台级事务，是"逐记录回查 + 显式回滚"，需在帮助中写明与 all-or-nothing 的区别。

**⑥ 统一输出协议与自动命令参考**
所有命令统一 `--json` 信封（错误也结构化）；oclif 自动生成 `--help`；
`@salesforce/plugin-command-reference` 从命令代码**自动生成命令参考文档/JSON**，
保证"帮助即文档"、AI 可发现；`sf plugins install/link` + hooks 支持扩展。
> 对应 EADP：默认 JSON + `resource describe` 契约 JSON 已近似；差距在"命令树 schema 输出"
> （`eadp help --json`）。

### 3.2 与 EADP CLI 的映射表

| sf 机制 | EADP 对应环节 | EADP 现状 | 差距 |
| --- | --- | --- | --- |
| 别名/登录态解耦 | `eadp env add/list/remove` + `--default` | 环境名直接绑定 URL+Token，`env list` 已输出结构化 JSON | 缺 `env check` 校验命令 |
| source tracking | `resource compare/sync` | 每次全量拉取 + 全量比较 | **缺每环境本地基线状态文件 → 增量 compare** |
| preview/validate/start | 预览 + `--apply` + blocked 门禁 | 默认 dry-run；blocked 仅"能/不能"两态 | 缺 warning 级分级与 `--validate`（强制规划+回查不写入） |
| 唯一键/ID 重映射 | businessKey 查重 + 目标 ID 重映射 | 已实现（菜单/功能项/BPM/给号） | 行业验证通过；可补"禁止迁移 ID"契约校验 |
| rollbackOnError | 写后回查 + 显式 rollback | 逐记录回查 + 逆序回滚 | 无平台级事务（取舍差异，需文档化）；缺异步 job |
| 统一 --json + 命令参考 | 默认 JSON + `resource describe` | 契约 JSON 即"活 schema" | 缺命令树 schema（`help --json`） |

### 3.3 提炼的借鉴要点（5 条，聚焦可执行）

**S1. 每环境本地基线状态文件 → 增量 compare（P1）** —— source tracking 思想
- 落地：配置目录新增 `~/.eadp-cli/state/<env>/<resource>.baseline.json`（业务唯一键 →
  可比较字段指纹）；compare 先取远端列表与基线比对算增量，再按契约做字段级 compare；
  sync 成功后更新基线；提供 `reset-tracking` 重建基线。
- 谨慎：基线只是"上次我以为的样子"——必须保留 `--full` 全量选项，源端被外部修改导致
  指纹失配时自动降级全量；基线绝不作事实源。

**S2. 预览分级 + `--validate` 模式（P1）** —— preview/validate/start 思想
- 落地：预览每条 change 增加 `severity: safe|warning|blocking`（依赖缺失=blocking 现机制；
  目标存在但将被覆盖外部修改 / ID 重映射不确定 = warning；其余 safe）；
  新增 `sync --validate`：执行完整规划 + 依赖解析 + 目标环境回查，**不写入**
  （与 preview 的差别：是否强制依赖解析与回查）。
- 受益：blocked 门禁从"全有全无"升级为分级，规则可解释。

**S3. 环境可枚举可校验（P1）** —— `org list/display` 思想
- 现状：`eadp env list` 已输出每环境的名称、URL、租户、默认标记和脱敏 tokenSource；
  落地：新增 `eadp env check [name]`，执行只读连通性 + 租户条件校验（对应"跨环境迁移前必须校验源/目标
  租户"的既有规则），失败即停止。
- 约束：保持"一个环境名 = 一个 URL + 一个 Token"，不引入 account/credential 概念
  （AGENTS.md 硬性规则）。

**S4. 幂等收敛语义显式化（P1）** —— 与 Terraform no-op 合并
- 落地：ChangeSet 增加 `converged: true` 顶层标记；每个 write 命令固化
  "预览 → apply → 回查 → 二次 compare" 验证闭环（回查结果写回 `applied` 段）；
  测试：同一输入连续执行两次 sync，第二次 summary 必须全 unchanged。
- 受益：把"重复执行幂等"从口头承诺变成可机器验证的契约。

**S5. 异步长任务 job-id + resume/cancel（P2）** —— `deploy --async` 思想
- 落地：`sync --async` 立即返回 operationId，`eadp operation status <id>` 查询进度；
  断线后用户**显式** `--resume <id>`（必须用户发起，遵守"失败立即停止、不自动重试"规则）；
  复用现有 operationId 日志体系扩展为可恢复作业，不新增独立机制。

---

## 4. 提炼后的可执行借鉴要点汇总（去重，P0/P1/P2）

| 优先级 | 要点 | 来源 | 落地模块 |
| --- | --- | --- | --- |
| **P0** | 1. compare/sync 语义化退出码（0 收敛 / 1 有差异 / 2 失败） | Terraform | `src/commands/resource.ts` |
| **P0** | 2. ChangeSet 版本化（formatVersion）+ 字段级 `fieldDiffs{field,before,after}` | Terraform | `src/resource/core/change-set.ts` |
| **P1** | 3. 每环境本地基线 + 增量 compare + `reset-tracking` | sf | `src/operations/` + `compare` |
| **P1** | 4. 预览分级 `safe/warning/blocking` + `sync --validate` | sf | 引擎 plan 阶段 + `resource sync` |
| **P1** | 5. 计划审查闭环：`applied` 段回写回查结果 + `converged` 标记 | Terraform + sf | 引擎 apply/verify + 信封 |
| **P1** | 6. 依赖拓扑显式输出（create/delete 顺序数组） | Terraform | ChangeSet 信封 |
| **P1** | 7. `env check` 连通性与租户校验 | sf | `src/commands/env.ts` |
| **P1** | 8. 只读 `refresh` 漂移审计（目标 vs 自身基线） | Terraform | `resource refresh` + snapshots |
| **P2** | 9. 异步 job-id + resume/cancel | sf | operationId 体系扩展 |
| **P2** | 10. 结构化部分结果（区分 blocked 规划期跳过 / failed 执行期失败） | Terraform/Pulumi | `eadp.resource.result.v1` 信封 |

> 设计原则：以上全部不改变既有业务规则（失败即停、不自动重试、以远端为事实源、
> 环境=URL+Token、只维护单一 eadp-operator Skill），只把"已存在的设计"升级为
> "更可机器消费、更可审查"的形态。

## 5. 落地路径建议

- **迭代 1（P0，改动集中）**：要点 1 + 2 —— 修改 `src/resource/core/change-set.ts`（信封
  formatVersion、fieldDiffs）与 `src/commands/resource.ts`（退出码）；同步更新
  `skills/eadp-operator` references 与 README 中的退出码/输出说明。
- **迭代 2（P1 增量能力）**：要点 3 + 4 —— 基线存储 + 增量 compare + reset-tracking；
  预览分级 + `--validate`。这两项是"增量同步"与"分级校验"的主体。
- **迭代 3（P1 闭环与可用性）**：要点 5 + 6 + 7 + 8 —— 审查闭环（applied/converged）、
  拓扑输出、env list/check、refresh 审计。
- **迭代 4（P2 按需）**：要点 9 + 10 —— 异步任务与结构化部分结果。
- 每项改动落地后运行 `npm run check`（构建 + 全量测试），并补充对应测试
  （协议快照、退出码、幂等重跑、基线失配降级等）。

---

## 附录 A：参考链接（Terraform + sf 一手来源）

### Terraform
- 仓库：https://github.com/hashicorp/terraform
- plan/show/state 命令：https://developer.hashicorp.com/terraform/cli/commands
- JSON output format：https://developer.hashicorp.com/terraform/internals/v1.15.x/json-format
- State & Backends：https://developer.hashicorp.com/terraform/language/state
- Plugin protocol（能力协商）：https://developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol
- Resource Graph：https://mintlify.wiki/hashicorp/terraform/concepts/resource-graph
- refresh-only 教程：https://developer.hashicorp.com/terraform/tutorials/cloud-get-started/cloud-refresh-only
- 实现参考（jsonplan）：https://github.com/hashicorp/terraform/blob/c55346f6acc7e14c30bee7cf477e06d5bf7bd747/command/jsonplan/jsonplan.go

### Salesforce CLI (sf)
- 仓库：https://github.com/forcedotcom/cli ；架构：https://github.com/salesforcecli/cli/blob/main/ARCHITECTURE.md
- 命令参考：https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/
- deploy preview/validate/start：
  https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_project_deploy_preview.html
  （validate、start 同路径）
- Source Tracking 深挖：https://developer.salesforce.com/blogs/2020/04/a-deep-dive-into-source-tracked-projects
- 元数据部署 rollbackOnError：https://developer.salesforce.com/blogs/2025/09/take-a-deep-dive-into-metadata-api-deployments
- 命令参考自动生成：https://unpkg.com/@salesforce/plugin-command-reference@3.1.81/README.md

### EADP CLI（本地核实）
- `src/resource/core/contracts.ts`、`src/resource/core/engine.ts`、`src/resource/core/change-set.ts`、
  `src/commands/resource.ts`、`src/commands/env.ts`、`src/operations/store.ts`、`README.md`、
  `skills/eadp-operator/SKILL.md`
