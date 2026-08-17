# EADP CLI

面向 EADP 的多环境资源与权限命令行工具。每个环境名称直接对应一个 URL 和一种认证配置。

## 架构

EADP CLI 先区分“资源能力”和“领域工作流”，再选择命令：

1. **统一资源框架**：资源通过 `ResourceContract` 注册。契约声明服务与接口、读取和分页策略、
   业务唯一键、可比较/可写字段、租户策略、能力开关、枚举、默认值及安全回滚接口。
2. **通用执行引擎**：已注册资源按契约自动获得 `resource query/write/compare/sync` 中声明的能力，
   统一执行租户校验、差异规划、默认预览、`--apply`、`blocked` 门禁、操作日志和写后验证。
3. **资源行为扩展**：普通契约无法表达树结构或聚合规划时，资源可以绑定 adapter 或 handler/hooks，
   但仍复用同一组 `resource` 命令和 ChangeSet 生命周期，不另建一套同步协议。
4. **特殊领域命令**：权限关系、菜单新增、BPM 项目发现与配置、显式回滚等任务有独立领域命令；
   这些命令补充统一资源框架，不是原始接口绕过入口。

领域模块统一在 `src/domains/index.ts` 装配：每项包含一个 contract，并按需绑定 adapter 或 handler。
新增普通资源只需注册完整契约；只有依赖 ID 重映射、树结构或跨资源聚合等契约无法表达的行为才增加代码扩展。

## 统一资源框架命令

参数完整时直接执行目标命令；只有资源名、环境或选择器不明确时才用 `inspect` 发现：

```powershell
eadp resource inspect
eadp resource inspect <name>
eadp resource inspect <name> <action>
eadp resource query <name> --env <env>
eadp resource write <name> --env <env> --data <json>
eadp resource compare <name> --source <env> --target <env>
eadp resource sync <name> --source <env> --target <env>
```

- `inspect` 三形态：无参数列出注册资源、CLI 版本、可用环境及每个环境已记录的 `tenantCode`；`inspect <name>` 输出包含默认值、回滚与删除声明的安全契约摘要
  （能力、租户、唯一键、可写字段、枚举、选择器、时间过滤）；`inspect <name> <action>`
  输出该动作的结构化参数（必填/可选选项、当前资源的选择器、动作相关字段）。
- `query` 支持结果裁剪：`--count`（只输出总数，分页资源仅读第一页）、`--summary`
  （总数加 summaryInfo）、`--fields <a,b>`、`--limit <n>`、`--filter <field:op:value>`、
  `--quick <text>`，以及契约声明时间过滤时的 `--created-in`/`--from`/`--to`/`--time-field`。
- 资源选择器统一为 `--select <name>=<value>`（如 `--select code=PURCHASE`、`--select flow=采购申请`），
  CLI 按当前资源契约校验选择器名称与必填项。
- 并非每个资源都支持全部动作，执行前必须以当前契约的 `capabilities`、租户策略、选择器和过滤能力为准。

| 统一命令 | 用途 | 写入语义 |
| --- | --- | --- |
| `resource query <name>` | 按契约读取并完成分页聚合 | 只读 |
| `resource write <name>` | 对目标环境生成新增或更新计划 | 默认预览，`--apply` 后写入并回查 |
| `resource compare <name>` | 只读比较源、目标环境 | 输出统一 ChangeSet |
| `resource sync <name>` | 复用 compare 计划迁移安全差异 | 默认预览，`--apply` 执行安全的 create/update 及显式契约 delete |

统一 ChangeSet 使用 `create`、`update`、`delete`、`unchanged`、`blocked`；正式写入跳过 `blocked` 并报告
`skippedBlocked`，成功必须完成写后验证。任何 CLI 或 EADP 请求失败都会立即停止，不自动重试或切换接口；
错误以结构化 JSON 信封输出（`success`/`code`/`message`/`candidates`/`requiredInput`）。
资源依赖由引擎默认编排，不提供额外依赖选项；新增、更新按父到子，删除按子到父。

## 当前注册资源

下表说明当前包内置资源，便于理解能力边界；实际执行仍以当前安装版本的
`eadp resource inspect` 输出为准。

| CLI 资源名 | 类型 | 当前能力 | 租户 | 说明 |
| --- | --- | --- | --- | --- |
| `app-module` | 普通契约 | query、write、compare、sync | global | 应用模块，按 `code` 识别 |
| `employee` | 普通契约 + adapter | query、write、compare、sync | non-global | 企业员工；`user` 是别名，按 `organizationCode` 映射目标组织 ID |
| `feature` | 普通契约 + adapter | query、write、compare、sync | global | 通用操作走 `resource`；创建型高层工作流可走 `permission apply feature` |
| `feature-group` | 普通契约 + adapter | query、write、compare、sync | global | 通用操作走 `resource`；创建型高层工作流可走 `permission apply feature-group` |
| `serial-number` | 普通契约 + adapter | query、write、compare、sync | global | 给号配置，复合键为 `entityClassName + tenantCode`；`serialNumberConfig` 仅是后端接口路径 |
| `menu` | 行为扩展资源 | query、compare、sync | global | 通用操作走 `resource`；单菜单新增走 `menu create` |
| `bpm` | 行为扩展资源 | compare、sync | non-global | 跨环境操作走 `resource`；项目发现/配置走 `bpm inspect/configure` |

