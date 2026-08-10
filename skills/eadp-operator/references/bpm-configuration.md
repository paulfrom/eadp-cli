# BPM configuration

Use this workflow for `eadp inspect bpm`, `eadp apply bpm`, and `eadp sync bpm`.

## Route BPM intent before generic resources

- Explicit BPM intent takes precedence over generic resource, configuration, or migration wording.
- Never map a BPM flow name to `feature`. Select `feature` only when the user explicitly requests a
  功能项 or feature operation.
- Parse “把开发环境的bpm采购申请配置迁移到ead环境” as:
  source environment = 开发环境, target environment = ead环境, BPM flow selector = 采购申请.
  Resolve both environment names with `eadp env list` and the non-global BPM tenant rule.
- Use the dedicated command and never substitute `sync feature`, another resource, or a raw request:

```text
eadp sync bpm --source 开发环境 --target ead环境 --flow 采购申请
```

- Resolve `--flow` against the source flow code, flow name, Entity code, or Entity name. Require one
  exact match; stop on zero or multiple matches.
- Require both environments to be non-global before reading source or target BPM data.
- Preview without `--apply`. After authorization, repeat with `--apply` and require `verified: true`.
- `sync bpm` does not accept time filters. Select exactly one source flow with `--flow`; never add
  `--created-in`, `--from`, `--to`, or `--time-field`.
- Synchronize the business module, entity, pages, integration interfaces, flow type, and missing
  entity-page/entity-interface relations. Map dependencies to target IDs; never copy source IDs.
- Always set target business-entity `auditTypeId` and `auditTypeName` to null. Ignore source audit
  association values instead of copying, resolving, or blocking on them.
- Repeated execution is idempotent: update changed writable fields, reuse unchanged records, and add
  only missing relations.

## Discover only implemented flows

- Discover BPM definitions from Controller, Entity, API path, workflow callbacks, service calls, and frontend routes.
- Never require or infer from `BPM流程配置登记册.md`.
- Use the Entity fully qualified class name as the default flow model code.
- Exclude empty callbacks and configuration that has no real business behavior.
- Classify a callback that returns `Executor` personnel data as `CUSTOM_PERSON` (自定义人).
  Classify workflow lifecycle callbacks that do not return personnel as `EVENT` (事件).
  Never register every integration callback as `EVENT`; derive the type from the Java return contract.

## Name workflow configuration from comments

1. Read the closest useful 代码注释 before naming a workflow interface, page, selector, or event.
   Prefer method Javadoc, `@Operation` summary/description, and the inline comment immediately above
   the business call. Use class comments only for the business subject, not for the action.
2. Summarize the comment as “business subject + action/timing”. Use concise names such as
   `XXX流程结束后`, `XXX选人`, or `XXX流程提交前`.
3. Keep every configured name 不超过 15 个字. Remove filler such as
   “接口”, “事件”, “处理”, and repeated module words before shortening the business subject.
4. Never copy a Java method name, Controller name, or Entity class name directly as the configured
   name. Never mechanically append a generic suffix when the comment does not support that meaning.
5. If no useful code comment exists, or the comment cannot uniquely establish the business meaning,
   treat the name as unresolved and ask the user. Do not invent a name or perform the write.

Examples:

- `// 流程结束后发起盖章` → `盖章流程结束后`
- `// 获取销售负责人和项目负责人` → `销售项目负责人选人`
- `// 流程提交前检查合同必填项` → `合同流程提交前`

Before previewing or applying, count the final visible name and reject any value longer than 15 个字.
