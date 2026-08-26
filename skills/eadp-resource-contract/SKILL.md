---
name: eadp-resource-contract
description: Generate and locally validate strict EADP .resource.yaml contracts from explicit Controller, API, DTO, entity, enum, and shared-framework evidence. Use for resource contract authoring; do not use it to operate EADP, mount contracts, configure environments, or send requests.
---

# EADP Resource Contract Generator

Generate one or more declarative `*.resource.yaml` files from code evidence. This Skill is separate from `eadp-operator`: it authors and validates contracts; it never executes resource operations.

## Workflow

1. Read [the external contract schema](references/resource-contract-schema.md) before generating a contract.
2. Inspect the user-specified Controller and every directly relevant API, DTO/entity, enum, and inherited framework contract needed to prove the endpoint and payload shape. Treat source code as evidence; do not infer a remote contract from names or conventions alone.
3. Record the evidence for each generated field. If the service name, query path/method, read strategy, or response/pagination shape cannot be proven, stop and request the missing source reference instead of producing a plausible file.
4. Derive only the capabilities supported by complete evidence. Missing business identity, tenant, save, lookup, remove, restore, or verification evidence narrows capabilities; it never authorizes a guess.
5. Write the result to the user-requested absolute path with the `.resource.yaml` suffix.
6. Run `eadp resource validate <absolute-file-or-directory>` once. This is strict local generation validation, not runtime registration. Directory validation scans every direct `*.resource.yaml` and reports all file failures in `issues`; any validation error makes this command fail even though runtime loading independently uses maximum-available registration. If validation fails, report the complete structured error and stop; do not copy any file into the runtime `contracts` directory or try another command.

When the source resembles `DbInfoController`, read [the DbInfo query-only example](references/db-info-example.md). It demonstrates how incomplete write evidence must produce a safe query-only contract and why `dbPass` is sensitive.

## Capability Rules

- `query`: requires an explicit query endpoint plus a proven `paged` or `findAll` response contract.
- `compare`: additionally requires a proven business unique key and meaningful comparison fields.
- `write`: additionally requires the save payload, writable fields, target lookup, and a complete rollback contract. A generic inherited save method alone is not proof of safe write semantics.
- `sync`: requires the complete `compare` and `write` evidence, including target remapping and rollback where applicable.
- If no tenant restriction is provable, do not guess from a field name. Ask for the policy or use a policy only when the user or authoritative project contract explicitly confirms it.
- Add fields such as passwords, tokens, secrets, and private keys to `sensitiveFields` only when their semantics are evidenced. Sensitive fields must never be copied into selectors, identities, comparison fields, writable fields, examples, logs, or explanatory output.

## Hard Boundaries

- Generate YAML only. Do not copy it into the CLI configuration directory's fixed `contracts` folder, change CLI/environment configuration, register the resource, or edit runtime catalogs.
- Do not invoke `eadp resource query`, `write`, `compare`, `sync`, or any domain command.
- Do not read environment URLs or tokens and do not send network requests.
- Do not emit `adapter`, `handler`, or `selectors`; external contracts cannot load executable extensions.
- Do not add compatibility fields, fallback endpoints, speculative defaults, or undocumented enum values.
- Validation success proves the file conforms to the local schema; it does not prove that an uncalled remote endpoint works.
