---
name: eadp-operator
description: Operate EADP through the eadp CLI resource framework and domain commands. Execute directly when the request is complete, inspect only when parameters are missing, preview writes, and stop on failures.
---

# EADP Operator

Use the installed `eadp` CLI as the only execution layer. Keep environment URLs,
credential values, remote IDs, endpoint guesses, and undeclared request fields
out of this Skill and out of user-facing reports. The CLI engine owns contract
details (endpoints, pagination, defaults, dependencies, deletion, rollback);
this Skill only routes intents and sequences commands.

## Architecture and routing

EADP CLI has one contract-driven resource framework plus explicit domain
commands:

- `resource query|detail|write|compare|sync <name>`: every registered resource runs on
  the generic engine; the CLI validates capability, tenant, selectors, enums,
  filters, and dependencies, and verifies writes before reporting success.
- Domain commands: `permission ...`, `menu create`, `bpm inspect`,
  `bpm configure`, `bpm graph guide|nodes|conditions|expression|resolve-executor|layout|export|diff|validate|import`, `trans inspect`,
  `trans publish`, `trans freeze`, `rollback <operation-id...>` handle intents that are not
  ordinary record operations. Never bypass a registered contract or a domain
  command with a raw request.
- Avoid broad data pulls unless they are necessary for the requested action.
  Prefer exact selectors, filters, counts, and paged reads. Business `code`
  matching is case-sensitive. Use `findAll` only when no `findByPage` exists;
  never use it as a fallback after a paged request fails.
- For every query, compare, or sync, use a global environment only when the
  live resource contract or domain command explicitly requires `global`.
  `tenant.policy: "any"` defaults to non-global for reads; do not execute it
  with a global user. The CLI rejects this before any remote request.

The contract `id` is the CLI resource name. Adding a resource requires
registering its contract only; it needs no Skill change.

## Execute directly when the request is complete

When the request already names the resource, environment(s), selectors, and
filters, run the action immediately with one command — do not discover first:

```text
eadp resource query feature --env dev --count
eadp resource query feature --env dev --fields code,name --limit 20
eadp resource detail feature --env global-dev --select code=EXAMPLE_FEATURE
eadp resource compare feature --source dev --target test
eadp resource sync menu --source dev --target test --select code=EXAMPLE_FEATURE
```

- `query` supports `--count` (total records only), `--summary` (count plus
  summaryInfo), `--fields <a,b>`, `--limit <n>`, `--filter <field:op:value>`,
  `--quick <text>`, and `--created-in`/`--from`/`--to`/`--time-field` when the
  contract declares time filtering. Read the count from `--count` output; do
  not dump every record for a "how many" question.
- `detail` reads exactly one record through the contract's `detail` endpoint.
  It requires `--env` (or the current environment) and every declared
  `detail.selectors` entry as `--select <name>=<value>`. It does not accept list
  filters, time ranges, pagination, or guessed endpoint/ID syntax. A detail
  request is complete only when the resource, environment, and all selector
  values are known.
- `write` needs `--env <env>` and `--data <json>`; it previews by default and
  writes only with `--apply`.
- `compare`/`sync` need `--source <env>` and `--target <env>`. Resource
  selectors use one unified syntax: `--select <name>=<value>` (for example
  `--select code=EXAMPLE_FEATURE`, `--select flow=示例流程`); the CLI validates the
  name against the current contract.
- `--apply` is the only switch that writes. Preview first for every mutation.

## Inspect when parameters are missing or ambiguous

Only when the request is incomplete (unknown resource name, missing
environment, unknown selector, or a needed option) run discovery, using
`eadp resource inspect`:

- `eadp resource inspect` — list registered resources, CLI version, available
  environments, and each environment's recorded `tenantCode`.
- `eadp resource inspect <name>` — contract digest: capabilities, tenant
  policy, identity/compare/writable fields, enums, selectors, filtering, and
  the available detail selectors.
- `eadp resource inspect <name> <action>` — structured options for that exact
  action (`query`, `detail`, `write`, `compare`, or `sync`): environments,
  tenant policy, required/optional options, this resource's selectors, and
  action-relevant fields including safe deletion/rollback declarations where
  applicable. For a detail request, use `eadp resource inspect <name> detail`
  to obtain the required `detail.selectors` names and meanings.

Resolve missing or ambiguous parameters with read-only CLI queries. Ask the
user only after a lookup returns zero or multiple candidates; never guess a
resource name, environment, selector value, endpoint, or option. Do not fall
back from an unavailable detail capability to a list query or a guessed
`findOne` request.

## Current registered resources

Current resource names (the live `eadp resource inspect` output is
authoritative): `app-module`、`feature`、`feature-group`、`serial-number`、
`employee`（别名 `user`）、`menu`、`bpm`、`bpm-flow-graph`、`bpm-migration`、
`trans-group`、`trans`. Future
ordinary resources remain usable through live discovery without any Skill change.

The built-in detail selectors currently exposed by live contracts are:
`app-module.code`, `feature.code`, `employee.code`, `feature-group.id`,
`serial-number.id`, `menu.id`, `trans-group.id`, and `trans.id`. `bpm` is an
aggregate workflow resource and does not declare `detail`; do not emulate it
with a list query.

## Special domain commands

Route only these domain intents away from ordinary resource actions:

- Create-only feature or feature-group intent: `eadp permission apply feature`
  or `eadp permission apply feature-group`; their generic actions stay in the
  resource framework.
