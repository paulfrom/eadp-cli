# Resource synchronization workflow

Use this workflow for requests such as:

- 同步 A 环境的某类配置到 B 环境
- 把 A 环境 7 月新增的功能项同步到 B 环境

## Preconditions

Menu, feature, feature-group, and serial-number synchronization is a global-administrator
operation: both source and target must record `tenantCode === "global"`. The CLI enforces this
before any remote read. The canonical CLI names `feature-group` and `serial-number` map to the
backend endpoints `featureGroup` and `serialNumberConfig`.

1. Run `eadp inspect resource --help` and `eadp sync --help`.
2. Confirm the source and target environment names are distinct.
3. Confirm the requested resource is listed as a registered sync resource.
4. Resolve “新增” to an explicit creation month or range.
5. Before reading either environment, confirm both environments satisfy the resource's tenant
   scope. Stop immediately if either tenant is invalid; do not read migration data or write the target.
6. Never use arbitrary API calls to imitate synchronization for an unregistered resource.

## Understand differential synchronization

Treat the preview as create / update / unchanged / blocked, not as create-only synchronization:

- Missing in target → `create`.
- Existing and different in writable fields → `update`.
- Existing and equal in writable fields → `unchanged`; do not write.
- A selected record whose target dependency is missing or ambiguous → `blocked`; keep comparing the
  remaining records and report the dependency under `missingDependencies`.

Time options filter source records only. After filtering, always compare every selected source record
with the target by its registered business identity.

For `serial-number`, the registered identity is the composite `entityClassName + tenantCode`;
`configType` is only a filter. Normalize case and surrounding whitespace when checking duplicates.
Build source keys from each source record's actual `tenantCode`, then map the desired key and
post-write lookup to the target environment's recorded `tenantCode`. Missing identity fields or
duplicate composite keys stop the workflow before any write.

Preview source records created in one month:

```text
eadp sync feature --source A --target B --created-in 2026-08
```

Preview an explicit left-closed, right-open source time range:

```text
eadp sync feature --source A --target B --from "2026-08-01 00:00:00" --to "2026-09-01 00:00:00"
```

Use `--time-field updatedDate` only when the user explicitly requests update-time filtering and the
resource actually exposes that field. Never reinterpret “新增” as update time.

## Compare and preview first

Run:

```text
eadp sync feature --source A --target B --created-in 2026-07
```

Review:

- `summary.create`
- `summary.update`
- `summary.unchanged`
- `summary.blocked`
- every `changedFields`
- every mapped dependency in `desired`
- every `missingDependencies` entry and its `reason`

Missing or ambiguous target dependencies do not invalidate the full comparison. The CLI reports the
affected records as `blocked`, continues the preview, and never reuses a source ID. An EADP request or
CLI failure still stops the whole workflow immediately.

The absence of `--apply` is mandatory during planning. Present create/update counts and potentially destructive updates to the user.

## Apply and verify

Only after authorization:

```text
eadp sync feature --source A --target B --created-in 2026-07 --apply
```

Require `verified: true`. During `--apply`, the CLI applies `create` and `update` records, skips
`blocked` records, and reports `skippedBlocked`. A result with `applied: false` and all items unchanged
is a successful idempotent outcome.

## Feature synchronization semantics

- Match features by `code`.
- Resolve target application module by `appModuleCode`.
- Resolve target feature group by `featureGroupCode`.
- Do not copy `id`, creation audit fields, or source dependency IDs.
- Ignore source `specialProjectId` during comparison and synchronization. Never copy it across
  environments; preserve the target environment's existing value when updating, and omit it when creating.
- Existing target features may be updated only in the writable fields reported by the CLI diff.

## Feature-group synchronization semantics

- Match feature groups by exact `code`.
- Resolve the target application module by `appModuleCode`; never copy the source `appModuleId`.
- Use `--code` to select one feature group exactly.

Preview and then apply a missing feature-group dependency:

```text
eadp sync feature-group --source A --target B --code ISRM-PA-OLD-2
eadp sync feature-group --source A --target B --code ISRM-PA-OLD-2 --apply
```

## Menu synchronization semantics

- Query menus with `eadp query menu --env <global-env>`; the CLI uses `getMenuTree`, flattens the
  tree, and emits `parentCode` for every item.
- Match menus by exact `code`.
- Use `--code` to select one menu and all of its descendants; omit it to compare the full tree.
- Apply parents before children.
- Resolve `parentId` from target `menu.code` and `featureId` from target `feature.code`; never copy
  either source ID.