普通资源与行为扩展资源都从同一个注册表发现，并由同一个 `resource` 命令入口执行其已声明能力。
`serial-number` 是给号配置唯一的 CLI 资源名；后端 controller/path 名不能作为 `resource` 命令参数。

## 特殊领域命令

仅在任务属于以下领域工作流时使用特殊命令：

| 命令入口 | 使用场景 | 与资源框架的关系 |
| --- | --- | --- |
| `eadp permission apply feature ...` | 只创建功能项，同 code 已存在时跳过 | `feature` 的通用查询/写入/比较/同步仍走 `resource` |
| `eadp permission apply feature-group ...` | 只创建功能项组，并按需解析应用模块 | `feature-group`、`app-module` 的通用操作仍走 `resource` |
| `eadp permission inspect/apply/assign/revoke/verify ...` | 权限查询、角色配置、关系分配/移除和验证 | 权限关系不是普通资源 CRUD，使用独立领域命令 |
| `eadp menu create ...` | 按父菜单代码和功能项代码安全新增菜单 | 菜单查询/比较/同步仍使用 `resource ... menu` |
| `eadp bpm inspect ...` | 从真实项目代码只读发现 BPM 流程骨架 | 不访问远端，不等同于 BPM 资源同步 |
| `eadp bpm configure ...` | 幂等配置一个项目的 BPM 基础数据 | 跨环境迁移仍使用 `resource compare/sync bpm` |
| `eadp rollback <operation-id...>` | 撤销操作日志记录的新增或分配 | 只接受已登记回滚契约，不提供通用删除 |

`env` 管理环境，`skill` 管理 AI Skill，`update` 升级 CLI 与 Skill；它们属于工具管理命令，
不参与资源注册。明确出现权限、菜单新增、BPM 项目配置或回滚意图时，应进入对应领域命令，
不得改用其他资源或原始接口绕过。

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
`eadp --timeout 60000 --compact resource inspect`。所有命令默认输出 JSON；
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
- 权限、岗位配置与分配、企业员工（`employee`/`user`）查询与配置、BPM 配置以及其他操作只能使用非 `global` 环境；
- 查询、比较和同步只有在资源契约或领域命令明确要求 `global` 时才允许使用 global 环境；未明确要求
  `global`（包括契约声明 `tenant.policy: "any"`）时默认按 non-global 校验，并在任何远端请求前拒绝 global 环境；
- 资源命令和领域命令都会执行对应的租户校验，不能绕过已注册契约和领域规则。

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

查询或比较给号配置时，`configType` 仍只是显式提供的筛选条件，不参与业务唯一键；查询和比较不会隐式添加该筛选。
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
ID；不会复制源环境数据库 ID。`feature` 同步默认编排 `app-module`、`feature-group`、
`feature`，按父先子后创建/更新并在每一步重新映射目标 ID；若依赖缺失或不唯一，该记录会
标记为 `blocked` 并列入 `missingDependencies`，不会中断其余记录的完整差异比较。
目标独有记录只有在资源 `describe` 暴露完整 `deletion`（remove、lookup、restore）契约时
才会计划为 `delete`；删除按 feature→feature-group→app-module 逆序执行，并将目标快照写入
`operationId` 以支持回滚。正式同步执行安全的 `create`、`update`、`delete`，跳过 `blocked`。

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
eadp resource sync menu --source global-dev --target global-test --select code=PURCHASE
eadp resource sync menu --source global-dev --target global-test --select code=PURCHASE --apply
```

目标父菜单或功能项缺失/不唯一时，相关菜单标记为 `blocked`，其余菜单继续完成差异预览；
正式同步跳过 `blocked`。已有菜单需要变更父节点（包括移动到根节点）时，CLI 使用服务端
`menu/move` 的 `TreeNodeMoveParam` 契约，不会尝试通过普通 `save` 改父节点。

同步默认只预览，当前支持 `app-module`、`employee`（别名 `user`）、`feature`、`feature-group`、`menu`、`bpm` 和 `serial-number`。
执行 `sync` 前会先校验源、目标环境的租户条件；任一环境不满足时立即停止，
不会读取迁移数据，也不会写入目标环境。

按流程代码、名称或 Entity 代码同步 BPM 基础配置：

```bash
eadp resource compare bpm --source dev --target ead --select flow=采购申请
eadp resource sync bpm --source dev --target ead --select flow=采购申请 --apply
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
给号资源写入或同步新增记录时，源记录缺失、为 `null` 或空白的 `configType` 使用资源注册默认
`CODE_TYPE`；显式合法值（例如 `BAR_TYPE`）保留。该默认只作用于新增记录，更新时源记录缺失
`configType` 保留已有目标值。
BPM 业务实体的 `auditTypeId`、`auditTypeName` 不随源环境迁移，目标环境始终置空。

