# EADP CLI

面向 EADP 的多环境 API 命令行工具。每个环境名称直接对应一个 URL 和一个 Token。

## 安装与开发

```bash
npm install
npm run build
npm run install:local
```

`install:local` 会先构建并打包，再把 `.tgz` 作为独立副本安装到 npm 全局目录。不要使用
`npm link` 发布日常使用版本：链接安装会直接依赖源码目录，而构建过程会短暂清空
`dist`，此时执行任何子命令都可能报 `Cannot find module .../dist/cli.js`。

使用发布脚本发布 npm 包：

```bash
npm run release -- patch
npm run release -- minor --dry-run
```

脚本会检查 npm 登录状态，按版本参数升级版本号，执行构建、测试、`.tgz` 隔离安装验证，
然后发布到 npm。`--dry-run` 不修改版本号，也不会真正发布。

升级已安装的全局 CLI 和随包发布的 Skill：

```bash
eadp update
```

该命令执行 `npm install --global eadp-cli@latest`，然后调用升级后的 CLI 同步
`eadp-operator` Skill。需要可用的 npm 网络和全局安装权限；任一步失败都会停止，
不会自动重试。

## 配置环境

```bash
eadp env add dev \
  --url http://10.232.2.126 \
  --token "<admin Token>" \
  --default

eadp env add dev2 \
  --url http://10.232.2.126 \
  --token "<tenant-admin Token>"

eadp env list
eadp env remove dev2
```

配置文件默认位于 `~/.eadp-cli/config.yaml`。也可使用 `--token-env <变量名>`，只保存环境变量名。

`env add` 会读取并保存 `tenantCode`；验证失败时不会保存新的 Token。
Token 或 Token 环境变量发生变化后，必须重新执行对应的 `env add`。
后续命令只能读取这里保存的 `tenantCode`；调用参数不能自行指定或覆盖租户代码。

`env remove <name>` 删除该环境的本地 URL 和 Token 配置；如果删除的是默认环境，
默认环境会被清空，不会自动选择其他环境。

请求时通过 `--env dev2` 显式选择环境；省略 `--env` 时使用 `--default` 指定的默认环境。

`--timeout <ms>` 和 `--compact` 是全局运行参数，可放在业务命令之前或之后。例如：
`eadp --timeout 60000 --compact resource list`。所有命令默认输出 JSON；
`--compact` 将普通 JSON 压缩为单行。资源查询默认返回带环境和总数的 JSON 结果。

## 回滚新增与分配

成功产生新增记录或新增分配关系的高层写命令会返回 `operationId`，并在配置目录的
`operations` 子目录按 UTC 日期聚合保存本地 JSONL 操作日志。日志不包含 URL 或 Token，保留 1 天；到期后在
后续记录或回滚操作时自动清理。

```powershell
eadp rollback <operation-id>
```

`rollback` 由用户事后显式执行，直接实施回滚，不要求 `--apply`。CLI 按原操作的相反顺序撤销：
先移除本次新增的分配关系，再删除本次新增的实体。删除前会回查记录并比对原写入字段；记录已被
后续修改、存在服务端依赖、环境不一致或任一接口失败时立即停止，不自动重试。更新已有记录不在
本回滚范围内；预览和幂等未变更操作不会生成 `operationId`。

租户隔离规则：

- 只有 `tenantCode === "global"` 的环境才表示全局管理员；CLI 资源名应用模块（`app-module`）、菜单（`menu`）、功能项（`feature`）、
  功能项组（`feature-group`）和给号配置（`serial-number`）的全部远端增删改查只能使用该环境；对应的真实后端路径
  `appModule`、`featureGroup`、`serialNumberConfig` 同样受租户校验；
- 权限、岗位配置与分配、用户查询、BPM 配置以及其他操作只能使用非 `global` 环境；
- `call` 也执行同样的路径租户校验，不能通过通用接口绕过规则。

## 调用接口

```bash
eadp call POST /api-gateway/sei-basic/serialNumberConfig/save \
  --env global \
  --body ./serial-number.json \
  --dry-run
```

## 接口目录

接口目录采用最小必要集合，包含组织、岗位、员工查询，用户权限核查，菜单权限判断，BPM 只读查询
和给号接口。`inspect api` 输出接口 ID、接口名称、路径、风险和可调用状态；指定接口 ID 可继续
查看请求体和查询参数。动态查询模板会列出有限的资源示例，但必须通过对应业务命令执行。

