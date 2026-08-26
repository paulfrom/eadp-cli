# External resource contract schema

Generate UTF-8 YAML with a `.resource.yaml` suffix. The document is strict: unknown keys are invalid, and the top level is a flattened resource contract rather than a nested `contract` object.

## Required shape

```yaml
schemaVersion: eadp.resource-contract.v1
id: example-resource
title: Example resource
description: Evidence-backed purpose of this resource
service: example-service
query:
  path: exampleResource/findByPage
  method: POST
read: paged
pagination:
  pageField: pageInfo
  pageNumberField: page
  pageSizeField: rows
  startPage: 1
  rowsField: rows
  pageSize: 500
  totalSemantics: pages
identityFields: []
compareFields: []
writableFields: []
tenant:
  policy: any
capabilities:
  - query
help: Query the example resource
filtering:
  time: false
```

The example shows syntax, not default business semantics. Every concrete value still needs source or user-confirmed contract evidence.

## Fields and evidence

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Must be exactly `eadp.resource-contract.v1`. |
| `id` | Lowercase resource ID: `^[a-z][a-z0-9-]*$`. Do not invent aliases. |
| `title`, `description`, `help` | Summarize the evidenced business purpose and exposed capability. Do not claim write/sync support that is absent. |
| `service` | EADP gateway service segment evidenced by the API/client or user-confirmed deployment contract. Never place a URL or token here. |
| `query` | Service-relative safe path, without a leading slash, plus an explicit `GET` or `POST` method normally used for reads. The schema also accepts `PUT`/`PATCH`, but do not use them for query unless the source explicitly does. |
| `read` | Only `paged` or `findAll` is allowed externally. |
| `pagination` | Required only for `paged`; forbidden for `findAll`. Prove all request and response field names. `pageSize` is exactly `500`; `totalSemantics` is `pages`. |
| `identityFields` | Business unique key, not a database ID unless the business contract explicitly defines it as the cross-environment identity. May be empty for query-only resources. |
| `compareFields` | Stable fields whose semantics are safe to compare. Must contain every writable field. |
| `writableFields` | Exact save payload fields. Empty for query-only resources. |
| `sensitiveFields` | Fields that must be redacted from query output. A contract with sensitive fields is query-only because change plans and operation logs must not carry secrets. |
| `tenant.policy` | Exactly `any`, `global`, or `non-global`; include `bindField` only when the selected environment tenant must overwrite a proven identity field. |
| `capabilities` | Subset of `query`, `write`, `compare`, `sync`, narrowed by the evidence rules in `SKILL.md`. `sync` also requires `compare`. |
| `filtering` | Set `time: true` and optional `defaultTimeField` only when the query contract proves time filtering. Otherwise use `time: false`. |
| `enums` | Map a field to `{ value, meaning }` entries copied from an authoritative enum or API contract. Omit rather than guess. |

Optional fields are `aliases`, `save`, `sensitiveFields`, `defaults`, `filtering`, `enums`, `rollback`, `dependencies`, and `deletion`. Omit an optional field when it is not evidenced; do not fill it with invented placeholders.

## Write and deletion evidence

`save` accepts `POST`, `PUT`, or `PATCH`. External write requires all of the following:

- a non-empty business `identityFields` definition;
- exact `compareFields` and `writableFields`;
- target reread/verification semantics;
- `rollback.service` equal to `service`;
- a rollback `resource`, exact `remove` endpoint (`DELETE` or `POST`), ID field and placement;
- exact rollback `lookup` endpoint (`GET` or `POST`), ID field and placement.

Target-only deletion additionally requires a complete `deletion` contract with `remove`, `lookup`, and `restore`. An endpoint named `delete`, inherited CRUD methods, or a database ID by itself is insufficient evidence.

## Validation

After writing the file, validate only the generated artifact:

```powershell
eadp resource validate D:\absolute\path\example.resource.yaml
```

The path must be normalized and absolute. A directory is also accepted and validates every direct `*.resource.yaml` file. One invalid file does not stop later files from being parsed; after the scan, report every entry from the structured `issues` array and stop. Do not copy files into the CLI configuration directory's fixed `contracts` folder, configure, query, or retry with changed semantics.