- Permission inspection, role configuration, grant/revoke, verification:
  `eadp permission ...` (load permission-management.md when needed).
- Creating one menu: `eadp menu create ...`. Menu query/compare/migration stay
  `eadp resource query|compare|sync menu`.
- BPM project discovery or configuration: `eadp bpm inspect ...` or
  `eadp bpm configure ...`; BPM environment migration uses
  `eadp resource compare|sync bpm-migration --select flow=<code-or-name>` for the
  skeleton plus graph in one plan, or the atomic `bpm` / `bpm-flow-graph` entries.
  For graph design from independent business input, run `eadp bpm graph guide` and
  `eadp bpm graph nodes`; input format is irrelevant. Check each node's usage scenarios
  and counterexamples, and ask whenever node kind, executor, condition, route, rejection,
  page, interface, or subprocess is uncertain. Before writing any gateway condition, load
  the system decision fields with `eadp bpm graph conditions --env <env> --flow <code>`;
  conditions may only use the variables that list returns. Maintain only the Chinese `logicUel`
  and run `eadp bpm graph expression --env <env> --flow <code> --logic <expression>` to generate
  the matching `#{...}` `groovyUel` through the designer-compatible server validation; never hand-write
  divergent pairs or use `${...}`. Build only canonical graph files, then use
  `eadp bpm graph validate|import`; strict validation requires `designValid=true` and
  `conditions.expressionValidation.failed=0`. Use `expression --file` for a condition matrix,
  `resolve-executor --query` for unique Person/Position/PositionType binding, `layout --write --check`
  for local geometry, `export --trim` for business-only output, and `diff` for read-only file/remote
  comparison. For independent input, never expand business types × approval stages into a flat graph.
  Confirm the ordered stage skeleton, estimated node count, and rejection/re-entry policy before
  generating the full graph; unknown business types must not pass directly to a terminal state. Before
  `--apply`, require complete Chinese condition labels, zero business-matrix differences, reported
  coordinate checks, and a preview rendered from the final coordinates. When creating a new flow while
  preserving an old version, use a completely new definition name and accept only `action=create` in
  the preview. Import keeps write/verify states separate: a verify failure (exit 2) after a successful
  write requires the prescribed read-back comparison, never another write. Never copy environment IDs
  or raw `defJson`.
- EAI node discovery: `eadp trans inspect [node]`; channel publication or
  freezing: `eadp trans publish|freeze`. Channel query, configuration writes,
  comparison, and migration stay in `resource`.
- Explicit recovery: `eadp rollback <operation-id...>`.

`env`, `skill`, and `update` are tool-management commands, not resources. Do
not translate a domain term into an unrelated resource or invent `api`, `call`,
or `catalog` commands.

## Write protocol (preview, authorize, apply, verify)

Every mutation follows the same sequence:

1. Build the command from the action schema; enforce tenant, selectors, enums,
   identity, and writable fields from the contract.
2. Run it **without `--apply`** and show the preview: `create`, `update`,
   `delete`, `unchanged`, `blocked`, changed fields, and missing or ambiguous
   dependencies. Target-only deletes must identify the declared deletion
   contract.
3. Confirm explicit authorization for the shown write/delete set, then run that
   same command with `--apply`. Do not switch to a separate apply command, raw
   endpoint, or modified environment/credential.
4. Apply only safe changes; skip `blocked` records while continuing the full
   plan and never treat skipped records as success. The CLI reports
   `verified: true` after post-write verification.
5. Report the operation ID when the CLI returns one. For idempotency, query or
   preview again and expect already equal records to be `unchanged`.

## Stop on failure

A transport, CLI, or EADP failure stops the current workflow immediately. Do
not retry, alter parameters, switch endpoints/environments/credentials, or
infer a batch-wide result from one item. Do not debug on your own: never read
or modify the eadp configuration file, never run `eadp update`/`npm`/network
commands, never search the filesystem for config or CLI installation, and never
fall back to a legacy or invented command. Report the exact CLI error and wait
for the user to review it and request a new action.

The sole diagnostic exception is an import that explicitly returns `write.status=success` and
`verify.status=failed`: the draft write succeeded, so never repeat `--apply` or claim it was not
written. Export the same target draft once, compare that export with the local file offline, then
report the confirmed state and the original CLI error as specified in bpm-flow-graph.md. A transport
failure or server `success=false`, including during this export, still stops immediately with no
retry or endpoint change.

## Load references only when needed

After the command surface is clear, read at most one reference required by the
selected workflow; do not load every reference by default:

- Querying or auditing: [query-audit.md](references/query-audit.md)
- Generic compare/sync or menu hierarchy: [resource-sync.md](references/resource-sync.md)
- Any create/update/delete/assign/sync write: [write-contracts.md](references/write-contracts.md)
- Permission inspection, add-only copying, grant, or revoke: [permission-management.md](references/permission-management.md)
- BPM skeleton discovery/configuration: [bpm-configuration.md](references/bpm-configuration.md)
- BPM graph design, import, or migration: [bpm-flow-graph.md](references/bpm-flow-graph.md)
- Serial-number migration: [serial-number-sync.md](references/serial-number-sync.md)
- EAI channel configuration, migration, publication, or freezing: [trans-sync.md](references/trans-sync.md)
- Explicit rollback: [rollback.md](references/rollback.md)

References add domain constraints only. They do not register resources, decide
whether an action is supported, or replace live `eadp resource inspect`
evidence.
