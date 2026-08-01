# Resource synchronization workflow

Use this workflow for requests such as:

- 同步 A 环境的某类配置到 B 环境
- 把 A 环境 7 月新增的功能项同步到 B 环境

## Preconditions

1. Run `eadp resource --help`.
2. Confirm the source and target environment names are distinct.
3. Confirm the requested resource is listed as a registered sync resource.
4. Resolve “新增” to an explicit creation month or range.
5. Never use arbitrary API calls to imitate synchronization for an unregistered resource.

## Compare first

Run:

```text
eadp resource diff feature --source A --target B --created-in 2026-07 --json
```

Review:

- `summary.create`
- `summary.update`
- `summary.unchanged`
- every `changedFields`
- every mapped dependency in `desired`

If the CLI reports a missing target dependency, stop and report the missing business code. Do not reuse the source ID.

## Preview

Run:

```text
eadp resource sync feature --source A --target B --created-in 2026-07 --json
```

The absence of `--apply` is mandatory during planning. Present create/update counts and potentially destructive updates to the user.

## Apply and verify

Only after authorization:

```text
eadp resource sync feature --source A --target B --created-in 2026-07 --apply --json
```

Require `verified: true`. A result with `applied: false` and all items unchanged is a successful idempotent outcome.

## Feature synchronization semantics

- Match features by `code`.
- Resolve target application module by `appModuleCode`.
- Resolve target feature group by `featureGroupCode`.
- Do not copy `id`, creation audit fields, or source dependency IDs.
- Stop if a source feature references a special project that the CLI cannot safely map.
- Existing target features may be updated only in the writable fields reported by the CLI diff.
