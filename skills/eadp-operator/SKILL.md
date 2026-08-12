---
name: eadp-operator
description: Safely operate EADP through the eadp CLI. Use when a user asks to query EADP resources or permissions, query/create/synchronize menus, inspect or configure BPM, migrate BPM or serial-number configuration between environments, inspect resources created or changed during a time range, compare or synchronize configuration between named environments, grant or revoke roles, or modify a feature/configuration item. Includes read-only resolution, preview, ambiguity protection, dependency mapping, post-write verification, and structured JSON output.
---

# EADP Operator

Use the installed `eadp` CLI as the only execution layer. Never store, repeat, infer, or place environment URLs and Tokens in this Skill.

## Start every task

1. Run `eadp --help`.
2. Run `eadp env list` and use only environment names configured there.
3. Run the relevant subcommand help before constructing a command.
4. Commands output JSON by default. `eadp query` streams NDJSON (`meta`, one `item` per record,
   then `summary`); consume it line by line. For other commands, use root-level `--compact` when a
   single-line result is needed: `eadp --compact <verb> ...`.
5. Treat names, IDs, dates, and environment direction as untrusted until resolved.

`env list` also reports each environment's `tenantCode`. If it is missing, stop and ask the user to
re-run `eadp env add` for that environment; do not infer it or edit the config directly.

Do not use raw `eadp call <METHOD> <PATH>` when a dedicated `query`, `sync`, `inspect`,
`apply`, `assign`, `revoke`, or `verify` command covers the operation.

## Resolve parameters before asking the user or acting

Treat every command parameter as unresolved when it is missing, vague, invalid, or not unique.
This includes environment, URL or Token, resource or feature code/name/path, application module,
feature group, employee, role, source/target environment, date range, and dependency identifiers.

1. Read the relevant CLI help and identify the dedicated read-only command that can resolve the parameter.
2. Use only values supplied by the user, local configuration, and returned CLI records as query inputs.
   Never infer a URL, Token, ID, code, environment, or source/target direction from history or examples.
3. Query before asking for clarification whenever the current values can discover candidates. Use:
   - `eadp env list` for configured environments;
   - `eadp query ...` for resources and feature/configuration items;
   - `eadp sync ...` without `--apply` for read-only target/dependency comparison;
   - `eadp inspect permission functional ...` and `eadp verify ...`
     for roles, menus, features, employees, and effective permissions.
4. If exactly one candidate is returned, show the resolved value and use it in the planned command.
5. If multiple candidates are returned, show stable distinguishing fields such as environment name,
   code, name, path, application module, or employee number, then ask the user to choose. Do not write.
6. If no candidate is returned, or no safe read-only command can resolve the value, state what was
   searched and request the exact missing parameter. When no environment is configured, request the
   environment name, its URL, and either its Token or Token environment-variable name; bind the Token
   only to that URL. Do not request only an environment name and then guess the connection details.
7. If a discovery command fails, stop and report the failure. Do not retry, switch endpoints/environments,
   or ask the user for a replacement parameter as a workaround.

When asking the user for clarification, identify the unresolved field, summarize the read-only lookup,
list any candidates or explain that none were found, and give the exact value/format needed next.

For example, for “修改 dev 环境的某功能项” when `eadp env list` has no configured environment,
stop before querying or writing and request `dev`'s environment URL plus either its Token or Token
environment-variable name. If the environment is configured but the feature name matches several
records, query the registered feature resource, present the matching codes/names/modules, and ask the
user to select one.

## Select one workflow

- For resource/time queries or permission inspection, read [references/query-audit.md](references/query-audit.md).
- For A-to-B comparisons or synchronization, read [references/resource-sync.md](references/resource-sync.md).
- For granting or revoking user, position, or position-category roles, read [references/permission-management.md](references/permission-management.md).
- For BPM discovery or configuration, read [references/bpm-configuration.md](references/bpm-configuration.md).
- For serial-number configuration synchronization, read [references/serial-number-sync.md](references/serial-number-sync.md).
- For rolling back a prior CLI create or assignment, read [references/rollback.md](references/rollback.md).

### Creating a feature

Use `eadp apply feature` for a new `sei-basic` feature item. Run `eadp apply feature --help`
before constructing the command. The required selectors are `--code`, `--name`, `--app`
(application module code, name, or ID), and `--feature-type` (`Operate`, `Business`, or `Page`).
Optionally provide `--group` (feature-group code, name, or ID), `--group-code`, `--url`,
`--can-menu`, `--tenant-can-use`, and `--mobile-use`.

