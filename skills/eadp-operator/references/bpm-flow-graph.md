# BPM flow graph design, file transport and migration

Use this reference for `bpm-flow-graph`, the `bpm-migration` combined entry, and the
`bpm graph` file channel. None of them publishes a flow or retries a failed request.

## Choose the entry

For environment migration, keep the fixed skeleton-then-graph order:

```text
# skeleton only
eadp resource sync bpm --source dev --target test --select flow=TBS_PROJECT --apply

# graph only (target skeleton must already exist)
eadp resource sync bpm-flow-graph --source dev --target test --select flow=TBS_PROJECT --apply

# skeleton + graph in one plan, fixed order (preferred for a full migration)
eadp resource sync bpm-migration --source dev --target test --select flow=TBS_PROJECT --apply
```

All three entries preview by default, only write drafts (`deploy: false`), and require
`verified: true` after `--apply`. `bpm-migration` applies the skeleton first and re-plans
the graph afterwards; its preview treats dependencies planned by the same run as available.

For a new graph based on independent business input, start with the CLI-local guidance:

```text
eadp bpm graph guide
eadp bpm graph nodes
eadp bpm graph nodes --kind Approve
eadp bpm graph conditions --env dev --flow TBS_PROJECT
```

The input may be prose, structured data, an existing design, interface contracts, or other
evidence. Its file format is irrelevant. Do not look for or require a particular reference
implementation. Use only confirmed business facts, and resolve target bindings independently.

## Load the system decision conditions before designing any route

The platform decides gateway routes from the condition properties the target business
entity publishes. Load them from the target environment; never guess a variable name from a
Chinese label, a node title, or another environment:

```text
eadp bpm graph conditions --env dev --flow TBS_PROJECT
```

The output lists each condition property:

- `code`: the engine variable used in `groovyUel`, e.g. `#{fileType=="销售-合同验收"}`;
- `name`: the business label used in `logicUel`, e.g. `文件类型=="销售-合同验收"`;
- `initValue`: the value the engine validates the expression with;
- `remark`: the entity's own explanation.

It also carries the branching priority: **the system exclusive gateway
(`ExclusiveGateway`) has the highest priority**. Any route that the published condition
fields can decide must use a system exclusive gateway; `InclusiveGateway`,
`ParallelGateway` and finally `ManualExclusiveGateway` are fallbacks, and a manual
exclusive gateway needs an explicit reason why the system cannot decide.

Rules:

- A gateway condition may only use variables from that list. `validate` reports
  `CONDITION_VARIABLE_UNKNOWN` and `CONDITION_PROPERTY_UNKNOWN` for anything else, because
  the designer validates the expression against the same list before saving an edge.
- If the business needs a field the entity does not publish, say so and ask; do not
  substitute a similar field.
- `logicUel` uses the property `name`, `groovyUel` uses the property `code`, and both must
  express the same rule. A link label is not the executable condition.
- Every system exclusive gateway needs exactly one `uel.isDefault` edge.

## Uncertainty means ask, not choose

Before selecting or connecting a node, check its `usage.exampleScenarios`, `usage.notFor`,
`usage.requiredInputs`, and `usage.askWhenUnclear`. If node kind, executor, condition,
route, rejection behavior, page, interface, or subprocess is not uniquely determined, ask a
specific question and stop that design/write step. Never guess from a node display name,
copy the most common pattern, or use a default route to hide uncertainty.

At minimum distinguish:

- ordinary work (`Normal`) from an approval decision (`Approve`) and one-person confirmation
  without an approval fork (`SingleSign`);
- one stage with multiple decision-makers (`CounterSign`) from several sequential stages
  (`Approve`) and independent parallel branches (`ParallelGateway`);
- automatic one-route selection (`ExclusiveGateway`) from a user's runtime route choice
  (`ManualExclusiveGateway`), and from one-or-more routes (`InclusiveGateway`);
- rejection that terminates (`TerminateEndEvent`) from rejection that returns to a confirmed
  modification node and re-entry point (`Normal`, often `StartUser`);
- an automatic service, an external wait, and an independent published subprocess
  (`ServiceTask`, `ReceiveTask`, `CallActivity`).

For an ordered set of optional approvers that can accumulate, use a sequence of system
exclusive gateways: each gateway either enters its approval or takes its default edge to the
next decision. Do not turn independently additive conditions into fixed mutually exclusive
routes. For fixed routes that truly are mutually exclusive, a single system exclusive
gateway with a default route may be appropriate.

An approval/countersign needs exactly two exits and one `uel.agree` edge. System exclusive
and inclusive gateways need exactly one `uel.isDefault`; manual exclusive gateways do not.
A disagree outcome must have a confirmed destination; never silently replace modify-and-recheck
with termination.

## Resolve business bindings without guessing

- `StartUser`: initiator; `Person`: employee code; `Position`: position code plus organization
  context; `PositionType`: position category code.
- `SelfDefinition`: custom-person interface URL (`CUSTOM_PERSON`). A lifecycle callback is
  `EVENT`, not a person selector.
