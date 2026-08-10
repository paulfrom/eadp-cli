# Query and audit workflow

Use this workflow for requests such as:

- 查询 A 环境 7 月新增的功能项
- 查询某时间段创建或修改的配置
- 按员工号或员工姓名查询权限

## Resource query

1. Run `eadp query --help`.
2. Resolve the environment name and resource endpoint name.
3. For “某月新增”, use an explicit `YYYY-MM` with `--created-in`.
4. For a custom time range, use `--from`, `--to`, and the correct `--time-field`.
5. Add exact filters with `--filter field:operator:value`.
6. Run the query; JSON is the default output format.

Examples:

```text
eadp query feature --env A --created-in 2026-07
eadp query feature --env A --from "2026-07-01 00:00:00" --to "2026-08-01 00:00:00"
eadp query feature --env A --filter appModuleCode:EQ:BASIC
eadp query serialNumberConfig --env GLOBAL --entity-class com.example.Order
```

`--to` is exclusive. For a full month, prefer `--created-in` to avoid end-of-month mistakes.

The generic query command requires the resource to expose `findByPage`. If the server rejects the field or resource, inspect the corresponding backend controller rather than guessing another field.

For `serialNumberConfig`, use a `global` environment. `--config-type` defaults to `CODE_TYPE`,
and `--entity-class` selects the business-unique `entityClassName`. Stop if the CLI reports
duplicate `entityClassName` values. A missing record means the name is available for creation.

## Permission query

1. Run `eadp verify --help`.
2. Prefer `--employee-code`.
3. Use `--employee-name` only for an exact unique employee name.
4. Use `--user` only when the account is explicitly known.
5. For feature checks, repeat `--feature`.
6. For menu visibility checks, repeat `--menu` with an exact menu code, name, or path.
7. For data scope checks, provide the entity class and optional feature code.
8. To reverse-query all users with an effective feature permission, run
   `eadp inspect permission users --feature <code>`. This uses the server's final permission
   decision for each user, including direct roles, positions, and position categories.

Examples:

```text
eadp verify --env A --employee-code E1001
eadp verify --env A --employee-name 张三
eadp verify --env A --employee-code E1001 --feature BASIC_VIEW
eadp verify --env A --employee-code E1001 --menu 租户管理
eadp inspect permission users --env A --feature BASIC_VIEW
```

When the CLI reports duplicate employee names, return the candidate employee numbers and request one; do not retry using an arbitrary ID.

For a directory menu, the CLI checks the feature codes attached to the selected menu and all
descendant menus. The menu is visible when at least one of those feature checks is true. If a
menu name matches multiple nodes, stop and request an exact menu code or path.

## Output interpretation

- `items`: queried resource records.
- `featureRoles` and `dataRoles`: effective role results returned for the account.
- `featureChecks`: explicit feature-code decisions.
- `menuChecks`: resolved menu nodes, related feature codes, individual decisions, and final visibility.
- `authorizedEntityIds`: effective data-scope IDs.
- `notes`: important limitations, such as account-only lookup without a user ID.