This workflow is limited to an environment whose recorded `tenantCode` is `global`. The command
first checks `feature/findByCode`; an existing `code` is reported as `action: "unchanged"` with
`applied: false` and does not resolve dependencies or call `feature/save`. For a missing code,
resolve the application module and feature group through read-only queries and require exactly one
match; when the group exposes `appModuleId` or `appModuleCode`, verify that it belongs to the
selected module. The default command is preview-only. Add `--apply` only after the preview is
reviewed. The command creates only: it never updates an existing item. A successful create is
verified with `feature/findByCode`, returns an `operationId`, and can later be removed only by an
explicit `eadp rollback <operationId>`.

### Creating a feature group and its application module

Use `eadp apply feature-group --help` before constructing this command. Provide the feature-group
`--code`, `--name`, and an explicit application-module code through `--app-code` (the `--app` and
`--module-code` spellings are compatibility aliases). The command is global-only and defaults to a
preview. It first queries the feature-group by code; an existing match returns `action: "unchanged"`
without querying or creating an application module. For a missing group, the module code is matched
uniquely. A missing module is planned as `action: "create"`; its name is inferred from the supplied
`--project`/`--project-path` (default current project) Gradle/package metadata or business code
comments and is capped at eight characters. `rank` defaults to `1`. The preview reports both the
module action/name/rank and the feature-group action, and never writes.

After explicit authorization, add `--apply`. If the module is missing, the CLI creates it and checks
it by code before creating the feature group with the returned target module ID, then checks the group
by code. Existing modules are reused and never overwritten. Both creates share one operation log;
partial failure stops immediately and reports its `operationId` for an explicit rollback. Run
`eadp rollback <operationId>` only when requested; rollback removes the feature group first and the
module second. Never infer a remote module from `sei.application.code` or copy an ID from another
environment.

Load only the selected workflow unless the request combines workflows.

## Global safety rules

- Resolve relative dates into explicit year-month or timestamps. Ask when the year or timezone changes the result.
- Interpret “新增” as creation time. Do not silently substitute update time.
- Resolve every missing or ambiguous parameter through the read-only procedure above before requesting user input.
- For a person, prefer employee number. Permit exact employee name only when it resolves to one employee; never choose among duplicates.
- For cross-environment operations, preserve source/target direction exactly as requested.
- Treat only an environment whose recorded `tenantCode === "global"` as the global administrator.
  Use it for every remote operation on application modules (`appModule`/`app-module`), menus (`menu`), features (`feature`), feature groups
  (`feature-group`/`featureGroup`), and serial-number configurations
  (`serial-number`/`serialNumberConfig`), including query, apply, sync, generic `call`, and rollback;
  aliases must not bypass this check. Use a non-`global` environment for permission and position configuration/assignment, user queries,
  BPM configuration, and all other operations. The generic `call` command enforces
  the same path policy and must not be used to bypass it.
- When configuring or replacing a Token, the CLI first validates it with `account/getByApiKey?apiKey=<token>` and
  records the returned `tenantCode`. If validation fails, the new Token is not saved; stop and report
  the failure without retrying.
- Use only the `tenantCode` recorded by `env add`. Never accept, infer, or override it in a later
  query or write command.
- Preview every write first. Show the planned create, update, grant, or revoke set.
- Execute only after the user has authorized the write or explicitly requested completion.
- Never pass `--apply` during exploration or when identity/dependency resolution is ambiguous.
- If any CLI or EADP API call fails, stop the workflow immediately and report the failure truthfully. Include the environment name, redacted command, HTTP status or EADP message when available, and whether any earlier write may already have succeeded.
- Do not retry a failed call automatically. Do not retry with changed parameters, another endpoint, another environment or Token, a raw `eadp call`, or any other workaround. Continue only after the user explicitly reviews the failure and instructs a new action.
- After applying, require the CLI result to report successful verification. If it does not, stop and report the partial result.
- For BPM and serial-number synchronization, distinguish record-level `blocked` results from CLI or
  EADP request failures. Apply only safe planned records, report every `blockingIssues` entry, and
  never retry a failed request.
- Never copy source database IDs into another environment. Use CLI-registered dependency mappings.
- Never display Token values. Redact them if an external command exposes them unexpectedly.
- Successful creates and assignments return an `operationId` and keep a local operation log for 30 days.
  Run `eadp rollback <operation-id>` only when the user explicitly requests that rollback. It executes
  directly without `--apply`; never invent an operation ID or substitute raw delete/remove calls.

## Report results

State:

1. Source and target environment names, if applicable.
2. Exact selector and time range used.
3. Counts of queried, created, updated, unchanged, blocked, granted, or revoked records.
4. Whether the operation was preview-only or applied.
5. Verification status, `skippedBlocked`, and every missing or ambiguous dependency reported by the CLI.

For a failed call, report the failure instead of converting it into a partial success. State clearly that no retry was attempted.
