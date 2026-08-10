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
  --token "<read Token>"

eadp env list
eadp env remove dev2
```

配置文件默认位于 `~/.eadp-cli/config.yaml`。也可使用 `--token-env <变量名>`，只保存环境变量名。

`env add` 会先使用该 URL 和 Token 请求 `account/getByApiKey?apiKey=<token>`，读取并保存 `tenantCode`；验证失败时不会保存新的 Token。
Token 或 Token 环境变量发生变化后，必须重新执行对应的 `env add`。
后续命令只能读取这里保存的 `tenantCode`；调用参数不能自行指定或覆盖租户代码。

`env remove <name>` 删除该环境的本地 URL 和 Token 配置；如果删除的是默认环境，
默认环境会被清空，不会自动选择其他环境。

请求时通过 `--env dev2` 显式选择环境；省略 `--env` 时使用 `--default` 指定的默认环境。

`--timeout <ms>` 和 `--compact` 是全局运行参数，可放在业务命令之前或之后。例如：
`eadp --timeout 60000 --compact query feature --env dev`。所有命令默认输出 JSON；
`--compact` 仅将 JSON 压缩为单行。

租户隔离规则：

- 功能项、菜单、给号配置的增删改查只能使用 `tenantCode: global` 的环境；
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
Controller、Entity、API `PATH`、真实 BPM 回调、`startDefaultFlow` 调用和项目元数据中发现：

- 业务模块
- 业务实体
- 工作页面
- 集成接口
- 实体关联关系
- 流程类型

只有代码能够证明存在 BPM 业务实现时才会产生候选流程。仅返回成功的空回调会被忽略；
没有前端路由代码证据时不会臆造工作页面配置。

AI 在全新上下文中只需从帮助开始：

```bash
eadp --help
eadp inspect bpm --help
```

先检查项目中可发现的流程：

```bash
eadp inspect bpm \
  --project "D:\project\sdh\sdh-tbs"
```

预览指定流程的基础配置：

```bash
eadp apply bpm \
  --project "D:\project\sdh\sdh-tbs" \
  --flow com.sdh.tbs.project.entity.Project
```

确认后写入默认环境：

```bash
eadp apply bpm \
  --project "D:\project\sdh\sdh-tbs" \
  --flow com.sdh.tbs.project.entity.Project \
  --apply
```

`apply bpm` 是幂等操作：按模块代码、Entity 全限定名、页面 URL、接口 URL 和流程代码
查重；只创建缺失项，只补充缺失关系，完成后回查验证。它只完成 BPM 基础配置，不创建
流程图、审批节点或组织执行人。

## 检查功能权限和数据权限

权限命令直接读取真实 EADP 环境，不要求准备 YAML。输出使用带版本的 JSON 数据结构，
可供 AI 在全新上下文中继续规划。

检查全部功能权限元数据：

```bash
eadp inspect permission functional
```

按应用查看功能项，并读取指定功能角色的授权树：

```bash
eadp inspect permission functional \
  --app BASIC \
  --role ADMIN
```

检查权限对象、权限类型和数据角色：

```bash
eadp inspect permission data
eadp inspect permission data --role ORG_ADMIN
```

按功能代码反查拥有最终有效权限的用户（包括直接角色、岗位和岗位类别继承）：

```bash
eadp inspect permission users --feature BASIC_VIEW --env dev
```

该命令逐个用户调用服务端最终权限判定；任一请求失败时立即终止，不会重试。

为保证 `inspect` 真正只读，数据权限检查不会调用“查询时自动清理失效授权关系”的
已分配数据值接口。

按账号回查功能角色和数据角色：

```bash
eadp verify --user lin
```

也可以直接按员工号或员工姓名查询，CLI 会自动解析用户账号和用户 ID：

```bash
eadp verify --employee-code E1001
eadp verify --employee-name 张三
```

员工姓名匹配到多人时命令会终止并提示改用员工号，不会自动选择。

按菜单代码、名称或路径判断员工是否拥有菜单权限：

```bash
eadp verify \
  --employee-code 20017267 \
  --menu 租户管理