```bash
eadp inspect api --domains
eadp inspect api --domain serial-number
eadp inspect api serial-number-config-save

eadp inspect api --domain organization
eadp inspect api --domain permission
eadp inspect api permission-role-menu-feature-tree

eadp call permission-role-menu-feature-tree \
  --env dev \
  --query featureRoleId=<功能角色ID> \
  --dry-run

eadp call serial-number-config-save \
  --body ./serial-number.json \
  --dry-run

eadp call serial-number-config-save \
  --body ./serial-number.json \
  --yes
```

给号保存请求中的 `tenantCode` 由 CLI 使用当前环境在 `env add` 时取得的值覆盖，
`serial-number.json` 无需提供该字段。

高风险接口必须先使用 `--dry-run` 检查，正式执行时添加 `--yes`。

## 在全新上下文中配置 BPM

CLI 不依赖历史对话，也不要求项目额外准备 YAML 或 BPM 流程配置登记册。它直接从
`BaseFlowController`、Entity、API `PATH` 和项目元数据中发现流程骨架，并从真实 BPM 回调中发现可选集成接口：

- 业务模块
- 业务实体
- 工作页面
- 集成接口
- 实体关联关系
- 流程类型

只要代码中存在可解析的 BPM 流程骨架就会产生候选流程；BPM 回调和 `startDefaultFlow` 均不是必要条件。仅返回成功的空回调不会生成集成接口；
没有前端路由代码证据时不会臆造工作页面配置。

AI 在全新上下文中只需从帮助开始：

```bash
eadp --help
eadp bpm inspect --help
```

先检查项目中可发现的流程：

```bash
eadp bpm inspect \
  --project "D:\project\sdh\sdh-tbs"
```

预览指定流程的基础配置：

```bash
eadp bpm configure \
  --project "D:\project\sdh\sdh-tbs" \
  --flow com.sdh.tbs.project.entity.Project
```

确认后写入默认环境：

```bash
eadp bpm configure \
  --project "D:\project\sdh\sdh-tbs" \
  --flow com.sdh.tbs.project.entity.Project \
  --apply
```

`bpm configure` 是幂等操作：按模块代码、Entity 全限定名、页面 URL、接口 URL 和流程代码
查重；只创建缺失项，只补充缺失关系，完成后回查验证。它只完成 BPM 基础配置，不创建
流程图、审批节点或组织执行人。

`bpm configure --flow` 只接受 Entity 全限定名或目标环境中已有的 BPM 流程类型 `code`，不按
流程名称匹配。Entity 全限定名唯一且不冲突时可以新增基础流程配置；页面和集成接口分别
只以 `pcUrl` 和 `url` 作为唯一定位、查重及关联边界。明确选择的 Entity 即使不在常规
流程候选清单中也可以建立基础定义；缺少可解析 API PATH 时，服务名默认采用 Entity 简单
类名的 lowerCamel 形式。

## 检查功能权限和数据权限

权限命令直接读取真实 EADP 环境，不要求准备 YAML。输出使用带版本的 JSON 数据结构，
可供 AI 在全新上下文中继续规划。

检查全部功能权限元数据：

```bash
eadp permission inspect functional
```

按应用查看功能项，并读取指定功能角色的授权树：

```bash
eadp permission inspect functional \
  --app BASIC \
  --role ADMIN
```

检查权限对象、权限类型和数据角色：

```bash
eadp permission inspect data
eadp permission inspect data --role ORG_ADMIN
```

按功能代码反查拥有最终有效权限的用户（包括直接角色、岗位和岗位类别继承）：

```bash
eadp permission inspect users --feature BASIC_VIEW --env dev
```

该命令逐个用户调用服务端最终权限判定；任一请求失败时立即终止，不会重试。

为保证 `inspect` 真正只读，数据权限检查不会调用“查询时自动清理失效授权关系”的
已分配数据值接口。

按账号回查功能角色和数据角色：

```bash
eadp permission verify --user lin
```

也可以直接按员工号或员工姓名查询，CLI 会自动解析用户账号和用户 ID：

```bash
eadp permission verify --employee-code E1001
eadp permission verify --employee-name 张三
```

员工姓名匹配到多人时命令会终止并提示改用员工号，不会自动选择。

按菜单代码、名称或路径判断员工是否拥有菜单权限：

```bash
eadp permission verify \
  --employee-code 20017267 \
  --menu 租户管理
```

