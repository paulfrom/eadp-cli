# Permission management workflow

Use this workflow for:

- 为某用户新增某功能或数据权限
- 去掉某用户的某权限
- 给岗位或岗位类别分配角色

EADP grants permissions through functional or data roles. Resolve the requested “权限” to a role before changing a principal. Do not claim that assigning a role is equivalent to a direct feature grant without inspecting that role.

## Resolve the requested permission

1. Run `eadp inspect permission --help`.
2. Inspect functional roles with:

```text
eadp inspect permission functional --env A
```

3. Inspect data roles with:

```text
eadp inspect permission data --env A
```

4. If the user names a feature rather than a role, identify a role containing that feature. If no unique role is suitable, report the ambiguity instead of creating a broad role automatically.

## Resolve the principal

- User by employee number: `--subject-type user --employee-code E1001`
- User by exact name: `--subject-type user --employee-name 张三`
- User by account: `--subject-type user --subject zhangsan`
- Position: `--subject-type position --subject FIN_MANAGER`
- Position category: `--subject-type position-category --subject MANAGER`

Employee name duplicates must stop the workflow. Position categories do not support direct data-role assignment.

## Grant

Preview:

```text
eadp assign role --env A --subject-type user --employee-code E1001 --role-type functional --role BASIC_READER
```

After authorization:

```text
eadp assign role --env A --subject-type user --employee-code E1001 --role-type functional --role BASIC_READER --apply
```

`assign` only adds missing requested roles.

## Revoke

Preview:

```text
eadp revoke role --env A --subject-type user --employee-code E1001 --role-type functional --role BASIC_READER
```

After authorization:

```text
eadp revoke role --env A --subject-type user --employee-code E1001 --role-type functional --role BASIC_READER --apply
```

`revoke` only removes the explicitly requested roles. Before applying, explain that permissions inherited from positions, position categories, projects, or other roles may remain effective.

## Verify

After either change:

```text
eadp verify --env A --employee-code E1001
```

Require the mutation result to report `verified: true`, then use `verify` to show the employee’s resulting effective roles. For a named feature, add `--feature FEATURE_CODE`.