```

目录菜单会汇总自身及所有子菜单关联的功能项；其中任一功能项有权即表示该目录菜单可见。
菜单名称重名时命令会终止并提示使用菜单代码或路径。

校验指定用户 ID 是否拥有功能项：

```bash
eadp verify \
  --user lin \
  --user-id "<用户 ID>" \
  --feature BASIC_VIEW \
  --feature BASIC_EDIT
```

校验用户对业务实体的数据范围：

```bash
eadp verify \
  --user lin \
  --user-id "<用户 ID>" \
  --entity-class com.example.Organization \
  --data-feature BASIC_VIEW
```

## 配置功能角色和功能项

写入命令默认只返回差异预览。只有增加 `--apply` 才会修改远端环境。

预览创建或更新功能角色：

```bash
eadp apply functional-role \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE
```

确认预览后执行：

```bash
eadp apply functional-role \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE \
  --apply
```

给角色补充功能项：

```bash
eadp assign feature \
  --role BASIC_READER \
  --feature BASIC_VIEW \
  --feature BASIC_EXPORT
```

确认后追加 `--apply`。命令只补充缺失功能项，不会移除角色已有权限，写入后会立即回查；
重复执行不会重复创建角色或分配关系。

## 配置数据角色和数据范围

创建或更新数据角色同样默认只预览：

```bash
eadp apply data-role \
  --role-code ORG_READER \
  --role-name 组织只读角色 \
  --group ORG_ROLE
```

确认后追加 `--apply`。给数据角色分配业务数据 ID：

```bash
eadp assign data \
  --role ORG_READER \
  --auth-type ORG \
  --entity "<组织 ID 1>" \
  --entity "<组织 ID 2>"
```

级联授权可增加 `--parent-entity-id <父实体ID>`。预览不会读取带清理副作用的已分配值；
正式 `--apply` 会读取当前授权、只补充差集并回查，因此服务端可能同时清理已经不存在的
历史授权关系。

## 查询和同步环境资源

查询 A 环境在 2026 年 7 月创建的功能项：

```bash
eadp query feature \
  --env A \
  --created-in 2026-07
```

查询命令适用于具有 `findByPage` 接口的资源，也可通过
`--filter field:operator:value` 增加过滤条件。

查询给号配置时，`configType` 默认是 `CODE_TYPE`，CLI 会检查返回结果中的
`entityClassName` 是否唯一：

```bash
eadp query serialNumberConfig \
  --env global \
  --entity-class com.example.Order
```

预览比较 A、B 环境的功能项：

```bash
eadp sync feature \
  --source A \
  --target B \
  --created-in 2026-07
```

预览同步和正式同步：

```bash
eadp sync feature \
  --source A \
  --target B \
  --created-in 2026-07

eadp sync feature \
  --source A \
  --target B \
  --created-in 2026-07 \
  --apply
```

同步按功能项 `code` 匹配目标记录，并使用应用模块代码、功能项组代码重新解析目标环境
ID；不会复制源环境数据库 ID。同步默认只预览，当前完整注册的同步资源为 `feature`。
执行 `sync` 前会先校验源、目标环境的租户条件；任一环境不满足时立即停止，
不会读取迁移数据，也不会写入目标环境。

## 给用户或岗位分配和移除角色

按用户账号分配功能角色：

```bash
eadp assign role \
  --subject-type user \
  --subject lin \
  --role-type functional \
  --role BASIC_READER
```

按岗位代码分配数据角色：

```bash
eadp assign role \
  --subject-type position \
  --subject FIN_MANAGER \
  --role-type data \
  --role ORG_READER \
  --apply
```

`subject-type` 支持 `user`、`position`、`position-category`。岗位类别只支持功能角色。
用户主体还可以使用 `--employee-code` 或 `--employee-name`：

```bash
eadp assign role \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER \
  --apply
```

移除指定角色默认只预览：

```bash
eadp revoke role \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER
```

确认后追加 `--apply`。`assign` 只补充指定角色，`revoke` 只移除指定角色，二者都会在
写入后重新查询验证。

## AI Skill

项目只维护一个 `eadp-operator` Skill，内部包含三个按需加载的工作流：

- 查询与审计
- 跨环境资源同步
- 权限授予与撤销

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