BPM 同步会先完成整个流程的只读规划，再开始目标写入。源流程、业务实体或业务模块等
主干无法唯一确定时会在零写入状态下终止；单个页面或接口缺少业务 URL、或者目标 URL
不唯一时，该记录标记为 `blocked`，其余安全资源继续同步。结果通过 `blockingIssues`、
`summary.blocked` 和 `skippedBlocked` 报告跳过项。

批量给号同步中，单条配置缺少或包含非法 `configItem` 时同样标记为 `blocked`，不会阻断
其他安全配置；源或目标的 `entityClassName + tenantCode` 复合键重复仍属于全局唯一性错误并立即终止。

## 扩展资源框架

资源通过单一模块清单接入，不需要新增通用命令：

- `src/domains/<resource>/contract.ts`：每个资源一个 `ResourceContract`，声明 API 事实与业务语义。
- `src/domains/<resource>/adapter.ts`：只有需要依赖 ID 重映射或字段规范化时才增加同领域适配器。
- `src/domains/<resource>/handler.ts`：只有普通契约无法表达聚合读取、规划、写入或验证时才实现行为扩展。
- `src/resource/handlers/`：只维护处理器接口和注册器；处理器可提供只读 `query`，或提供 `hooks`
  （`load`/`plan`/`aggregatePlan`/`apply`/`verify`）扩展通用引擎的某个阶段。
- `src/domains/index.ts`：唯一的领域模块清单；每项绑定 contract 与可选 adapter/handler。
- `src/resource/modules/contracts.ts`：定义模块装配契约。
- `src/resource/catalog.ts`：从模块清单构造并校验资源、适配器和处理器注册表。
- `src/resource/core/`：通用客户端、契约校验、资源引擎和错误模型；不依赖任何业务领域。

契约必须描述服务与接口、读取/分页策略、业务唯一键、可比较和可写字段、租户策略、能力开关、
时间过滤边界、创建默认值，以及包含显式回查 API 的安全回滚目标；需要同步目标独有记录时还必须
声明完整删除契约（remove、lookup、restore）；具备对应能力的注册资源自动获得
`resource query/write/compare/sync`。
分页契约中已确认的 `total` 记录数/页数语义会用于校验完整性；语义为 `unknown` 时不猜测，
持续读取到短页或空页后才返回完整结果。
声明 `sync` 的普通资源在注册阶段必须同时提供已确认的保存接口和安全回滚契约；查询接口同时
承担写后回查，不能等到 `--apply` 才发现契约不完整。`compare` 与 `sync` 共用同一个
ChangeSet 输出，结果包含 `changeSetKind: "eadp.resource.change-set.v1"`、统一的
`changes` 和 `summary`（`create`、`update`、`delete`、`unchanged`、`blocked`）。
行为扩展通过 `hooks.apply` 实现同一个 `write` 动作，不另建命令协议；`write` 一律由通用引擎的
apply 阶段执行，预览模式在结构上不会调用任何写钩子。只有 API 契约无法表达聚合规划、
依赖重映射或领域写入时才需要处理器代码。
普通资源更新按补丁语义处理：输入中未出现的可写字段保留目标值，只有显式提供的值才参与更新；
契约声明的创建默认值只作用于新增。

菜单树这类聚合资源通过 `hooks` 扩展通用引擎的 `load`/`plan`/`apply`/`verify` 阶段；BPM 聚合通过
`hooks.aggregatePlan` 在单一阶段完成多资源规划，再由引擎统一负责 `apply`/`verify`、blocked 门禁、
信封组装与操作日志生命周期。二者都复用同一 ChangeSet 信封，不再有任何整动作 compare/sync/write
处理器路径。权限分配保留在独立的 `permission` 领域命令树。`src/resource/handlers/` 只维护处理器
接口与注册器，菜单与 BPM 的实际实现分别位于 `src/domains/menu/handler.ts`、
`src/domains/bpm/handler.ts`；菜单创建命令位于 `src/commands/menu.ts`。新增领域只需在自己的资源
契约中声明 `selectors` 元数据（名称、值占位符、帮助文本、是否必填），并在模块清单绑定；通用命令会
自动汇总这些声明，通过统一的 `--select <name>=<value>` 校验并在发起领域请求前拒绝不适用或缺失的选择器。
当前菜单的可选 `code` 与 BPM 的必填 `flow` 选择器都来自各自契约声明，不需要修改通用命令。任何行为扩展都必须返回同一
ChangeSet 信封；通用入口统一负责默认预览、`--apply`、操作记录完成/失败以及验证安全结果；处理器
不得另起一套输出或操作生命周期。预览结果不得标记为已写入，正式执行必须报告写后验证成功，并准确
报告跳过的 `blocked` 数量。

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