目录菜单会汇总自身及所有子菜单关联的功能项；其中任一功能项有权即表示该目录菜单可见。
菜单名称重名时命令会终止并提示使用菜单代码或路径。

校验指定用户 ID 是否拥有功能项：

```bash
eadp permission verify \
  --user lin \
  --user-id "<用户 ID>" \
  --feature BASIC_VIEW \
  --feature BASIC_EDIT
```

校验用户对业务实体的数据范围：

```bash
eadp permission verify \
  --user lin \
  --user-id "<用户 ID>" \
  --entity-class com.example.Organization \
  --data-feature BASIC_VIEW
```

## 配置功能角色和功能项

写入命令默认只返回差异预览。只有增加 `--apply` 才会修改远端环境。

新增功能项仅允许使用 `tenantCode: global` 的环境。`--code`、`--name`、`--app` 和
`--feature-type` 必填；创建缺失 code 时，应用模块及可选功能项组按代码、名称或 ID 唯一
解析，写入时使用解析出的目标 ID。功能类型只能是 `Operate`、`Business` 或 `Page`：

```bash
eadp permission apply feature \
  --env global-dev \
  --code BASIC_VIEW \
  --name 查看基础数据 \
  --app BASIC \
  --feature-type Page \
  --group BASIC_DATA \
  --url /basic/view \
  --can-menu \
  --tenant-can-use
```

确认预览后追加 `--apply`。该命令只创建，不更新已有记录；同 `code` 会先按代码查重，已存在
时返回 `action: "unchanged"`、`applied: false`，且不会解析依赖或调用保存接口。创建成功会
按代码回查并返回 `operationId`，如需撤销可显式执行 `eadp rollback <operationId>`。

新增功能项组使用明确的应用模块代码；命令默认只预览，且同 `code` 已存在时只查询功能项组
并返回 `unchanged`，不会读取或创建应用模块：

```bash
eadp permission apply feature-group \
  --env global-dev \
  --app-code AMS \
  --code AMS_ORDER \
  --name 订单功能组 \
  --project D:/project/order
```

应用模块不存在时，CLI 从 `--project`（省略时为当前路径）的 Gradle/package 项目名称或业务
代码注释推断不超过 8 个字的模块名，`rank` 默认为 1；确认预览后追加 `--apply`，将在同一
次操作中按“创建模块→回查→创建功能项组→回查”执行。模块和功能项组只创建、不覆盖已有
记录，并共享一个 `operationId`；显式执行 `eadp rollback <operationId>` 会按逆序删除。

预览创建或更新功能角色：

```bash
eadp permission apply functional-role \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE
```

确认预览后执行：

```bash
eadp permission apply functional-role \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE \
  --apply
```

给角色补充功能项：

```bash
eadp permission assign feature \
  --role BASIC_READER \
  --feature BASIC_VIEW \
  --feature BASIC_EXPORT
```

确认后追加 `--apply`。命令只补充缺失功能项，不会移除角色已有权限，写入后会立即回查；
重复执行不会重复创建角色或分配关系。

## 配置数据角色和数据范围

创建或更新数据角色同样默认只预览：

```bash
eadp permission apply data-role \
  --role-code ORG_READER \
  --role-name 组织只读角色 \
  --group ORG_ROLE
```

确认后追加 `--apply`。给数据角色分配业务数据 ID：

```bash
eadp permission assign data \
  --role ORG_READER \
  --auth-type ORG \
  --entity "<组织 ID 1>" \
  --entity "<组织 ID 2>"
```

级联授权可增加 `--parent-entity-id <父实体ID>`。预览不会读取带清理副作用的已分配值；
正式 `--apply` 会读取当前授权、只补充差集并回查，因此服务端可能同时清理已经不存在的
历史授权关系。

## 查询和同步环境资源

查询完整菜单树时，CLI 调用菜单专用的 `getMenuTree` 接口，并将树扁平化为 NDJSON；每条
记录额外包含 `parentCode`，可使用 `--quick` 或 `--filter` 在本地筛选：

```bash
eadp resource query menu --env global-dev --quick 采购
```

新增菜单默认只预览。父菜单和功能项均按代码唯一解析，正式新增后返回可供事后回滚的
`operationId`：

```bash
eadp menu create \
  --env global-dev \
  --name 采购申请 \
  --code PURCHASE_APPLY \
  --parent-code PURCHASE \
  --feature-code PURCHASE_APPLY

eadp menu create \
  --env global-dev \
  --name 采购申请 \
  --code PURCHASE_APPLY \
  --parent-code PURCHASE \
  --feature-code PURCHASE_APPLY \
  --apply
```

