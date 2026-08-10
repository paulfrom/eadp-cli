# Serial-number synchronization

Use this workflow for migrating 给号配置 between named environments.

1. Run `eadp sync --help` and resolve both environments with `eadp env list`.
2. Require both environments to have `tenantCode: global` before any remote read.
3. Resolve the entity's fully qualified `entityClassName`; do not use a short class name.
4. Preview with `configType` defaulting to `CODE_TYPE`:

```text
eadp sync serial-number --source A --target B --entity-class com.example.Order
```

To select only source configurations created in August 2026:

```text
eadp sync serial-number --source A --target B --created-in 2026-08
```

Combine `--created-in` with `--entity-class` when both time and entity scope are required. Do not
combine `--created-in` with `--from` or `--to`.

5. Stop if `entityClassName` is duplicated in either environment. Review create/update/unchanged and
   every changed field before adding `--apply`.
6. Apply only after authorization and require `verified: true`:

```text
eadp sync serial-number --source A --target B --entity-class com.example.Order --apply
```

The CLI replaces source record and `configItem` IDs with target IDs, sets `tenantCode` from the target
environment recorded by `env add`, preserves the configuration values, and performs an idempotent
post-write query. Never provide or override `tenantCode` manually.
