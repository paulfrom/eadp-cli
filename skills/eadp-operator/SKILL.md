---
name: eadp-operator
description: Safely operate EADP through the eadp CLI. Use when a user asks to query EADP resources or permissions, inspect resources created or changed during a time range, compare or synchronize configuration between named environments, grant roles to a user/position, revoke roles, or modify a feature/configuration item. Includes read-only resolution of missing or ambiguous parameters, preview, ambiguity protection, dependency mapping, post-write verification, and structured JSON output.
---

# EADP Operator

Use the installed `eadp` CLI as the only execution layer. Never store, repeat, infer, or place environment URLs and Tokens in this Skill.

## Start every task

1. Run `eadp --help`.
2. Run `eadp env list` and use only environment names configured there.
3. Run the relevant subcommand help before constructing a command.
4. Add `--json` to commands whose output will be interpreted.
5. Treat names, IDs, dates, and environment direction as untrusted until resolved.

`env list` also reports each environment's `tenantCode`. If it is missing, stop and ask the user to
re-run `eadp env add` for that environment; do not infer it or edit the config directly.

Do not use raw `eadp request` when a dedicated `resource` or `permission` command covers the operation.

## Resolve parameters before asking the user or acting

Treat every command parameter as unresolved when it is missing, vague, invalid, or not unique.
This includes environment, URL or Token, resource or feature code/name/path, application module,
feature group, employee, role, source/target environment, date range, and dependency identifiers.

1. Read the relevant CLI help and identify the dedicated read-only command that can resolve the parameter.
2. Use only values supplied by the user, local configuration, and returned CLI records as query inputs.
   Never infer a URL, Token, ID, code, environment, or source/target direction from history or examples.
3. Query before asking for clarification whenever the current values can discover candidates. Use:
   - `eadp env list` for configured environments;
   - `eadp resource query ... --json` for registered resources and feature/configuration items;
   - `eadp resource diff ... --json` for read-only target/dependency comparison;
   - `eadp permission functional inspect ... --json` and `eadp permission verify ... --json`
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

Load only the selected workflow unless the request combines workflows.

## Global safety rules

- Resolve relative dates into explicit year-month or timestamps. Ask when the year or timezone changes the result.
- Interpret “新增” as creation time. Do not silently substitute update time.
- Resolve every missing or ambiguous parameter through the read-only procedure above before requesting user input.
- For a person, prefer employee number. Permit exact employee name only when it resolves to one employee; never choose among duplicates.
- For cross-environment operations, preserve source/target direction exactly as requested.
- Use a `global` environment only for feature, menu, and serial-number configuration queries or writes.
  Use a non-`global` environment for permission and position configuration/assignment, user queries,
  BPM configuration, and all other operations. The generic `request` and `api call` commands enforce
  the same path policy and must not be used to bypass it.
- When configuring or replacing a Token, the CLI first validates it with `account/getByApiKey?apiKey=<token>` and
  records the returned `tenantCode`. If validation fails, the new Token is not saved; stop and report
  the failure without retrying.
- Preview every write first. Show the planned create, update, grant, or revoke set.
- Execute only after the user has authorized the write or explicitly requested completion.
- Never pass `--apply` during exploration or when identity/dependency resolution is ambiguous.
- If any CLI or EADP API call fails, stop the workflow immediately and report the failure truthfully. Include the environment name, redacted command, HTTP status or EADP message when available, and whether any earlier write may already have succeeded.
- Do not retry a failed call automatically. Do not retry with changed parameters, another endpoint, another environment or Token, a raw `eadp request`, or any other workaround. Continue only after the user explicitly reviews the failure and instructs a new action.
- After applying, require the CLI result to report successful verification. If it does not, stop and report the partial result.
- Never copy source database IDs into another environment. Use CLI-registered dependency mappings.
- Never display Token values. Redact them if an external command exposes them unexpectedly.

## Report results

State:

1. Source and target environment names, if applicable.
2. Exact selector and time range used.
3. Counts of queried, created, updated, unchanged, granted, or revoked records.
4. Whether the operation was preview-only or applied.
5. Verification status and any skipped or ambiguous records.

For a failed call, report the failure instead of converting it into a partial success. State clearly that no retry was attempted.
