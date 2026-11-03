# BPM flow graph migration and file transport

Use this reference for `bpm-flow-graph`, the `bpm-migration` combined entry, and the
`bpm graph` file channel. None of them edits a graph from prose, publishes a flow, or
retries a failed request.

## Choose the entry

```text
# skeleton only
eadp resource sync bpm --source dev --target test --select flow=TBS_PROJECT --apply

# graph only (target skeleton must already exist)
eadp resource sync bpm-flow-graph --source dev --target test --select flow=TBS_PROJECT --apply

# skeleton + graph in one plan, fixed order (preferred for a full migration)
eadp resource sync bpm-migration --source dev --target test --select flow=TBS_PROJECT --apply
```

All three entries preview by default, only write drafts (`deploy: false`), and require
`verified: true` after `--apply`. `bpm-migration` declares `bpm` and `bpm-flow-graph` as
dependencies; the engine applies the skeleton first and re-plans the graph afterwards.
Its preview already treats pages/interfaces/flow types planned by the same run as
available, so a graph is not reported `blocked` for a dependency that is being created.

## Portable graph files

Use the file channel when the source environment has no design draft yet:

```text
eadp bpm graph nodes
eadp bpm graph export   --env dev --flow TBS_PROJECT --out tbs.json
eadp bpm graph validate --env ead --file tbs.json
eadp bpm graph validate --env ead --file tbs.json --strict
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json --apply
```

- `eadp bpm graph nodes` is the authoritative, CLI-local node catalog: engine `type`,
  `nodeType`/`busType`, required config, edge rules, executor rules and migration policy.
  It never reads an external repository or source file.
- Format `eadp.bpm.graph.v1`: `{ kind, flow, graphs: [{ name, graph }] }`; `graph` is the
  canonical form (pages/interfaces by URL, people by code, no environment IDs).
- `export` fails with `GRAPH_SOURCE_EMPTY` when the flow type has no definition; draw one
  draft in the BPM designer (or import a file produced elsewhere) and retry.
- `validate` is read-only. It reports `blockingIssues` (can it move?), `designIssues`
  (would the designer save it?) and `warnings`; `valid` keeps the migration meaning and
  `designValid` is the designer meaning. `--strict` makes `designIssues` fail `valid`.
- `import` compares the canonical graph with the target draft: `create`, `update`,
  `unchanged`, or `blocked`. Repeated `--apply` is idempotent. `--strict` refuses graphs
  the designer could not save.
- Executors keep their composite `type` and `userType` fragments; `PositionTypeAndOrg`
  must have both fragment and `SelfDefinition.name` is rebuilt from the target interface.

## Results

- `create`: no target definition with the same `(flow, name)`; create it and its first draft.
- `update`: target draft differs; save one new draft version and preserve the definition `defKey`.
- `unchanged`: no `saveOrDeploy` call, so no version is created.
- `blocked`: reported with `blockingIssues` or `missingDependencies`; never written.

The plan `details` also expose `graphReadiness` (source/target definition counts) and
`nextActions` (create dependencies, remove unsupported nodes, publish in the designer).

## Rules

- Never synthesize a canvas from tables or guessed field names. Use an exported file, a
  designer draft, or stop and report the missing source.
- Read node constraints from `eadp bpm graph nodes`, not from assumptions or external
  project files; the catalog ships inside the CLI.
- `CallActivity`, `ProjectPosition`, and non-empty `smartAudit`/`ruleConfig` remain blocked.
- Approve/CounterSign need exactly two exits with one `uel.agree`; system exclusive and
  inclusive gateways need exactly one `uel.isDefault`; manual exclusive gateways do not.
- A target missing page, interface, employee, position, position category, organization,
  or dimension is reported as `missingDependencies`; fix it, then preview again.
- Do not retry a failed HTTP call or a server `success: false` response, do not switch
  endpoints, and do not fall back to `resource sync bpm` or a raw request.
