# External resource contract schema

Generate UTF-8 YAML with a `.resource.yaml` suffix. The document is strict: unknown keys are invalid, and the top level is a flattened resource contract rather than a nested `contract` object.

## Required shape

```yaml
schemaVersion: eadp.resource-contract.v2
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
| `schemaVersion` | Must be exactly `eadp.resource-contract.v2`. |
| `id` | Lowercase resource ID: `^[a-z][a-z0-9-]*$`. Do not invent aliases. |
| `title`, `description`, `help` | Summarize the evidenced business purpose and exposed capability. Do not claim write/sync support that is absent. |
| `service` | EADP gateway service segment evidenced by the API/client or user-confirmed deployment contract. Never place a URL or token here. |
| `query` | Service-relative safe path, without a leading slash, plus an explicit `GET` or `POST` method normally used for reads. The schema also accepts `PUT`/`PATCH`, but do not use them for query unless the source explicitly does. |
| `detail` | Optional single-record endpoint. Declare `path`, `method: GET|POST`, and one or more required `selectors`; include it only when the endpoint and its request/response semantics are evidenced. `capabilities` must contain `detail` exactly when this field is present. |
| `read` | Only `paged` or `findAll` is allowed externally. |
| `pagination` | Required only for `paged`; forbidden for `findAll`. Prove all request and response field names. `pageSize` is exactly `500`; `totalSemantics` is `pages`. |
| `identityFields` | Business unique key, not a database ID unless the business contract explicitly defines it as the cross-environment identity. May be empty for query-only resources. |
| `compareFields` | Stable fields whose semantics are safe to compare. Must contain every writable field. |
| `writableFields` | Exact save payload fields. Empty for query-only resources. |
| `sensitiveFields` | Fields that must be redacted from query and detail output. A contract with sensitive fields may declare only `query` and/or `detail`, because change plans and operation logs must not carry secrets. Sensitive fields must not be used as selectors. |
| `tenant.policy` | Exactly `any`, `global`, or `non-global`; include `bindField` only when the selected environment tenant must overwrite a proven identity field. |
| `capabilities` | Subset of `query`, `detail`, `write`, `compare`, `sync`, narrowed by the evidence rules in `SKILL.md`. `detail` must match the presence of `detail`; `sync` also requires `compare`. |
| `filtering` | Set `time: true` and optional `defaultTimeField` only when the query contract proves time filtering. Otherwise use `time: false`. |
| `enums` | Map a field to `{ value, meaning }` entries copied from an authoritative enum or API contract. Omit rather than guess. |

Optional fields are `aliases`, `detail`, `save`, `sensitiveFields`, `defaults`, `filtering`, `enums`, `rollback`, `dependencies`, and `deletion`. Omit an optional field when it is not evidenced; do not fill it with invented placeholders.

## Single-record detail

`detail` is independent of the collection `query` endpoint. It describes the one
endpoint used by `eadp resource detail <name> --select <name=value>` and must
identify exactly one record without falling back to a list query or local
filtering.

```yaml
detail:
  path: exampleResource/findOne/{recordId}
  method: GET
  selectors:
    - name: id
      field: recordId
      placement: path
      valuePlaceholder: id
      description: 资源唯一 ID
```

Each `detail.selectors` entry is required. `name` is the CLI selector name;
`field` is the remote request field or path placeholder; `placement` is exactly
one of:

- `path`: `detail.path` must contain the matching `{field}` placeholder. The
  value is URL-encoded and substituted into the path.
- `query`: the field/value is sent as a query parameter. This is the usual
  placement for a GET endpoint such as an evidenced `findOne?id=` contract.
- `body`: the field/value is sent in the JSON request body. GET detail
  endpoints cannot use body selectors; use POST only when the source contract
  proves it.

Selector names and remote fields must be unique, and every path placeholder
must correspond one-to-one with exactly one path selector; neither side may be
duplicated or left unmatched. `valuePlaceholder`
and `description` are help metadata, not evidence for a field or a default
value.

The endpoint must return the normal EADP success envelope with `data` equal to
one object for a match or `null` for no match. The CLI emits one `item`, or
`item: null`; arrays, pages, and other aggregate shapes are invalid.
Inherited `BaseEntityApi.findOne` can prove only the fixed route and ID query
placement. It does not, by itself, prove the business selector name, the
singleton response shape, or null/no-match semantics, so do not generate a
complete `detail` declaration from that inheritance alone.

## Write and deletion evidence

`save` accepts `POST`, `PUT`, or `PATCH`. External write requires all of the following:

- a non-empty business `identityFields` definition;
- exact `compareFields` and `writableFields`;
- target reread/verification semantics;
- `rollback.service` equal to `service`;
- a rollback `resource`, exact `remove` endpoint (`DELETE` or `POST`), ID field and placement;
- exact rollback `lookup` endpoint (`GET` or `POST`), ID field and placement.

Target-only deletion additionally requires a complete `deletion` contract with `remove`, `lookup`, and `restore`. An endpoint named `delete`, inherited CRUD methods, or a database ID by itself is insufficient evidence.

`detail` is read-only. It does not establish `write`, `compare`, or `sync`
evidence, and it does not replace the identity/rollback requirements for those
capabilities.

## Validation

Unless the user explicitly supplies another output location, first resolve the fixed generation target and write the contract there:

```powershell
eadp resource contract-path example-resource
```

Use the returned `path` exactly. After writing the file, validate only that generated artifact:

```powershell
eadp resource validate D:\absolute\path\example.resource.yaml
```

The path must be absolute; the CLI normalizes Windows slash style internally. A directory is also accepted and validates every direct `*.resource.yaml` file. One invalid file does not stop later files from being parsed; after the scan, report every entry from the structured `issues` array and stop. Do not create a temporary copy, configure environments, query resources, or retry with changed semantics.

Validation also rejects a `detail` capability without a `detail` endpoint (or
the reverse), invalid selector placement, GET body selectors, and path
placeholders that do not match the declared path selectors.
