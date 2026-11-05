# Changelog

## [Unreleased]

### Added

- **P0-1 导入状态拆分**：`eadp bpm graph import --apply` 分别输出 `write` 与 `verify` 的状态和退出码。回查失败保留 `write.status=success`，以 `GRAPH_IMPORT_VERIFY_FAILED` 和退出码 2 标识；逐图输出回读节点数、边数、与本地文件的差异数量及差异摘要。写入失败时明确 `verify=skipped`，不再把已成功的草稿写入报告为整体失败。
- **P0-2 服务端异常定位**：新增 `GRAPH_SERVER_VALIDATION_FAILED`，以 `detail.locations` 返回节点名称/ID、JSON 路径、期望类型、实际值和修复提示；覆盖 `nodeConfig.otherParams.autoExecuteUser`、`notify.before.notifySelfDefinition.type`、`process.beforeStartServiceUrl` 与重复 edge id，同时适用于文件导入和契约资源图同步。
- **P0-3 图语义校验**：`validate` 新增排他网关条件重叠与全集覆盖检测、不可达节点、悬空边、非预期环及重复边 ID 检查，统一计入 `designIssues`，`--strict` 下使校验失败并非零退出。
- **P0-4 条件边标题**：携带表达式的边在 `uel.name` 为空或空白时报告 `CONDITION_LABEL_MISSING`，提供 `edgeId/jsonPath`，并纳入 strict 导入阻断。
- **P1-1 本地布局**：新增 `eadp bpm graph layout --file <path> [--check] [--write]`。几何检查输出穿节点边、交叉边、重叠节点和图总宽高；自动布局按非驳回边拓扑分层、同层水平排列并局部修复几何问题，只修改本地节点 `x/y`，支持 `--write --check` 一次验收。
- **P1-2 批量条件矩阵**：`graph expression` 新增 `--file`，一次返回全部 `logicUel/groovyUel` 对并保留输入 `key`；继续调用目标环境 JUEL 校验，相同 `groovyUel` 只校验一次。保留原 `--logic` 单条形式，二者必须且只能提供一个。
- **P1-3 统一执行人解析**：新增 `eadp bpm graph resolve-executor --env <env> --query <中文名或code>`，统一返回 `Person/Position/PositionType` 绑定和规范化 executor 片段；零候选抛 `EXECUTOR_NOT_FOUND`，多候选抛 `EXECUTOR_AMBIGUOUS` 并列出字符串及结构化候选。
- **P2-1 精简导出**：`graph export` 新增 `--trim`，只输出节点、边、条件和执行人。
- **P2-2 只读差异**：新增 `eadp bpm graph diff --file a.json --env <env> --flow <code>`，按定义名称比较本地与环境最新规范化草稿，输出 `create/update/unchanged/remote-only` 和 JSON 路径差异，不执行写入。
- **P2-3 Golden sample**：`graph guide` 新增包含系统排他网关、条件边、默认边和显式驳回边的最小结构完整样例及替换/验收步骤。
- 新错误码、含义和修复提示同时纳入 `graph nodes` 与 `graph guide`；CLI 帮助和 `eadp-operator` 工作流同步覆盖全部新命令。

### Tests

- 新增语义求解、服务端异常定位、布局几何/自动布点、执行人解析专项单元测试。
- 新增 write 成功/verify 失败、strict 缺条件标题、批量表达式去重、trim、diff、golden sample 布局和命令入口回归用例。
- 保留并运行既有 BPM 草稿迁移、条件校验、preview/apply、幂等和仅 `deploy=false` 写草稿回归。
