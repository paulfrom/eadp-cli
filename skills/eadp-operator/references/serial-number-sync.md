# Serial-number synchronization

Use this workflow for migrating 给号配置 between named environments.

This file supplies serial-number domain enum meanings and identity rules only.
When registration, environments, selectors, fields, defaults, or options are
missing or ambiguous, use only the needed
`eadp resource inspect serial-number [compare|sync]` form.
If the live contract disagrees with a detail below, stop and request the updated
project-backed contract; do not guess or silently widen support.

1. If any required value is missing or ambiguous, inspect only that information;
   otherwise execute the compare or sync preview directly. Resolve environment
   candidates with the read-only CLI only when necessary.
2. Require both environments to record `tenantCode === "global"` (the global administrator)
   before any remote read. Use the CLI resource name `serial-number`.
3. Resolve the entity's fully qualified `entityClassName`; do not use a short class name.
4. Select enum names only from the complete server-defined sets below. Infer from business meaning,
   but never invent a value:
   - `ConfigType`: `CODE_TYPE` (主数据编号), `BAR_TYPE` (条码).
   - `CycleStrategy`: `MAX_CYCLE` (达到最大号后循环), `DAY_CYCLE` (按日循环),
     `MONTH_CYCLE` (按月循环), `YEAR_CYCLE` (按年循环).
   - `ReturnStrategy`: `NEW` (每次新给号), `REPEAT` (同一关联对象优先复用已有条码),
     `PATCH` (补号；仅在业务明确需要补号策略时选择).
   - `LinkCharacter`: `EMPTY` (空字符串), `DASH` (`-`), `DOT` (`.`), `PIPE` (`|`),
     `COLON` (`:`).
   - Built-in `DefaultElement`: `FIXED_CODE` (固定编码), `DATE_CODE` (日期编码),
     `SERIAL_CODE` (流水号编码). `elementCode` may also use a custom element code already
     registered in the target service; resolve it read-only instead of guessing.
5. Preview with explicit filters when selecting one entity or configuration type. `configType` remains
   only an explicit query/compare selection filter and is never added automatically:

```text
eadp resource compare serial-number --source A --target B --filter entityClassName:EQ:com.example.Order --filter configType:EQ:CODE_TYPE
```

6. The business identity is the composite `entityClassName + tenantCode`; `configType` is only the
   selection filter and never part of the key. The CLI trims and case-normalizes both fields for
   comparison. It validates each source record's actual composite key, then binds the desired key and
   target lookup to the target environment's recorded `tenantCode`. Stop if the same composite key is
   duplicated in either environment or if either key field is missing. A single
   source or target record with a missing or invalid `configItem` is instead reported as `blocked`;
   continue comparing and applying safe records. Review create/update/delete/unchanged/blocked, every
   changed field, and every `blockingIssues` entry before adding `--apply`.
7. Apply only after authorization and require `verified: true`:

```text
eadp resource sync serial-number --source A --target B
eadp resource sync serial-number --source A --target B --apply
```

The CLI replaces source record and `configItem` IDs with target IDs, maps the composite key to the
target environment's recorded `tenantCode` (including `desired.tenantCode` and post-write lookup),
and performs an idempotent post-write query. When creating a target configuration, a missing, null,
or blank `configType` defaults to `CODE_TYPE`, and a missing, null, or blank `returnStrategy` defaults
to `NEW`; explicit legal values such as `BAR_TYPE` are retained. These defaults apply only to new
records; an update preserves the existing target value when the source value is missing. During
`--apply`, require `skippedBlocked` to match the blocked count and report the skipped composite keys.
Never provide or override `tenantCode` manually.
