# EAI channel configuration and lifecycle

Use `trans` for an EAI channel and `trans-group` for its group. Both require a
non-global environment. Channel configuration operations stay in the generic
resource engine; only explicit publication and freezing use `eadp trans`.

## Query and write

Resolve a channel by its business `code`. Use the ID returned by the current
environment's list query when requesting the full graph detail; never reuse an
ID from another environment or a previous conversation.

```text
eadp resource query trans --env dev --filter code:EQ:ORDER_SYNC
eadp resource detail trans --env dev --select id=<current-environment-trans-id>
eadp resource write trans --env dev --data '{"code":"ORDER_SYNC","name":"订单同步","transGraph":{"graph":"{\"nodes\":[],\"edges\":[]}"}}'
```

`write` requires `code` and `transGraph.graph`; `logLastDay` must not exceed
180. Saving an existing channel preserves its target `status` and
`graphVersion`. Preview before `--apply` and require post-write verification.
Do not submit source IDs, `status`, graph IDs, or graph versions as writable
configuration.

## Compare and synchronize one channel

A channel compare/sync requires exactly one `--select code=<code>`. Time filters
are unsupported; do not substitute `createdDate` or another field. The CLI loads
the complete graph, compares its JSON structure, maps group and source-system
IDs by business `code`, and verifies the saved target.

```text
eadp resource compare trans --source A --target B --select code=ORDER_SYNC
eadp resource sync trans --source A --target B --select code=ORDER_SYNC
eadp resource sync trans --source A --target B --select code=ORDER_SYNC --apply
```

Interpret actions normally: `create` means the code is absent in the target,
`update` means at least one logical field differs, and `unchanged` means no
write is needed. A second run must not create another graph version for an
unchanged channel. `blocked` records are not applied; inspect their
`missingDependencies` or `blockingIssues` and do not report them as migrated.

Never copy `groupId` or `sourceSystemId` across environments. Missing or
ambiguous target dependencies block the channel. Unresolved source-system IDs,
inline passwords, authentication headers, and database `dbMeta` also block the
channel. The CLI redacts known graph secrets from detail and change-set output;
never attempt to recover, print, or copy those secrets. Target-only channels are
not deleted because `trans` has no deletion contract.

Configuration synchronization does not publish, freeze, or change the target
lifecycle state.

## Publish or freeze explicitly

Publication and freezing are separate lifecycle actions. Preview first, then
apply only after explicit authorization. Publication calls the existing
save-and-publish semantics and verifies `PUBLISH` plus a changed graph version;
freezing verifies `FROZEN` and repeated freezing returns `unchanged`.

```text
eadp trans publish --env B --select code=ORDER_SYNC
eadp trans publish --env B --select code=ORDER_SYNC --apply
eadp trans freeze --env B --select code=ORDER_SYNC
eadp trans freeze --env B --select code=ORDER_SYNC --apply
```

Any CLI or EADP failure stops the workflow immediately. Do not retry, switch to
`importTrans`, call a raw endpoint, or turn a configuration sync into a publish.
