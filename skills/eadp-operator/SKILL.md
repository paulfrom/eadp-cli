---
name: eadp-operator
description: Operate EADP through its contract-driven resource framework and explicit domain commands. Discover live contracts, route special workflows, preview writes, verify applied changes, and stop on failures.
---

# EADP Operator

Use the installed `eadp` CLI as the only execution layer. Keep environment URLs,
Tokens, remote IDs, endpoint guesses, and undeclared request fields out of this
Skill and out of user-facing reports.

## Architecture and routing

EADP CLI has one contract-driven resource framework plus explicit domain
commands:

1. A `ResourceContract` registers a resource's identity, service, query/save
   transport, read/pagination strategy, business identity, comparable and
   writable fields, tenant policy, capabilities, defaults, filtering, enums,
   selectors, adapter/handler extension, dependency declarations, rollback,
   and explicit deletion contract.
2. The generic resource engine executes every declared `query`, `write`,
   `compare`, or `sync` capability with the same validation, ChangeSet,
   preview/apply, blocked-item, operation-log, and verification lifecycle.
    Declared dependencies are an engine default: do not ask the user to select
    a dependency mode or add a `--with-dependencies` option. The engine plans
    and applies them automatically. Adapters normalize or remap dependencies.
    Handlers/hooks extend individual phases for tree or aggregate resources
    without creating another sync protocol.
3. Permission relations, menu creation, BPM project discovery/configuration,
   and explicit rollback use domain commands because they are not ordinary
   record operations. They must not bypass registered contracts or invent raw
   requests.

The contract `id` is the CLI resource name. Endpoint paths inside `query`,
`save`, and `rollback` are transport facts, not additional resource aliases.
Adding an ordinary resource requires registering a complete `ResourceContract`
only; do not add a command branch or Skill workflow for its name.

## Unified resource framework

Discover the active framework before planning:

1. Run `eadp --help`, `eadp env list`, and `eadp resource --help`.
2. For the selected resource and action, run exactly:

   ```text
   eadp resource list
   eadp resource describe <name>
   eadp resource <query|write|compare|sync> <name> --help
   ```

   Replace `<query|write|compare|sync>` with the requested action and `<name>`
   with the exact registered resource `id`. Run only the selected action's help
   before constructing its command.
3. Treat the current `list`, exact-name `describe`, and selected-action help as
   the execution authority. The packaged resource summary below is orientation,
   not an allowlist: if live output differs, follow the live contract. Never
   maintain command-level per-resource branches or a static time-support table.

The unified commands are:

- `resource query <name>`: read according to the contract and aggregate every
  required page.
- `resource write <name>`: create or update one target environment; preview by
  default and write only with `--apply`.
- `resource compare <name>`: compare source and target read-only and return one
  ChangeSet.
- `resource sync <name>`: reuse the compare plan; preview by default and apply
  only safe `create`, `update`, and contract-authorized `delete` changes with
  `--apply`. Dependency resources are implicit engine behavior.

## Drive actions from the selected contract

Read the exact `describe` result and derive behavior mechanically. Treat `id`,
`title`, `description`, `service`, and `help` as live identity/documentation
facts. Treat `query`, `save`, `read`, and `pagination` as live transport/read
facts. Do not infer an omitted endpoint or response shape. EADP paged endpoints
accept `pageInfo.page` (1-based) and `pageInfo.rows: 500`; their inner `data`
has `page` (current page), `records` (total records), `total` (total pages),
`summaryInfo`, and `rows` (current page). Never treat `total` as a record count
or `records` as a page length. For a declared pagination contract, honor
`pageField`, `pageNumberField`, `pageSizeField`, `startPage`, `rowsField`,
`pageSize: 500`, and `totalSemantics: "pages"`.

- `query`: require `capabilities.query`; enforce `tenant.policy` and
  `tenant.bindField`; use `query`, `read`, `pagination`, `filtering`, `enums`,
  `selectors`, `adapter`, and `handler` exactly as declared.
- `write`: require `capabilities.write`; enforce `tenant`; build only `save`
  data from `writableFields`, validate `enums`, apply `defaults` only for
  creation, use `adapter` or `handler` as registered, and retain `rollback` for
  explicit recovery.
- `compare`: require `capabilities.compare`; validate both `tenant` policies
  before reads; use `query`, `read`, `pagination`, `identityFields`,
  `compareFields`, `filtering`, `enums`, `selectors`, `adapter`, and `handler`
  to produce the change plan. A target-only record is `delete` only when the
  contract declares `deletion.remove`, `deletion.lookup`, and
  `deletion.restore`; otherwise keep it `blocked`.
- `sync`: require `capabilities.sync`; reuse the contract-driven compare plan,
  then use `tenant`, `identityFields`, `compareFields`, `writableFields`,
  `defaults`, `filtering`, `enums`, `selectors`, `adapter`, `handler`, and
  `rollback` and `deletion` to apply only safe changes. Creates/updates run
  in dependency order; deletes run in reverse dependency order.

