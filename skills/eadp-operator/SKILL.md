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

- `resource query|write|compare|sync <name>`: every registered resource runs on
  the generic engine; the CLI validates capability, tenant, selectors, enums,
  filters, and dependencies, and verifies writes before reporting success.
- Domain commands: `permission ...`, `menu create`, `bpm inspect`,
  `bpm configure`, `rollback <operation-id...>` handle intents that are not
  ordinary record operations. Never bypass a registered contract or a domain
  command with a raw request.
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
eadp resource compare feature --source dev --target test
eadp resource sync menu --source dev --target test --select code=PURCHASE
```

- `query` supports `--count` (total records only), `--summary` (count plus
  summaryInfo), `--fields <a,b>`, `--limit <n>`, `--filter <field:op:value>`,
  `--quick <text>`, and `--created-in`/`--from`/`--to`/`--time-field` when the
  contract declares time filtering. Read the count from `--count` output; do
  not dump every record for a "how many" question.
- `write` needs `--env <env>` and `--data <json>`; it previews by default and
  writes only with `--apply`.
- `compare`/`sync` need `--source <env>` and `--target <env>`. Resource
  selectors use one unified syntax: `--select <name>=<value>` (for example
  `--select code=PURCHASE`, `--select flow=采购申请`); the CLI validates the
  name against the current contract.
- `--apply` is the only switch that writes. Preview first for every mutation.

## Inspect when parameters are missing or ambiguous

Only when the request is incomplete (unknown resource name, missing
environment, unknown selector, or a needed option) run discovery, using
`eadp resource inspect`:

- `eadp resource inspect` — list registered resources, CLI version, available
  environments, and each environment's recorded `tenantCode`.
- `eadp resource inspect <name>` — contract digest: capabilities, tenant
  policy, identity/compare/writable fields, enums, selectors, filtering.
- `eadp resource inspect <name> <action>` — structured options for that exact
  action: environments, tenant policy, required/optional options, this
  resource's selectors, and action-relevant fields including safe
  deletion/rollback declarations where applicable.

Resolve missing or ambiguous parameters with read-only CLI queries. Ask the
user only after a lookup returns zero or multiple candidates; never guess a
resource name, environment, selector, or option.

## Current registered resources

Current resource names (the live `eadp resource inspect` output is
authoritative): `app-module`、`feature`、`feature-group`、`serial-number`、
`employee`（别名 `user`）、`menu`、`bpm`. Future ordinary resources remain
usable through live discovery without any Skill change.

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
  `eadp bpm configure ...`; BPM environment migration stays
  `eadp resource compare|sync bpm --select flow=<code-or-name>`.
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

## Load references only when needed

After the command surface is clear, read at most one reference required by the
selected workflow; do not load every reference by default:

- Querying or auditing: [query-audit.md](references/query-audit.md)
- Generic compare/sync or menu hierarchy: [resource-sync.md](references/resource-sync.md)
- Any create/update/delete/assign/sync write: [write-contracts.md](references/write-contracts.md)
- Permission inspection, add-only copying, grant, or revoke: [permission-management.md](references/permission-management.md)
- BPM discovery or configuration: [bpm-configuration.md](references/bpm-configuration.md)
- Serial-number migration: [serial-number-sync.md](references/serial-number-sync.md)
- Explicit rollback: [rollback.md](references/rollback.md)

References add domain constraints only. They do not register resources, decide
whether an action is supported, or replace live `eadp resource inspect`
evidence.
