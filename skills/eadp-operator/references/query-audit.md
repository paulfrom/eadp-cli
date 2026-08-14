# Query and audit workflow

Use this workflow for requests such as:

- 查询 A 环境 7 月新增的功能项
- 查询某时间段创建或修改的配置
- 按员工号或员工姓名查询权限

## Resource query

Remote queries for CLI resources `app-module`, `menu`, `feature`, `feature-group`, and
`serial-number` require an environment whose recorded `tenantCode === "global"` (the global
administrator).

1. Run `eadp resource --help` and `eadp resource query --help`.
2. Resolve the environment name and canonical CLI resource name.
3. Use only filters declared by the resource contract; do not infer a time field or date semantics.
4. Add exact filters with `--filter field:operator:value`.
5. Run the query; pagination is completed before the structured `items`/`total` result is emitted.
   Use `--output compact-ndjson` when a row stream is explicitly needed.

Examples:

```text
eadp resource query feature --env A --filter appModuleCode:EQ:BASIC
eadp resource query app-module --env GLOBAL --filter code:EQ:ams
eadp resource query serial-number --env GLOBAL --filter entityClassName:EQ:com.example.Order --filter configType:EQ:CODE_TYPE
```

`--to` is exclusive. For a full month, prefer `--created-in` to avoid end-of-month mistakes.

The resource contract declares whether the read strategy is `paged`, `findAll`, or `tree`. If the server rejects a declared field or resource, inspect the corresponding backend controller rather than guessing another field.

For `serial-number`, use a `global` environment. `configType` is only a filter and is not part of the
business key; the query command does not add an implicit value. Use
`--filter configType:EQ:CODE_TYPE` when that selection is intended. The CLI uses the composite key
`entityClassName + tenantCode`, normalizing case and surrounding whitespace consistently. Stop if
the CLI reports a duplicate composite key or a record is missing either key field. Treat the complete
`items` result as authoritative; an empty result for the exact entity filter means no matching record
was returned, not permission to guess missing write fields.

## Permission query

1. Run `eadp permission verify --help`.
2. Prefer `--employee-code`.
3. Use `--employee-name` only for an exact unique employee name.
4. Use `--user` only when the account is explicitly known.
5. For feature checks, repeat `--feature`.
6. For menu visibility checks, repeat `--menu` with an exact menu code, name, or path.
7. For data scope checks, provide the entity class and optional feature code.
8. To reverse-query all users with an effective feature permission, run
   `eadp permission inspect users --feature <code>`. This uses the server's final permission
   decision for each user, including direct roles, positions, and position categories.

Examples:

```text
eadp permission verify --env A --employee-code E1001
eadp permission verify --env A --employee-name 张三
eadp permission verify --env A --employee-code E1001 --feature BASIC_VIEW
eadp permission verify --env A --employee-code E1001 --menu 租户管理
eadp permission inspect users --env A --feature BASIC_VIEW
```

When the CLI reports duplicate employee names, return the candidate employee numbers and request one; do not retry using an arbitrary ID.

For a directory menu, the CLI checks the feature codes attached to the selected menu and all
descendant menus. The menu is visible when at least one of those feature checks is true. If a
menu name matches multiple nodes, stop and request an exact menu code or path.

## Output interpretation

- `eadp.resource.query.v1`: environment, resource, complete `items`, and `total`.
- `--output compact-ndjson` emits a schema-first `meta` line followed by `row` lines; the count is
  authoritative only after the contract's pagination strategy has completed.
- `featureRoles` and `dataRoles`: effective role results returned for the account.
- `featureChecks`: explicit feature-code decisions.
- `menuChecks`: resolved menu nodes, related feature codes, individual decisions, and final visibility.
- `authorizedEntityIds`: effective data-scope IDs.
- `notes`: important limitations, such as account-only lookup without a user ID.
