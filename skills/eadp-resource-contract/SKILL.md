---
name: eadp-resource-contract
description: Generate and locally validate strict EADP .resource.yaml contracts from explicit Controller, API, DTO, entity, enum, and shared-framework evidence. By default generate at the CLI's fixed contracts path; use another location only when the user explicitly requests it. Do not use this Skill to mount or operate EADP resources.
---

# EADP Resource Contract Generator

Generate one or more declarative `*.resource.yaml` files from code evidence. This Skill is separate from `eadp-operator`: it generates and validates contracts; it never mounts resources or executes resource operations.

## Workflow

1. Read [the external contract schema](references/resource-contract-schema.md) before generating a contract.
2. Inspect the user-specified Controller and only the directly referenced API, DTO/entity, enum, and inherited framework contracts needed to prove the endpoint and payload shape. Batch independent reads when possible. If a source read is empty or fails, stop and report that failure; do not replace evidence with broad repeated searches or inference.
3. Record the evidence for each generated field. If the service name, query path/method, read strategy, or response/pagination shape cannot be proven, stop and request the missing source reference instead of producing a plausible file.
4. Derive only the capabilities supported by complete evidence. Missing business identity, tenant, save, lookup, remove, restore, or verification evidence narrows capabilities; it never authorizes a guess.
5. Choose exactly one output target:
   - If the user explicitly names an output file or directory, use that absolute location.
   - Otherwise run `eadp resource contract-path <id>` once and generate directly at the returned `path`. Treat wording such as register, integrate, or mount only as selecting this default generation path; do not perform or claim a separate registration action.
6. Run `eadp resource validate <absolute-file-or-directory>` once for the generated file. This is strict local validation. Directory validation scans every direct `*.resource.yaml` and reports all file failures in `issues`; any validation error makes this command fail even though runtime loading independently uses maximum-available registration. If validation fails, report the complete structured error and stop.

When the source resembles `DbInfoController`, read [the DbInfo query-only example](references/db-info-example.md). It demonstrates how incomplete write evidence must produce a safe query-only contract and why `dbPass` is sensitive.

## Capability Rules

- `query`: requires an explicit query endpoint plus a proven `paged` or `findAll` response contract.
- `compare`: additionally requires a proven business unique key and meaningful comparison fields.
- `write`: additionally requires the save payload, writable fields, target lookup, and a complete rollback contract. A generic inherited save method alone is not proof of safe write semantics.
- `sync`: requires the complete `compare` and `write` evidence, including target remapping and rollback where applicable.
- If no tenant restriction is provable, do not guess from a field name. Ask for the policy or use a policy only when the user or authoritative project contract explicitly confirms it.
- Add fields such as passwords, tokens, secrets, and private keys to `sensitiveFields` only when their semantics are evidenced. Sensitive fields must never be copied into selectors, identities, comparison fields, writable fields, examples, logs, or explanatory output.

## Hard Boundaries

- Generate the YAML directly at the selected target. Do not create a temporary contract and copy it afterward, change CLI/environment configuration, or edit runtime catalogs.
- The only CLI commands this Skill may run are `eadp resource contract-path <id>` for default target discovery and one `eadp resource validate <path>` for local validation.
- Do not run a separate mount/register step or verify runtime registration. File discovery and maximum-available loading belong to the CLI runtime, not this Skill.
- Do not invoke `eadp resource query`, `write`, `compare`, `sync`, or any domain command.
- Do not read environment URLs or tokens and do not send network requests.
- Do not emit `adapter`, `handler`, or `selectors`; external contracts cannot load executable extensions.
- Do not add compatibility fields, fallback endpoints, speculative defaults, or undocumented enum values.
- Do not create memory logs, work reports, presentation copies, or other artifacts unless the user explicitly requests them.
- Validation success proves the file conforms to the local schema; it does not prove that an uncalled remote endpoint works.