- Mark a menu `blocked` when its target parent or feature is missing/ambiguous. A child of a blocked
  parent is also blocked, while independent safe menus remain applicable.
- Use the dedicated `menu/move` operation with `TreeNodeMoveParam` when an existing target menu
  changes parent, including when it moves to the root. Never change an existing parent through `save`.
- Menu sync does not support creation-time filters because the authoritative read endpoint is the
  complete tree endpoint, not `findByPage`.
- Preserve the project menu hierarchy during synchronization: one level-1 menu represents the
  application, level-2 menus classify business modules, and only level-3 menus may bind a
  `featureCode`. Reuse the target project's unique level-1 menu; never create a duplicate root or
  attach a feature directly to a level-1 or level-2 menu.

Preview and then apply a menu subtree:

```text
eadp sync menu --source A --target B --code PURCHASE
eadp sync menu --source A --target B --code PURCHASE --apply
```

## Menu creation semantics

New menu nodes must follow one explicit three-level hierarchy for each project:

- Level 1 is the single application menu for that project. A project must not have a second
  level-1 menu.
- Level 2 contains business-module categories below that application menu. It has no
  `featureCode`.
- Level 3 contains the menu that matches/binds a feature item. Only this level may carry a
  `featureCode`; a feature must never be attached directly to level 1 or level 2. Do not introduce
  a deeper level for a new menu.

Before constructing any write, perform these read-only checks in the selected global environment:

The selected `<global-env>` must record `tenantCode === "global"`; if it does not, stop before
reading menu or feature data.

1. Run `eadp query menu --env <global-env>` and inspect the flattened `parentCode` tree. Resolve the
   project's application menu by the project's known application identity and exact menu `code`.
   If exactly one level-1 menu exists, reuse its code. If more than one candidate exists, stop and
   ask the user to choose; if none exists, plan at most one new level-1 menu only after confirming
   that the project has no application menu. Never create a duplicate root.
2. Resolve the application/module identity with a read-only query such as
   `eadp query app-module --env <global-env> --filter code:EQ:<app-code>`. Query the relevant feature
   with `eadp query feature --env <global-env> --filter code:EQ:<feature-code>` (and verify its
   application module when applicable). Stop on a missing or ambiguous identity; do not guess.
3. Under the reused level-1 code, find the requested business-module category in the menu tree.
   Reuse one exact level-2 `code`; if it is absent, plan one level-2 menu with that level-1
   `--parent-code`. Confirm the level-2 candidate has no `featureCode` before using it as a parent.
4. For a feature-bound menu, require the level-2 code as its explicit `--parent-code` and the
   uniquely resolved feature code as `--feature-code`. Reject any plan that omits the parent or
   puts the feature on the level-1/level-2 menu.

Create only in parent-before-child order. Preview each planned command without `--apply`, review
the complete create set, and add `--apply` only after explicit authorization:

```text
# Only when the read-only check proved that the project has no level-1 menu:
eadp apply menu --env A --name <application> --code <application-menu-code>

# Only when the business-module category is missing:
eadp apply menu --env A --name <module-category> --code <module-menu-code> --parent-code <application-menu-code>

# A feature-bound menu is always level 3:
eadp apply menu --env A --name <feature-menu> --code <feature-menu-code> --parent-code <module-menu-code> --feature-code <feature-code>
```

If any read-only query or CLI call fails, stop immediately and report the failure; do not retry or
continue to a child write. Successful creates remain preview/apply operations, require post-write
verification, and return an `operationId`.

To create one menu, preview and then apply the dedicated command:

```text
eadp apply menu --env A --name 采购申请 --code PURCHASE_APPLY --parent-code PURCHASE --feature-code PURCHASE_APPLY
eadp apply menu --env A --name 采购申请 --code PURCHASE_APPLY --parent-code PURCHASE --feature-code PURCHASE_APPLY --apply
```

Successful menu creates return an `operationId`; rollback still requires a separate explicit user
request and `eadp rollback <operation-id>`.

## BPM synchronization semantics

- Resolve and plan the complete module, entity, page, interface, flow, and relation graph before any
  target write.
- A missing or ambiguous flow/module/entity backbone is a global error and must stop with zero writes.
- A page or interface with an invalid business URL, or an ambiguous target URL, is a record-level
  `blocked` change. Continue planning and apply the remaining safe records.
- Report `blockingIssues`, `summary.blocked`, and `skippedBlocked`. Never describe a partially blocked
  result as fully synchronized.
- An EADP request or save failure still stops immediately; do not retry.