省略 `--code` 时由服务端给号；CLI 会从保存结果读取实际代码并回查验证。

查询 A 环境在 2026 年 7 月创建的功能项：

```bash
eadp resource query feature \
  --env A \
  --created-in 2026-07
```

应用模块是 global 资源，使用 CLI 资源名 `app-module` 按代码查询；远端是否存在
必须以查询结果为准，不能把 `sei.application.code` 配置值当作已注册结论：

```bash
eadp resource query app-module --env global-dev --filter code:EQ:ams
```

查询命令统一覆盖 `paged`、`findAll` 和菜单树读取策略，也可通过
`--filter field:operator:value` 增加过滤条件。默认输出包含完整 `items` 与实际 `total` 的
`eadp.resource.query.v1` JSON；需要低 token 的逐行结果时使用全局
`--output compact-ndjson`。

查询给号配置时，`configType` 仅用于筛选，不参与业务唯一键；查询不会隐式添加该筛选。
CLI 按 `entityClassName + tenantCode` 复合键逐条判重，缺少任一键字段会明确失败：

```bash
eadp resource query serial-number \
  --env global \
  --filter entityClassName:EQ:com.example.Order \
  --filter configType:EQ:CODE_TYPE
```

预览比较 A、B 环境的功能项：

```bash
eadp resource compare feature \
  --source A \
  --target B \
  --created-in 2026-07
```

预览同步和正式同步：

```bash
eadp resource sync feature \
  --source A \
  --target B \
  --created-in 2026-07

eadp resource sync feature \
  --source A \
  --target B \
  --created-in 2026-07 \
  --apply
```

同步按功能项 `code` 匹配目标记录，并使用应用模块代码、功能项组代码重新解析目标环境
ID；不会复制源环境数据库 ID。若个别功能项的目标依赖缺失或不唯一，该记录会标记为
`blocked` 并列入 `missingDependencies`，不会中断其余记录的完整差异比较。正式同步只写入
安全的 `create`、`update` 记录，跳过 `blocked` 记录并报告 `skippedBlocked`。

功能项组按 `code` 精确选择和匹配，应用模块也按代码映射到目标环境：

```bash
eadp resource sync feature-group \
  --source A \
  --target B \
  --filter code:EQ:ISRM-PA-OLD-2

eadp resource sync feature-group \
  --source A \
  --target B \
  --filter code:EQ:ISRM-PA-OLD-2 \
  --apply
```

菜单按 `code` 匹配。`--code` 选择该菜单及其全部后代；不提供时比较完整菜单树。同步按
父菜单优先的顺序执行，并通过源记录的 `parentCode`、`featureCode` 在目标环境重新解析
`parentId`、`featureId`：

```bash
eadp resource sync menu --source global-dev --target global-test --code PURCHASE
eadp resource sync menu --source global-dev --target global-test --code PURCHASE --apply
```

目标父菜单或功能项缺失/不唯一时，相关菜单标记为 `blocked`，其余菜单继续完成差异预览；
正式同步跳过 `blocked`。已有菜单需要变更父节点（包括移动到根节点）时，CLI 使用服务端
`menu/move` 的 `TreeNodeMoveParam` 契约，不会尝试通过普通 `save` 改父节点。

同步默认只预览，当前支持 `app-module`、`feature`、`feature-group`、`menu`、`bpm` 和 `serial-number`。
执行 `sync` 前会先校验源、目标环境的租户条件；任一环境不满足时立即停止，
不会读取迁移数据，也不会写入目标环境。

按流程代码、名称或 Entity 代码同步 BPM 基础配置：

```bash
eadp resource compare bpm --source dev --target ead --flow 采购申请
eadp resource sync bpm --source dev --target ead --flow 采购申请 --apply
```

按实体完整类名同步给号配置；`configType` 需要筛选时显式传入：

```bash
eadp resource sync serial-number \
  --source global-dev \
  --target global-ead \
  --filter entityClassName:EQ:com.example.Order \
  --filter configType:EQ:CODE_TYPE \
  --apply
```

BPM 同步重新映射模块、实体、页面、接口、流程类型及关系 ID；给号同步按
`entityClassName + tenantCode` 匹配，先校验源记录复合键，再将目标匹配和写入使用的
`tenantCode` 绑定为目标环境由 `env add` 获取的值；`configType` 不参与键计算。
CLI 会清除源配置和 `configItem` ID，两者重复执行均只处理差异。
BPM 业务实体的 `auditTypeId`、`auditTypeName` 不随源环境迁移，目标环境始终置空。