- `PositionTypeAndOrg`: both `PositionType` and `Org` fragments are required.
- `AnyOne` is not a fallback for an unknown executor.
- Node names are labels, not executor bindings. Read and confirm the `executor` configuration.
- Every condition needs its engine variable, type, allowed values, null behavior, comparison
  operator, threshold inclusivity, and unmatched/default route. Take the variable from
  `eadp bpm graph conditions`; `logicUel` and `groovyUel` must express the same rule, and a
  link label is not the executable condition.
- Resolve page and interface references by URL, and people/positions/categories/organizations
  by business code using read-only target queries. Zero or multiple candidates requires
  clarification; never copy source environment IDs.

## Create or use portable graph files

Use the file channel for both exported designs and new graphs built from sufficient business facts:

```text
eadp bpm graph nodes
eadp bpm graph conditions --env dev --flow TBS_PROJECT
eadp bpm graph export   --env dev --flow TBS_PROJECT --out tbs.json
eadp bpm graph validate --env ead --file tbs.json
eadp bpm graph validate --env ead --file tbs.json --strict
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json --strict
eadp bpm graph import   --env ead --flow TBS_PROJECT --file tbs.json --strict --apply
```

- `eadp bpm graph guide` is the offline design and acceptance checklist. It does not access
  an environment or read an external file.
- `eadp bpm graph nodes` is the authoritative, CLI-local node catalog: engine `type`,
  `nodeType`/`busType`, usage scenarios, counterexamples, required inputs, uncertainty
  questions, config, edge rules, executor rules and migration policy.
- `eadp bpm graph conditions` is the authoritative, read-only list of the decision fields
  the target business entity publishes, plus the gateway priority order.
- Format `eadp.bpm.graph.v1`: `{ kind, flow, graphs: [{ name, graph }] }`; `graph` is the
  canonical form (pages/interfaces by URL, people by code, no environment IDs).
- A new graph must be built as this canonical file, not as designer-raw `defJson`. The target
  flow type, business entity, pages and interfaces must exist before importing the graph.
- `export` fails with `GRAPH_SOURCE_EMPTY` when the flow type has no definition; this does not
  prohibit creating a canonical file from independently confirmed business input.
- `validate` is read-only. It reports `blockingIssues` (can it move?), `designIssues`
  (would the designer save it?) and `warnings`; `valid` keeps the migration meaning and
  `designValid` is the designer meaning. It also checks every gateway condition against the
  system condition fields and reports `CONDITION_VARIABLE_UNKNOWN`,
  `CONDITION_PROPERTY_UNKNOWN` or `CONDITION_EXPRESSION_MISSING` as `designIssues`.
  `--strict` makes `designIssues` fail `valid`.
- `import` compares the canonical graph with the target draft by flow type plus definition
  name: `create`, `update`, `unchanged`, or `blocked`. Repeated `--apply` is idempotent.
  An unexpected `create` may indicate a naming/matching error, not a safer write.
- Import writes drafts only. Review the preview, obtain authorization, apply the same command,
  require `verified: true`, preview again for `unchanged`, and publish manually in the designer.

## Business verification is separate from structure validation

Before previewing a write, derive expected paths from representative business inputs and compare
them with the graph. Cover skipped and additive roles, empty values, default routes, threshold
below/equal/above, agree/disagree, modification and re-entry scope, countersign/parallel behavior,
and post-completion actions. `designValid: true` proves neither rule coverage nor executor intent.

Keep semantic review separate from coordinates and line geometry. Layout may be regenerated for
readability, but never change conditions, executors or paths merely to match a visual reference.

## Results

- `create`: no target definition with the same `(flow, name)`; create it and its first draft.
- `update`: target draft differs; save one new draft version and preserve the definition `defKey`.
- `unchanged`: no `saveOrDeploy` call, so no version is created.
- `blocked`: reported with `blockingIssues` or `missingDependencies`; never written.

The plan `details` also expose `graphReadiness` (source/target definition counts) and
`nextActions` (create dependencies, remove unsupported nodes, publish in the designer).

## Rules

- Never guess a canvas from incomplete business input. A sufficient independent input may be
  converted to a canonical graph; an ambiguous input produces questions, not a write.
- Load the system decision conditions with `eadp bpm graph conditions` before designing a
  route. The system exclusive gateway has the highest priority, and a condition may only use
  a variable the target business entity publishes.
- Read node constraints and selection guidance from `eadp bpm graph nodes`, not from external
  project files. External designs are behavioral references only.
- `CallActivity`, `ProjectPosition`, and non-empty `smartAudit`/`ruleConfig` remain blocked.
  Do not silently delete or replace them to make an import pass.
- A target missing page, interface, employee, position, position category, organization,
  or dimension is reported as `missingDependencies`; fix it through the proper workflow, then preview again.
- Do not retry a failed HTTP call or a server `success: false` response, do not switch
  endpoints, and do not fall back to `resource sync bpm` or a raw request.
