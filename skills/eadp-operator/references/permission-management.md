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

数据角色目录没有 `dataRole/findByPage`。CLI 先调用
`GET dataRoleGroup/findAll`，再按返回顺序逐组调用
`GET dataRole/findByDataRoleGroup?roleGroupId=<groupId>`，聚合并按数据角色 `id`
去重；角色组缺少 `id` 时应立即停止。

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

用户角色关系使用 `POST userDataRole/insertRelations`，岗位角色关系使用
`POST positionDataRole/insertRelations`；CLI 会先读取
`getChildrenFromParentId`，只提交尚未存在的角色。岗位类别不支持直接分配数据角色。

给数据角色分配数据范围时，非级联关系使用
`POST dataRoleAuthTypeValue/insertRelations`，级联关系使用
`POST dataRoleAuthTypeValue/insertRelationsByParentEntityId`。

## Copy direct employee permissions

Use `eadp assign permission` to compare one employee with another in the same
non-global tenant environment. It copies only directly assigned functional
roles, data roles, and all positions. Public roles are identified by a
non-null/non-undefined `publicUserType` and are reported under `skippedPublic`;
they are never assigned. The operation is add-only: existing target relations
are reported as `alreadyAssigned`, no relation is removed, and preview is the
default.

Preview the complete difference:

```text
eadp assign permission --env A \\
  --source-employee-code E1001 --target-employee-code E1002
```

Apply the missing relations after reviewing the preview:

```text
eadp assign permission --env A \\
  --source-employee-name 张三 --target-employee-name 李四 --apply
```

The result includes `requested`, `skippedPublic`, `alreadyAssigned`, and
`added` details plus per-category counts for functional roles, data roles, and
positions. `action: "unchanged"` means no eligible relation differs. Apply
re-reads all three relation sets and requires `verified: true`; API failures
stop immediately without retries or later writes. A successful apply returns
one rollback-capable `operationId` covering the relation resources.

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
主体角色回滚使用对应关系资源的 `DELETE .../removeRelations`；数据范围回滚使用
`POST dataRoleAuthTypeValue/removeRelations` 或级联的
`POST dataRoleAuthTypeValue/removeRelationsByParentEntityId`。

## Verify

After either change:

```text
eadp verify --env A --employee-code E1001
```

Require the mutation result to report `verified: true`, then use `verify` to show the employee’s resulting effective roles. For a named feature, add `--feature FEATURE_CODE`.
