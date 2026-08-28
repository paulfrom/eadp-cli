# Query and audit

Use this reference for read-only resource queries, time-scoped audits, and
permission verification. Treat the live CLI contract as the authority; this
file contains no resource or time-support allowlist.

## Query one resource detail

Use the detail action when the user asks for one resource's complete record and
the resource contract declares `detail` in `capabilities` plus a `detail`
endpoint. This is a single-record read, not a list query narrowed locally.

1. If the resource, environment, or selector name/value is missing or
   ambiguous, run only the needed `eadp resource inspect [name] [action]` form.
   For a detail request, `eadp resource inspect <name> detail` is the source of
   truth for the required `detail.selectors`; do not infer them from `id`,
   `identityFields`, or an endpoint name.
2. Confirm `detail` in `capabilities`, confirm the environment's recorded
   `tenantCode` satisfies `tenant.policy`, and provide every declared detail
   selector exactly once with `--select <name>=<value>`.
3. When all values are complete, execute the same direct command:

   ```text
   eadp resource detail <name> --env <env> --select <selector>=<value>
   ```

   Repeat `--select` for additional declared selectors. Do not add
   `--filter`, `--quick`, time options, pagination options, or an undocumented
   `--id` option.
4. Interpret `eadp.resource.detail.v1` as one result containing the canonical
   resource, environment, selectors, and `item`. `item: null` means the exact
   selector did not identify a record; it is not permission to broaden the
   selector or fall back to `resource query`.
5. Honor `sensitiveFields`: redact those fields in the reported `item` even
   when the detail endpoint returns them. Report the exact environment and
   selectors used, without exposing credentials or endpoint details.

If `detail` is absent, a selector is unknown/missing, tenant validation fails,
or the detail request fails, stop with the structured CLI error. Do not guess a
detail endpoint, retry with a list query, switch environments, or alter the
selector.

## Query an ordinary resource

1. When the resource, environment, filter, or option is missing or ambiguous,
   run only the needed `eadp resource inspect [name] [action]` form. When they
   are already complete, execute the query directly without discovery.
2. Select one exact registered name and confirm `query` in `capabilities`.
3. Confirm the environment's recorded `tenantCode` satisfies `tenant.policy`
   before making the query. Use a global user only when the live contract
   explicitly requires `global`; `tenant.policy: "any"` defaults to
   non-global for queries and must reject a global environment before any
   remote request.
4. Use only fields declared by the contract and only `--filter` operators shown
   by the action help (`EQ`, `NE`, `LIKE`, `GT`, `GE`, `LT`, `LE`).
5. Read all pages according to `read` and `pagination`. EADP page requests use
   `pageInfo: { page, rows: 500 }`; the inner response uses `page` for the
   current page, `records` for the total record count, `total` for the total
   page count, and `rows` for the current page. Treat the returned `items` as
   complete only after the contract-driven reader reaches `total` and verifies
   the aggregate count against `records`.

The following command demonstrates the grammar only. `feature` is not a
capability claim or a static resource list; inspect it only when a required
value is missing or ambiguous.

```text
eadp resource query feature --env A --filter code:EQ:EXAMPLE_CODE
```

Use `--output compact-ndjson` only when a row stream is needed. Keep the
schema/meta line and row count; do not diagnose a user from an empty result
without reporting the exact selector and environment used.

## Query by time

1. Check `filtering.time` in the selected `inspect` result.
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
