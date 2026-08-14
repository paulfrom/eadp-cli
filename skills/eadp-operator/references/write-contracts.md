# Write contracts

在任何可能新增记录的 `apply`、`assign` 或 `sync` 工作流中（包括 `sync --apply`），预览前先读取本文件并校验写入字段。以下长度只记录已确认的接口契约；未列出的 DTO 字段长度不得猜测默认值。

## 输入与内部映射

把用户提供的代码、名称、枚举和值按表校验；把标为“内部映射”的 ID 通过目标环境只读查询解析。不要让用户提供跨环境 ID，也不要复制源环境 ID。

| 写入接口 | 用户可输入且必须校验 | CLI 内部映射、默认与边界 |
| --- | --- | --- |
| `menu/save` | `code` 最多 20；`name` 必填、最多 20；`iconCls` 可选、最多 30；`rank` 必须 `>= 0` | 用 `parent-code` 解析 `parentId`，用 `feature-code` 解析 `featureId`；不接收 ID。菜单层级、父先子后和 `menu/move` 语义继续由 `resource-sync.md` 管理。 |
| `appModule/save` | `code` 必填、最多 20；`name` 必填、最多 30；`rank` 必填且 `>= 1` | `apply feature-group` 自动创建模块时，模块 `name` 另受最多 8 个字符的 CLI 规则约束；`--app-code` 仍按最多 20 校验。 |
| `featureGroup/save` | `code`、`name` 必填，各最多 30 | `appModuleId` 必填、最多 36；仅按目标 `app-code` 只读解析，不接受或复制跨环境 ID。 |
| `feature/save` | `code` 必填、最多 50；`name` 必填、最多 30；`groupCode` 最多 128；`url` 最多 400；`featureType` 必填且仅 `Operate`、`Business`、`Page`；`tenantCanUse` 必填 | `appModuleId`、`featureGroupId` 各最多 36；仅解析目标依赖，不让用户提供或复制跨环境 ID。其余现有 feature 规则继续适用。 |
| `featureRole/save` | `code`、`name` 必填，各最多 50；`roleType` 必填且仅 `CanUse`、`CanAssign`；`ignoreParent` 必填，CLI 默认 `false` | `featureRoleGroupId` 必填、最多 36；按组 `code`、`name` 或 ID 只读解析且必须唯一，不能跨环境复制 ID。 |
| `dataRole/save` | `code`、`name` 必填，各最多 50；`ignoreParent` 必填，CLI 默认 `false` | `tenantCode` 最多 10，但始终绑定已配置环境；禁止手填、推断或覆盖。`dataRoleGroupId` 必填、最多 36；只读解析目标组，不能复制源 ID。 |
| `serialNumberConfig/save` | `entityClassName` 必填、最多 128；显式提供的 `configType` 必须使用合法枚举；`name` 必填、最多 32；`expressionConfig` 可选、最多 32；`minNumber` 必填；`activated` 必填 | 新增记录源 `configType` 缺失、为 `null` 或空白时使用资源注册默认 `CODE_TYPE`；其余枚举、默认值和复合唯一键规则继续由 `serial-number-sync.md` 管理。查询/比较时 `configType` 仍仅是显式筛选条件，不参与业务唯一键。源记录不符合本契约时停止该写入，不篡改后继续。 |
| BPM `conFlowType/save` | `name` 必填、最多 50；`code` 必填 | `businessEntityId` 必填；通过项目 Entity/远端只读结果解析，不复制源环境 ID。BPM 工作流生成的流程配置短名称仍受最多 15 个字的更严格业务规则约束；其他 BPM DTO 未声明明确长度，不写默认 255。 |

## 失败处理

- 对用户提供的缺失、非法或超限输入，在预览前拒绝且不得发起远端调用；不得自动截断、缩写、填充或猜测替代值。让用户确认新的唯一值后再重新预览。
- 同步预览发现源记录超限或违反契约时，停止该记录并按既有 `record-level invalid` 语义报告；不得改写源记录后继续写入。保持全量差异和其他记录的 `blocked` 报告规则。
- CLI 已验证菜单 `code` 的新增长度校验；不要声称除菜单外 CLI 已经具备这些字段的本地校验。Skill 负责在预览前执行全部契约检查。
