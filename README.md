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
```

配置文件默认位于 `~/.eadp-cli/config.yaml`。也可使用 `--token-env <变量名>`，只保存环境变量名。

请求时通过 `--env dev2` 显式选择环境；省略 `--env` 时使用 `--default` 指定的默认环境。

## 通用请求

```bash
eadp request POST /api-gateway/sei-basic/serialNumberConfig/save \
  --env dev \
  --body ./serial-number.json \
  --dry-run
```

## 接口目录

```bash
eadp api domains
eadp api list --domain serial-number
eadp api describe serial-number-config-save

eadp api call serial-number-config-save \
  --body ./serial-number.json \
  --dry-run

eadp api call serial-number-config-save \
  --body ./serial-number.json \
  --yes
```

高风险接口必须先使用 `--dry-run` 检查，正式执行时添加 `--yes`。

## 在全新上下文中配置 BPM

CLI 不依赖历史对话，也不要求项目额外准备 YAML。它会从真实项目已有的
`docs/contracts/BPM流程配置登记册.md`、Gradle 项目名和前端包信息中发现：

- 业务模块
- 业务实体
- 工作页面
- 集成接口
- 实体关联关系
- 流程类型

AI 在全新上下文中只需从帮助开始：

```bash
eadp --help
eadp bpm --help
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
  --flow TBS_PROJECT
```

确认后写入默认环境：

```bash
eadp bpm configure \
  --project "D:\project\sdh\sdh-tbs" \
  --flow TBS_PROJECT \
  --apply
```

`configure` 是幂等操作：按模块代码、Entity 全限定名、页面 URL、接口 URL 和流程代码
查重；只创建缺失项，只补充缺失关系，完成后回查验证。它只完成 BPM 基础配置，不创建
流程图、审批节点或组织执行人。

## 检查功能权限和数据权限

权限命令直接读取真实 EADP 环境，不要求准备 YAML。输出使用带版本的 JSON 数据结构，
可供 AI 在全新上下文中继续规划。

检查全部功能权限元数据：

```bash
eadp permission functional inspect --json
```

按应用查看功能项，并读取指定功能角色的授权树：

```bash
eadp permission functional inspect \
  --app BASIC \
  --role ADMIN \
  --json
```

检查权限对象、权限类型和数据角色：

```bash
eadp permission data inspect --json
eadp permission data inspect --role ORG_ADMIN --json
```

为保证 `inspect` 真正只读，数据权限检查不会调用“查询时自动清理失效授权关系”的
已分配数据值接口。

按账号回查功能角色和数据角色：

```bash
eadp permission verify --user lin --json
```

也可以直接按员工号或员工姓名查询，CLI 会自动解析用户账号和用户 ID：

```bash
eadp permission verify --employee-code E1001 --json
eadp permission verify --employee-name 张三 --json
```

员工姓名匹配到多人时命令会终止并提示改用员工号，不会自动选择。

按菜单代码、名称或路径判断员工是否拥有菜单权限：

```bash
eadp permission verify \
  --employee-code 20017267 \
  --menu 租户管理 \
  --json
```

目录菜单会汇总自身及所有子菜单关联的功能项；其中任一功能项有权即表示该目录菜单可见。
菜单名称重名时命令会终止并提示使用菜单代码或路径。

校验指定用户 ID 是否拥有功能项：

```bash
eadp permission verify \
  --user lin \
  --user-id "<用户 ID>" \
  --feature BASIC_VIEW \
  --feature BASIC_EDIT \
  --json
```

校验用户对业务实体的数据范围：

```bash
eadp permission verify \
  --user lin \
  --user-id "<用户 ID>" \
  --entity-class com.example.Organization \
  --data-feature BASIC_VIEW \
  --json
```

## 配置功能角色和功能项

写入命令默认只返回差异预览。只有增加 `--apply` 才会修改远端环境。

预览创建或更新功能角色：

```bash
eadp permission functional apply \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE \
  --json
```

确认预览后执行：

```bash
eadp permission functional apply \
  --role-code BASIC_READER \
  --role-name 基础只读角色 \
  --group BASIC_ROLE \
  --apply \
  --json
```

给角色补充功能项：

```bash
eadp permission functional assign \
  --role BASIC_READER \
  --feature BASIC_VIEW \
  --feature BASIC_EXPORT \
  --json
```

确认后追加 `--apply`。命令只补充缺失功能项，不会移除角色已有权限，写入后会立即回查；
重复执行不会重复创建角色或分配关系。

## 配置数据角色和数据范围

创建或更新数据角色同样默认只预览：

```bash
eadp permission data apply \
  --role-code ORG_READER \
  --role-name 组织只读角色 \
  --group ORG_ROLE \
  --json
```

确认后追加 `--apply`。给数据角色分配业务数据 ID：

```bash
eadp permission data assign \
  --role ORG_READER \
  --auth-type ORG \
  --entity "<组织 ID 1>" \
  --entity "<组织 ID 2>" \
  --json
```

级联授权可增加 `--parent-entity-id <父实体ID>`。预览不会读取带清理副作用的已分配值；
正式 `--apply` 会读取当前授权、只补充差集并回查，因此服务端可能同时清理已经不存在的
历史授权关系。

## 查询和同步环境资源

查询 A 环境在 2026 年 7 月创建的功能项：

```bash
eadp resource query feature \
  --env A \
  --created-in 2026-07 \
  --json
```

查询命令适用于具有 `findByPage` 接口的资源，也可通过
`--filter field:operator:value` 增加过滤条件。

比较 A、B 环境的功能项：

```bash
eadp resource diff feature \
  --source A \
  --target B \
  --created-in 2026-07 \
  --json
```

预览同步和正式同步：

```bash
eadp resource sync feature \
  --source A \
  --target B \
  --created-in 2026-07 \
  --json

eadp resource sync feature \
  --source A \
  --target B \
  --created-in 2026-07 \
  --apply \
  --json
```

同步按功能项 `code` 匹配目标记录，并使用应用模块代码、功能项组代码重新解析目标环境
ID；不会复制源环境数据库 ID。同步默认只预览，当前完整注册的同步资源为 `feature`。

## 给用户或岗位分配和移除角色

按用户账号分配功能角色：

```bash
eadp permission principal assign \
  --subject-type user \
  --subject lin \
  --role-type functional \
  --role BASIC_READER \
  --json
```

按岗位代码分配数据角色：

```bash
eadp permission principal assign \
  --subject-type position \
  --subject FIN_MANAGER \
  --role-type data \
  --role ORG_READER \
  --apply \
  --json
```

`subject-type` 支持 `user`、`position`、`position-category`。岗位类别只支持功能角色。
用户主体还可以使用 `--employee-code` 或 `--employee-name`：

```bash
eadp permission principal assign \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER \
  --apply \
  --json
```

移除指定角色默认只预览：

```bash
eadp permission principal revoke \
  --subject-type user \
  --employee-code E1001 \
  --role-type functional \
  --role BASIC_READER \
  --json
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

命令默认安装到 `~/.codex/skills/eadp-operator`；设置 `CODEX_HOME` 后会安装到
`$CODEX_HOME/skills/eadp-operator`。`upgrade` 只升级已经安装的 Skill；首次使用时
请先运行 `eadp skill install`。