BPM 同步会先完成整个流程的只读规划，再开始目标写入。源流程、业务实体或业务模块等
主干无法唯一确定时会在零写入状态下终止；单个页面或接口缺少业务 URL、或者目标 URL
不唯一时，该记录标记为 `blocked`，其余安全资源继续同步。结果通过 `blockingIssues`、
`summary.blocked` 和 `skippedBlocked` 报告跳过项。

批量给号同步中，单条配置缺少或包含非法 `configItem` 时同样标记为 `blocked`，不会阻断
其他安全配置；源或目标的 `entityClassName + tenantCode` 复合键重复仍属于全局唯一性错误并立即终止。

## 扩展普通资源与特殊操作

普通资源通过 `src/resource/catalog.ts` 中的 `ResourceContract` 声明接入，不需要新增命令。
契约必须同时描述服务与接口、读取/分页策略、业务唯一键、可比较和可写字段、租户策略、
能力开关、时间过滤边界、创建默认值及安全回滚目标；注册后自动获得
`resource query/write/compare/sync`。存在目标依赖 ID 映射或字段规范化时，再实现
`ResourceAdapter` 并登记到适配器注册表。普通资源更新按补丁语义处理：输入中未出现的
可写字段保留目标值，只有显式提供的值才参与更新；契约声明的创建默认值只作用于新增。

菜单树、BPM 聚合、权限分配这类无法抽象为独立记录 CRUD 的操作继续使用代码处理器。
资源型特殊处理器由契约的 `handler` 选择；权限使用独立的 `permission` 领域命令树，避免把
审批、树移动或关系分配逻辑塞进通用资源引擎。

## 给用户或岗位分配和移除角色

按用户账号分配功能角色：

```bash
eadp permission assign role \
  --subject-type user \
  --subject lin \
  --role-type functional \
  --role BASIC_READER
```

按岗位代码分配数据角色：

```bash
eadp permission assign role \
  --subject-type position \
  --subject FIN_MANAGER \
  --role-type data \
  --role ORG_READER \
  --apply
```

`subject-type` 支持 `user`、`position`、`position-category`。岗位类别只支持功能角色。
用户主体还可以使用 `--employee-code` 或 `--employee-name`：

```bash
eadp permission assign role \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER \
  --apply
```

移除指定角色默认只预览：

```bash
eadp permission revoke role \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER
```

确认后追加 `--apply`。`assign` 只补充指定角色，`revoke` 只移除指定角色，二者都会在
写入后重新查询验证。

## AI Skill

项目只维护一个 `eadp-operator` Skill，内部按需加载查询审计、资源同步、权限管理、BPM、
给号和回滚等工作流；后续新增工作流也继续加入该 Skill，不拆分为多个 Skill。主要入口包括：

- 查询与审计
- 跨环境资源同步
- 权限授予与撤销
- BPM 与给号
- 回滚

Skill 源码位于 `skills/eadp-operator`，不包含任何环境 URL 或 Token。AI 使用 Skill 时
仍会先通过 `eadp --help`、`eadp env list` 和相关子命令帮助发现当前 CLI 能力。
任何 CLI 或 EADP 接口返回失败时，Skill 要求 AI 立即停止并如实反馈，不自动重试、
修改参数重试或改用其他接口绕过；只有用户明确给出新指令后才能继续。

安装或升级当前 npm 包内置的 Skill：

```bash
eadp skill install
eadp skill upgrade
```

命令始终安装到 `~/.codex/skills/eadp-operator`；设置 `CODEX_HOME` 后改用
`$CODEX_HOME/skills/eadp-operator`。还会自动同步到已发现平台的用户级目录：

- WorkBuddy：`~/.workbuddy/skills/eadp-operator`，可用 `WORKBUDDY_HOME` 覆盖根目录；
- Claude：`~/.claude/skills/eadp-operator`，可用 `CLAUDE_HOME` 覆盖根目录；
- Qoder：`~/.qoder/skills/eadp-operator`，可用 `QODER_HOME` 覆盖根目录。

默认根目录不存在且没有设置对应环境变量时，该平台会被跳过。`upgrade` 只升级各平台中
已经安装的 Skill；所有已发现平台都未安装时会提示先执行 `eadp skill install`。
