---
name: eadp-operator
description: Safely operate EADP through the installed eadp CLI for contract-driven resource query, write, compare, and sync plus explicit domain workflows. Discover live contracts and action help, resolve ambiguity read-only, preview and authorize writes, apply with the same command, verify the result, and stop on failures.
---

# EADP Operator

Use the installed `eadp` CLI as the only execution layer. Keep environment URLs,
Tokens, remote IDs, endpoint guesses, and static resource lists out of this Skill
and out of user-facing reports.

## Discover before planning

1. Run `eadp --help`, `eadp env list`, and the relevant domain command help.
2. For every ordinary-resource request, repeat live discovery before planning:

   ```text
   eadp resource list
   eadp resource describe <name>
   eadp resource <query|write|compare|sync> <name> --help
   ```

   Replace `<query|write|compare|sync>` with the one requested action and
   `<name>` with the exact registered resource name; run only that selected
   action's `--help` before constructing its command.
   Treat the current `list`, exact-name `describe`, and action-help output as
   the only support evidence. Never hard-code a resource-name allowlist, a
   global resource inventory, or a time-support table in this Skill.
3. Route explicit permission, menu, BPM, serial-number, and rollback intent to
   the current domain/resource command. Do not translate domain terms into an
   unrelated resource or invent `api`, `call`, or `catalog` commands.

Adding an ordinary resource requires registering a `ResourceContract` only. Do
not add a Skill branch, resource name, or example to make a newly registered
ordinary resource usable.

## Drive actions from the selected contract

Read the exact `describe` result and derive behavior mechanically. Treat
`id`, `title`, `description`, `service`, and `help` as live identity and
documentation facts; treat `query`, `save`, `read`, and `pagination` as
live transport/read facts. Do not infer an omitted endpoint, response shape, or
pagination `total` meaning. Honor each endpoint's `path` and `method`. For
pagination, honor `pageField`, `pageNumberField`, `pageSizeField`,
`startPage`, `rowsField`, `pageSize`, and `totalSemantics`.

- `query`: require `capabilities.query`; enforce `tenant.policy` and
  `tenant.bindField`; use `query`, `read`, `pagination`, `filtering`,
  `enums`, `selectors`, `adapter`, and `handler` exactly as declared.
- `write`: require `capabilities.write`; enforce `tenant`; build only
  `save` data from `writableFields`, validate `enums`, apply
  `defaults` only for creation, use `adapter` or `handler` as registered,
  and retain `rollback` for explicit recovery.
- `compare`: require `capabilities.compare`; validate both `tenant`
  policies before reads; use `query`, `read`, `pagination`,
  `identityFields`, `compareFields`, `filtering`, `enums`, `selectors`,
  `adapter`, and `handler` to produce the change plan.
- `sync`: require `capabilities.sync`; reuse the contract-driven compare
  plan, then use `tenant`, `identityFields`, `compareFields`,
  `writableFields`, `defaults`, `filtering`, `enums`, `selectors`,
  `adapter`, `handler`, and `rollback` to apply only safe changes.

For every action, honor `defaults.create`, `preserveTargetFields`, and
`preserveTargetFieldsWhenMissing` only where declared. Use
`filtering.time` and `filtering.defaultTimeField` to decide whether and how
`--created-in`, `--from`, `--to`, or `--time-field` may be used. Pass only
declared `selectors` with their `name`, `valuePlaceholder`, `description`, and
`required` values, and retain each `enums` `value` and `meaning`. Use only a
registered `rollback` contract and its `service`, `resource`, `remove`, and
`lookup` declarations, including `path`, `method`, `idField`, and
`idPlacement`; never construct a delete or raw request.

If a required contract fact, dependency mapping, request field, response shape,
or tenant rule is absent or contradictory, stop and request a project-backed
contract reference. Do not guess an endpoint, field, ID, page-count meaning, or
fallback command.

## Run the common state machine

Follow these phases for every resource query, mutation, or migration:

1. Parse the request exactly. Resolve missing or ambiguous environments,
   resources, selectors, identities, and dependencies with read-only CLI queries.
   Ask the user only after a lookup returns zero or multiple candidates.
2. Resolve one exact resource and validate the requested capability, tenant
   policy, selectors, filters, enums, identity, writable data, and defaults from
   its contract. For a migration, preserve source/target direction.
3. For `write` or `sync`, build a preview with the same command and no
   `--apply`. Show `create`, `update`, `unchanged`, and `blocked` changes,
   changed fields, mapped dependencies, and every missing or ambiguous
   dependency.
4. Request or confirm explicit authorization for the shown write set. Then run
   that same command with `--apply`; do not switch to a separate apply command,
   raw endpoint, or modified environment/Token.
5. Apply only safe changes. Skip `blocked` records while continuing the full
   plan; never treat skipped records as success. Require the CLI's post-write
   verification to report `verified: true`.
6. Report the operation ID when the CLI returns one. To test idempotency, query
   or preview again and expect already equal records to be `unchanged` with no
   duplicate write. Request rollback separately and follow [rollback.md](references/rollback.md).

`write` and `sync` are preview-only by default and never imply deletion. A
transport, CLI, or EADP failure stops the current workflow immediately. Do not
retry, alter parameters, switch endpoints/environments/Tokens, or infer a
batch-wide result from one item. Continue only after the user reviews the
failure and requests a new action.

## Protect identity and secrets

- Use `eadp env list` and only configured environment names. Never infer a URL,
  Token, tenant, or direction from history or examples.
- Resolve a person by employee number when possible. Accept an exact name only
  when it yields one candidate; stop on duplicates.
- Never send a source environment ID to a target environment. Resolve target
  dependencies through the contract's adapter/handler or a target read.
- Never print a Token. Redact it if a command exposes one unexpectedly.
- Keep output structured. State environments, exact selectors and time range,
  action counts, preview/applied status, verification, skipped blocked records,
  and unresolved dependencies.

## Load references only when needed

After live resource discovery, read only the direct reference required by the
selected workflow; do not load every reference by default:

- Querying or auditing: [query-audit.md](references/query-audit.md)
- Generic compare/sync or menu hierarchy: [resource-sync.md](references/resource-sync.md)
- Any create/update/assign/sync write: [write-contracts.md](references/write-contracts.md)
- Permission inspection, add-only copying, grant, or revoke: [permission-management.md](references/permission-management.md)
- BPM discovery or configuration: [bpm-configuration.md](references/bpm-configuration.md)
- Serial-number migration: [serial-number-sync.md](references/serial-number-sync.md)
- Explicit rollback: [rollback.md](references/rollback.md)

References add domain constraints only. They do not register resources, decide
whether an action is supported, or replace the live `list`/`describe`/action-help
evidence.
