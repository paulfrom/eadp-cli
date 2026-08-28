---
name: eadp-resource-contract
description: Generate and locally validate strict EADP .resource.yaml contracts from explicit Controller, API, DTO, entity, enum, and shared-framework evidence. By default generate at the CLI's fixed contracts path; use another location only when the user explicitly requests it. Do not use this Skill to mount or operate EADP resources.
---

# EADP Resource Contract Generator

Generate one or more declarative `*.resource.yaml` files from code evidence. This Skill is separate from `eadp-operator`: it generates and validates contracts; it never mounts resources or executes resource operations.

## Workflow

1. Read [the external contract schema](references/resource-contract-schema.md) before generating a contract.
2. Use the user-provided Controller as the evidence anchor. Read that Controller, its directly referenced API, and only the directly relevant DTO/entity/enum files. Prefer paths relative to the supplied project path. Do not perform a repository-wide method-name search or follow unrelated implementations. If a source read is empty or fails, stop and report that failure; do not replace evidence with broader searches or inference.
3. Apply the fixed framework defaults below without opening or searching their source files. For a target Controller/API, inspect its own declared or overridden method first; when a matching method is found, use it and stop descending the inheritance chain. Only when the target has no matching method may an inherited default be selected.
4. Record the evidence for each generated field. Once a field or capability is proven, stop looking for more evidence for it. Once the required evidence is absent, stop that capability's investigation and omit it. If the service name, query path/method, read strategy, response/pagination shape, or detail endpoint contract cannot be proven, stop and request the missing source reference instead of producing a plausible file.
5. Derive only the capabilities supported by complete evidence. Missing business identity, tenant, save, lookup, remove, restore, or verification evidence narrows capabilities; it never authorizes a guess.
6. Choose exactly one output target:
   - If the user explicitly names an output file or directory, use that absolute location.
   - Otherwise run `eadp resource contract-path <id>` once and generate directly at the returned `path`. Treat wording such as register, integrate, or mount only as selecting this default generation path; do not perform or claim a separate registration action.
7. Run `eadp resource validate <absolute-file-or-directory>` once for the generated file. This is strict local validation. Directory validation scans every direct `*.resource.yaml` and reports all file failures in `issues`; any validation error makes this command fail even though runtime loading independently uses maximum-available registration. If validation fails, report the complete structured error and stop.

## Fixed EADP framework contract

The following shared framework contracts are built into this Skill. Do not read, search, or report source for `BaseEntityApi`, `FindAllApi`, `FindByPageApi`, `BaseEntityController`, `BaseEntityDto`, `BaseEntityService`, `Search`, `PageInfo`, or `PageResult` to re-prove them or to explain pagination. These types are not part of the shortest evidence chain.

- `FindByPageApi` supplies `POST findByPage` with a JSON `Search` body, `read: paged`, and this exact pagination contract: `pageField: pageInfo`, `pageNumberField: page`, `pageSizeField: rows`, `startPage: 1`, `rowsField: rows`, `pageSize: 500`, `totalSemantics: pages`.
- `FindAllApi` supplies `GET findAll` and `GET findAllUnfrozen`. When its inherited default is needed, choose `findAll`; never choose `findAllUnfrozen` without a target-level declaration or other direct evidence.
- `BaseEntityApi` supplies `POST save` with a JSON DTO body, `DELETE delete/{id}` with `id` in the path, and `GET findOne?id=` with `id` in the query. `BaseEntityDto` supplies the `id` field.

For query selection, use this order: target Controller/API declared or overridden method, then inherited `FindByPageApi.findByPage`, then inherited `FindAllApi.findAll`. A target-level `findAllUnfrozen` is honored as the target method; it is not a default. The inherited `save`, `delete`, and `findOne` defaults prove only route and parameter placement. They do not prove a business unique key, safe writable fields, target verification, rollback, or restore; retain the capability rules below and narrow capabilities when those facts lack direct evidence.

For a `detail` capability, prove a single-record endpoint separately from the collection `query` endpoint. Record every required selector, its remote field, and whether the value is placed in the path, query string, or JSON body. The endpoint response must be evidenced as the normal EADP envelope whose `data` is either one object or `null`; a list, page, or other aggregate response is not a detail contract. Inherited `BaseEntityApi.findOne` may establish only its fixed route and ID placement; it is not, by itself, evidence for the business selector, singleton response, null semantics, or a complete `detail` declaration.

When the source resembles `DbInfoController`, read [the DbInfo query-only example](references/db-info-example.md). It demonstrates how incomplete write evidence must produce a safe query-only contract and why `dbPass` is sensitive.

## Capability Rules

- `query`: requires an explicit query endpoint plus a proven `paged` or `findAll` response contract.
- `detail`: requires a separately evidenced endpoint that identifies exactly one record, a non-empty set of required selectors with proven request placement (`path`, `query`, or `body`), and a proven single-object-or-null response. Declare the `detail` endpoint and the `detail` capability together. Do not infer this capability only from an inherited `findOne` method.
- `compare`: additionally requires a proven business unique key and meaningful comparison fields.
- `write`: additionally requires the save payload, writable fields, target lookup, and a complete rollback contract. A generic inherited save method alone is not proof of safe write semantics.
- `sync`: requires the complete `compare` and `write` evidence, including target remapping and rollback where applicable.
- If no tenant restriction is provable, do not guess from a field name. Ask for the policy or use a policy only when the user or authoritative project contract explicitly confirms it.
- Add fields such as passwords, tokens, secrets, and private keys to `sensitiveFields` only when their semantics are evidenced. Sensitive fields must never be copied into selectors, identities, comparison fields, writable fields, examples, logs, or explanatory output.

## Hard Boundaries

- Generate the YAML directly at the selected target. Do not create a temporary contract and copy it afterward, change CLI/environment configuration, or edit runtime catalogs.
- The only CLI commands this Skill may run are `eadp resource contract-path <id>` for default target discovery and one `eadp resource validate <path>` for local validation.
- Do not run a separate mount/register step or verify runtime registration. File discovery and maximum-available loading belong to the CLI runtime, not this Skill.
- Apart from the two commands above, do not invoke any EADP CLI or domain command.
- Do not read environment URLs or tokens and do not send network requests.
- Do not emit top-level executable-extension fields `adapter`, `handler`, or `selectors`; external contracts cannot load executable code. Declarative `detail.selectors` are allowed only when their request fields and placements are evidenced.
- Do not add compatibility fields, fallback endpoints, speculative defaults, or undocumented enum values.
- Do not create memory logs, work reports, presentation copies, or other artifacts unless the user explicitly requests them.
- Do not inspect or report `BaseDaoImpl`, `IFrozen`, shell/MSYS behavior, or other unrelated implementation details, and do not append registration or integration recommendations.
- On any source-read or allowed-command failure, report the failure and stop; do not retry, alter parameters, switch commands, or switch environments.
- On success, report only the output path, validation result, capabilities, and capabilities omitted because their evidence was insufficient.
- Validation success proves the file conforms to the local schema; it does not prove that an uncalled remote endpoint works.
