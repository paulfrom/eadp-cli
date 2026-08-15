# Resource comparison and synchronization

Use this reference for generic resource comparison/synchronization and for
menu hierarchy work. It supplements domain rules; it never decides whether a
resource is registered or whether an action is supported.

## Build a contract-driven change set

1. Run `eadp resource list`, `eadp resource describe <name>`, and
   `eadp resource compare <name> --help` or `eadp resource sync <name> --help`.
2. Select one exact name and require the requested capability. Read
   `tenant.policy` before any source or target query; validate both recorded
   tenants before reading migration data.
3. Validate declared selectors, `--filter` values, and time options against
   `selectors` and `filtering`. Treat `filtering.time: false` or an absent
   filtering fact as a stop condition for time-scoped work. Do not maintain a
   list of resources that do or do not support time.
4. Use `identityFields` to match source records to target records. Use
   `compareFields` and `writableFields` to build the desired target state.
   Apply `defaults.create` only for a missing target. Let an `adapter` or
   `handler` resolve dependencies; never copy source IDs.
5. Produce the complete change set before applying anything. The engine loads
   declared dependencies automatically; there is no dependency flag or manual
   dependency-selection step. Continue planning independent records when one
   record has a missing or ambiguous dependency.

The following commands are directly executable grammar examples only. The
resource name and its time capability must be rediscovered from the current
CLI before execution.

```text
eadp resource describe feature
eadp resource compare feature --source A --target B --created-in 2026-07
eadp resource sync feature --source A --target B --from "2026-07-01 00:00:00" --to "2026-08-01 00:00:00"
eadp resource sync feature --source A --target B --created-in 2026-07 --apply
```

Treat `--to` as exclusive. Apply time options to the source selection only;
do not add target filters unless the live action contract explicitly requires
them.

## Interpret and apply the plan

Use exactly these actions:

- `create`: the identity is absent in the target.
- `update`: the identity exists and at least one writable/compare field differs.
- `delete`: the record exists only in the target and the live resource declares
  a complete deletion contract (`deletion.remove`, `deletion.lookup`, and
  `deletion.restore`). This is destructive and is never inferred from an
  endpoint name.
- `unchanged`: the target already equals the desired state; do not write.
- `blocked`: the record cannot be safely mapped or validated; report its
  `missingDependencies` or `blockingIssues` and keep it out of the apply set.
  A target-only record on a resource without a deletion contract is blocked
  with an undeclared-delete issue.

Preview without `--apply`. Review `summary`, every `changedFields`, each
`desired` dependency mapping, all delete changes, and all blocked details.
After explicit authorization, rerun the same command with `--apply`. Require
`verified: true` and reconcile `skippedBlocked` with the blocked count. Treat a CLI/API failure
as a workflow failure, stop immediately, and do not retry.

A second preview or apply must report equal records as `unchanged`, absent
target-only records as no-ops, and must not create duplicates. Report
`operationId` for applied creates or deletes and keep it for an explicit
rollback request. A delete operation log stores the target snapshot and uses
the declared restore endpoint during rollback.

## Implicit dependency and deletion ordering

For a resource with declared dependencies, one compare/sync operation plans the
whole dependency closure without a user option. The engine applies creates and
updates in topological order (for example `app-module` → `feature-group` →
`feature`), rereads each target resource, and remaps target IDs before applying
the next resource. It applies deletes in reverse order (`feature` →
`feature-group` → `app-module`) so children are removed before parents.

Do not copy source IDs. If a dependency cannot be resolved, keep the affected
record `blocked` with `missingDependencies`; safe independent records continue.
Do not delete a target-only record unless `resource describe <name>` exposes a
complete `deletion` contract with remove, lookup, and restore semantics.

## Menu synchronization

Route explicit menu intent to dedicated `eadp menu` actions or, when
`eadp resource list` and `eadp resource describe <name>` confirm a registered
menu resource, its `query`/`compare`/`sync` actions. Before planning, run
`eadp menu --help` and the selected dedicated action help, or
`eadp resource <query|compare|sync> <name> --help` for the registered resource.
Require the selected contract's menu capability and a recorded global tenant
before reading the menu tree.

- Query the authoritative tree through the selected dedicated menu action or,
  for a registered menu resource, through `eadp resource query <name> --env
  <global-env>`. The current menu contract uses `getMenuTree`; flatten the
  returned tree and retain `parentCode` for each node.
- Match nodes by exact `code`. Use the declared `--code` selector to scope a
  subtree; omit it only when the user requests the complete tree.
- Apply parents before children. Resolve `parentId` from the target parent code
  and `featureId` from the target feature code. Never copy either source ID.
- Mark a node `blocked` when its target parent or feature is missing or
  ambiguous. Block descendants of a blocked parent while continuing independent
  safe nodes.
- Move an existing node with the dedicated menu move behavior when its parent
  changes, including a move to the root. Do not change an existing parent by
  sending a save payload.
- Preserve the three-level project hierarchy: one application root, business
  categories below it, and feature-bound nodes only at level three. Do not add a
  deeper level or attach a feature to a root/category node.

Resolve a project root and category read-only. Reuse one unique root/category;
stop on multiple candidates or on a missing identity that cannot be resolved.
Create parents before children, preview the complete set, then apply only after
authorization and verify every safe create/update.

If a menu request conflicts with these hierarchy rules, stop and ask for a
corrected unique parent or feature selector. Do not abbreviate or guess codes.
