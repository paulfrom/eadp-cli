# Query and audit

Use this reference for read-only resource queries, time-scoped audits, and
permission verification. Treat the live CLI contract as the authority; this
file contains no resource or time-support allowlist.

## Query an ordinary resource

1. Run `eadp resource list`, `eadp resource describe <name>`, and
   `eadp resource query <name> --help`.
2. Select one exact registered name and confirm `query` in `capabilities`.
3. Confirm the environment's recorded `tenantCode` satisfies `tenant.policy`
   before making the query.
4. Use only fields declared by the contract and only `--filter` operators shown
   by the action help (`EQ`, `NE`, `LIKE`, `GT`, `GE`, `LT`, `LE`).
5. Read all pages according to `read`, `pagination`, and verified
   `totalSemantics`. Never infer whether `total` means records or pages from
   its name. Treat the returned `items` and `total` as complete only after the
   contract-driven reader finishes.

The following commands demonstrate the grammar only. `feature` is not a
capability claim or a static resource list; rediscover it with `list` and
`describe` before executing.

```text
eadp resource describe feature
eadp resource query feature --env A --filter code:EQ:EXAMPLE_CODE
```

Use `--output compact-ndjson` only when a row stream is needed. Keep the
schema/meta line and row count; do not diagnose a user from an empty result
without reporting the exact selector and environment used.

## Query by time

1. Check `filtering.time` in the selected `describe` result.
2. Use the declared `defaultTimeField`, or provide `--time-field` only when the
   user or a project-backed contract establishes the correct field.
3. Use `--created-in YYYY-MM` for a creation month, or use `--from` inclusive
   and `--to` exclusive for an explicit range. Treat “新增” as creation time;
   do not silently use an update field.
4. Stop when time filtering is false or undeclared. Do not substitute another
   field, endpoint, or resource.

Executable grammar example, subject to the live contract check:

```text
eadp resource compare feature --source A --target B --created-in 2026-07
eadp resource sync feature --source A --target B --from "2026-07-01 00:00:00" --to "2026-08-01 00:00:00"
```

Time filters select source records for a migration. The target read must remain
unfiltered unless the action help and contract explicitly define another
behavior.

## Verify permissions

1. Run `eadp permission verify --help` or the relevant current permission
   command help.
2. Prefer `--employee-code`; use an exact employee name only when it resolves
   to one candidate; use an account only when it is explicitly known.
3. Add the exact feature code, menu selector, entity class, or data-scope
   selector requested by the user. Resolve a missing or ambiguous selector with
   a read-only permission query before asking the user.
4. Stop on duplicate people or failed lookups. Do not choose an arbitrary ID.

```text
eadp permission verify --env A --employee-code E1001
eadp permission verify --env A --employee-code E1001 --feature FEATURE_CODE
eadp permission inspect users --env A --feature FEATURE_CODE
```

Interpret `featureChecks`, `menuChecks`, effective role results,
`authorizedEntityIds`, and `notes` exactly as returned. A missing role
assignment and an empty authorized-entity result are different findings.

## Report read-only results

State the environment, exact resource or principal selector, exact filters and
time boundary, pagination completion, result count, and any ambiguity or
permission limitation. Never expose a Token.