For every action, honor `defaults.create`, `preserveTargetFields`, and
`preserveTargetFieldsWhenMissing` only where declared. Use `filtering.time` and
`filtering.defaultTimeField` to decide whether and how `--created-in`, `--from`,
`--to`, or `--time-field` may be used. Pass only declared `selectors` with their
`name`, `valuePlaceholder`, `description`, and `required` values, and retain
each `enums` `value` and `meaning`. Use only registered `rollback` and
`deletion` contracts and their `service`, `resource`, `remove`, `lookup`, and
`restore` declarations, including `path`, `method`, `idField`, and
`idPlacement`; never construct an undeclared delete or raw request.

If a required contract fact, dependency mapping, request field, response shape,
or tenant rule is absent or contradictory, stop and request a project-backed
contract reference. Do not guess an endpoint, field, ID, page-count meaning, or
fallback command.

## Current registered resources

The packaged catalog currently contains these registrations. Always refresh
this view with `eadp resource list` before execution.

| Resource `id` | Registration kind | Declared capabilities | Routing note |
| --- | --- | --- | --- |
| `app-module` | Ordinary contract | query, write, compare, sync | Use the unified resource commands |
| `feature` | Ordinary contract with adapter | query, write, compare, sync | Generic actions use `resource`; high-level create-only intent may use `permission apply feature` |
| `feature-group` | Ordinary contract with adapter | query, write, compare, sync | Generic actions use `resource`; high-level create-only intent may use `permission apply feature-group` |
| `serial-number` | Ordinary contract with adapter | query, write, compare, sync | This is the only CLI resource name for serial-number configuration |
| `menu` | Behavior-extension resource | query, compare, sync | Generic actions use tree-aware hooks; one-menu creation uses `menu create` |
| `bpm` | Behavior-extension resource | compare, sync | Migration uses `resource`; project discovery/configuration uses `bpm` commands |

`serialNumberConfig` may appear in the `serial-number` transport or rollback
paths; it is not another resource `id` and must not be passed as `<name>`.
Future ordinary resources remain usable through live discovery even when they
are not listed in this packaged snapshot.

## Special domain commands

Route only the following domain intents away from ordinary resource actions:

- High-level create-only feature or feature-group intent: use
  `eadp permission apply feature ...` or
  `eadp permission apply feature-group ...`. Their generic query, write,
  compare, and sync actions remain in the resource framework.
- Permission inspection, role configuration, relationship assignment or
  revocation, and verification: use `eadp permission ...` and load
  [permission-management.md](references/permission-management.md) when needed.
- Creating one menu: use `eadp menu create ...`. Menu query, compare, and
  migration remain `eadp resource query|compare|sync menu`.
- Discovering BPM from project code or configuring one project's BPM base data:
  use `eadp bpm inspect ...` or `eadp bpm configure ...`. BPM environment
  comparison/migration remains `eadp resource compare|sync bpm`.
- Explicit recovery by operation ID: use `eadp rollback <operation-id...>` and
  load [rollback.md](references/rollback.md).

Serial-number query, write, compare, and migration have no separate domain
command; use the unified resource commands with resource `serial-number`.
`env`, `skill`, and `update` are tool-management commands rather than registered
resources. Do not translate a domain term into an unrelated resource or invent
`api`, `call`, or `catalog` commands.

## Run the common state machine

Follow these phases for every resource query, mutation, or migration:

1. Parse the request exactly. Resolve missing or ambiguous environments,
   resources, selectors, identities, and dependencies with read-only CLI queries.
   Ask the user only after a lookup returns zero or multiple candidates.
2. Resolve one exact resource and validate the requested capability, tenant
   policy, selectors, filters, enums, identity, writable data, and defaults from
   its contract. For a migration, preserve source/target direction.
3. For `write` or `sync`, build a preview with the same command and no
   `--apply`. Show `create`, `update`, `delete`, `unchanged`, and `blocked`
   changes, changed fields, and every missing or ambiguous dependency. The
   dependency chain is automatic; do not expose a dependency-selection step.
   Target-only deletes must identify the declared deletion contract.
4. Request or confirm explicit authorization for the shown write/delete set. Then run
   that same command with `--apply`; do not switch to a separate apply command,
   raw endpoint, or modified environment/Token.
5. Apply only safe changes. Skip `blocked` records while continuing the full
   plan; never treat skipped records as success. Apply dependency creates and
   updates parent-first, and target-only deletes child-first. Require the
   CLI's post-write verification to report `verified: true`.
6. Report the operation ID when the CLI returns one. To test idempotency, query
   or preview again and expect already equal records to be `unchanged` with no
   duplicate write. Request rollback separately and follow
   [rollback.md](references/rollback.md).

`write` is preview-only by default and never deletes target records. `sync` is
preview-only by default; it may delete target-only records only when the live
resource contract declares the complete deletion semantics. A
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
- Any create/update/delete/assign/sync write: [write-contracts.md](references/write-contracts.md)
- Permission inspection, add-only copying, grant, or revoke: [permission-management.md](references/permission-management.md)
- BPM discovery or configuration: [bpm-configuration.md](references/bpm-configuration.md)
- Serial-number migration: [serial-number-sync.md](references/serial-number-sync.md)
- Explicit rollback: [rollback.md](references/rollback.md)

References add domain constraints only. They do not register resources, decide
whether an action is supported, or replace the live `list`/`describe`/action-help
evidence.
