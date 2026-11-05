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
eadp bpm graph expression --env dev --flow TBS_PROJECT --logic '文件类型=="信用-客户"'
eadp bpm graph expression --env dev --flow TBS_PROJECT --file conditions.json
eadp bpm graph resolve-executor --env dev --query 张三
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

Generate the pair from one input instead of writing both manually:

```text
eadp bpm graph expression --env dev --flow TBS_PROJECT \
  --logic '文件类型=="信用-客户"&&累计授信金额（客户）>=3000000'
```

The returned `expression` object can be used as `process.startUEL` or a system gateway edge's
`uel`. The CLI replaces names with codes longest-first, leaves quoted values unchanged, wraps the
executable expression as `#{...}`, and calls `conBusinessEntity/validateExpression` with the target
flow type. A `false` evaluation is valid; a server rejection is not. Do not use `${...}`, a bare
expression, or a second hand-written `groovyUel`. Default edges carry no expression.
For a condition matrix, use `expression --file <path>` with either a string array or
`{ "expressions": [{ "key": "credit", "logicUel": "文件类型==\"信用-客户\"" }] }`.
One response contains every pair and preserves each key; identical generated `groovyUel` text is sent
to the target JUEL validator only once. Local invalid rows and server validation failures remain
visible per row; transport/HTTP failures stop the command.

## Label every conditional edge and self-check before import

- Every edge carrying a nonblank `logicUel` or `groovyUel` must also carry a nonblank Chinese
  `uel.name` that states the business condition in no more than 16 Chinese characters. Do not leave
  the label as the raw expression, an English variable name, or a generic "条件边".
- When a condition combines multiple terms, use explicit parentheses in `logicUel` to show the
  intended priority, and generate the matching `groovyUel` from that same expression. For example,
  use `(类型=="A"||类型=="B")&&金额>=1000`, not an ambiguous unparenthesized mix of `||` and `&&`.
- Before import, run a local edge-by-edge self-check on the final file. List every expression edge's
  source, target, label and expression; require zero missing, blank, non-Chinese or overlength labels
  and zero ambiguous unparenthesized combinations. Any edge with an expression but no valid `name`
  must be completed and checked again before `import --apply`.
- Also run `validate --strict`; its `CONDITION_LABEL_MISSING` check is an additional guard, not a
  substitute for the Chinese/16-character local self-check.

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

## Confirm the skeleton and rejection policy before expanding the graph

Never expand the Cartesian product "business type × approval stage" into a flat graph in one step.
For independent business input, use this mandatory two-stage design workflow:

1. Produce only a skeleton: one ordered main line plus one system exclusive gateway immediately
   before each optional approval stage. A condition hit enters that stage; its default edge goes to
   the next stage's gateway, so an unmet condition skips the stage. An approval's agree path rejoins
   that same next-stage main line. Do not duplicate the whole stage sequence for each business type.
2. Put a business-type validation gateway at the entrance. Known types enter the confirmed main
   line; an unknown type must go to a separately confirmed modification/exception path and must
   never pass directly to `EndEvent` or `TerminateEndEvent`. Ask if that path is not confirmed.
3. Present the ordered stage list, the common nodes, the estimated node count (including gateways,
   the single modification node and end nodes), and the type-validation route to the user. Also ask
   the user to choose the rejection policy explicitly: return to the main-line entrance, or return
   to the first stage of the current branch. Record the selected modification node and re-entry
   scope. Do not generate the complete graph until the user confirms this skeleton, order, estimate
   and rejection policy.
4. Only then expand each confirmed stage's executor, conditions, agree/disagree edges and bindings.
   If confirmation changes the stage order or rejection scope, regenerate the local skeleton and
   ask again rather than silently patching routes.

The expected business-verification matrix below should be drafted from the same confirmed input;
it does not replace this explicit skeleton confirmation.

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
  clarification; never copy source environment IDs. For Person/Position/PositionType use the
  unified `eadp bpm graph resolve-executor --env <env> --query <中文名或code>` entry. It returns
  `bindingType`, the portable code and an executor fragment; zero candidates reports
  `EXECUTOR_NOT_FOUND`, and multiple candidates reports `EXECUTOR_AMBIGUOUS` with both string and
  structured candidate lists.

## Create or use portable graph files

Use the file channel for both exported designs and new graphs built from sufficient business facts:

```text
eadp bpm graph nodes
eadp bpm graph conditions --env dev --flow TBS_PROJECT
eadp bpm graph expression --env dev --flow TBS_PROJECT --logic '文件类型=="信用-客户"'
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
  the target business entity publishes, plus the gateway priority order and expression command.
- `eadp bpm graph expression` generates a consistent `logicUel`/`groovyUel` pair and validates it
  against the target environment before reporting `validated: true`.
- Format `eadp.bpm.graph.v1`: `{ kind, flow, graphs: [{ name, graph }] }`; `graph` is the
  canonical form (pages/interfaces by URL, people by code, no environment IDs).
- A new graph must be built as this canonical file, not as designer-raw `defJson`. The target
  flow type, business entity, pages and interfaces must exist before importing the graph.
- `export` fails with `GRAPH_SOURCE_EMPTY` when the flow type has no definition; this does not
  prohibit creating a canonical file from independently confirmed business input.
- `validate` is read-only. It reports `blockingIssues` (can it move?), `designIssues`
  (would the designer save it?) and `warnings`; `valid` keeps the migration meaning and
  `designValid` is the designer meaning. It also checks the flow start condition and every system
  exclusive/inclusive gateway condition against the system condition fields, checks the `#{...}`
  wrapper and pair consistency, and invokes the same
  server-side JUEL validation as the designer. It reports `CONDITION_VARIABLE_UNKNOWN`,
  `CONDITION_PROPERTY_UNKNOWN`, `CONDITION_EXPRESSION_MISSING`, `CONDITION_EXPRESSION_INVALID`, or
  `CONDITION_EXPRESSION_MISMATCH` as `designIssues`. `conditions.expressionValidation` summarizes
  attempted/validated/failed expression locations; identical expression text is remotely checked once.
  Transport and HTTP failures stop the command. `--strict` makes `designIssues` fail `valid`.
- `import` compares the canonical graph with the target draft by flow type plus definition
  name: `create`, `update`, `unchanged`, or `blocked`. A later rerun after verified success is
  idempotent; never use that as permission to repeat an apply whose write/verify state failed or
  remains uncertain. An unexpected `create` may indicate a naming/matching error, not a safer write.
- Import writes drafts only. Review the preview, obtain authorization, apply the same command and
  require `verified: true`; only then preview again for `unchanged`. Leave publication for separate
  explicit authorization and manual designer action.

## File tooling and coordinate-checked visual delivery

```text
eadp bpm graph layout --file tbs.json --check
eadp bpm graph layout --file tbs.json --write --check
eadp bpm graph export --env dev --flow TBS_PROJECT --out tbs.trim.json --trim
eadp bpm graph diff --file tbs.json --env test --flow TBS_PROJECT
```

- `layout` is offline. `--check` reports `throughNodeEdges`, `crossingEdges`,
  `overlappingNodes`, `width` and `height`; `--write` changes only local node `x/y`, using forward
  topological layers and leaving `isReverse` rejection edges out of rank calculation. Treat automatic
  layout only as a candidate: the final coordinates must also satisfy all rules below.
- Keep the main line in one vertical column without folding. Put each stage's pre-gateway and its
  corresponding approval node horizontally side by side on one fixed-pitch row; use the same row
  pitch throughout the main line.
- Route every disagree/rejection edge (`uel.agree=false`) out from the same chosen side of the
  approval nodes, merge them visually into one shared vertical rejection bus, and lead that bus to
  the graph's **only** document-modification node. Do not create one modification node per stage.
  Route the modification/re-entry line through the empty channel on the opposite side of the main
  line. Keep the confirmed policy unchanged: main-line entrance or current branch's first stage.
- After every layout change, run a coordinate-based local geometry self-check and
  `layout --check`. Report each graph's `throughNodeEdges`, `crossingEdges`, `overlappingNodes`,
  width and height; require zero through-node, crossing and overlap counts before delivery. If the
  renderer uses orthogonal buses or bend points, the local checker must measure those same segments,
  not just an idealized straight-line drawing.
- Deliver an SVG, PNG or offline HTML preview rendered from the final file's actual node `x/y` and
  the same edge channels/bend points used by the checker. A Mermaid drawing, manually rearranged
  screenshot or textual schematic is not the required coordinate preview. Use a full graph file,
  not `export --trim`, when coordinates must be retained.
- `export --trim` retains only nodes, edges, conditions and executors. Use the full export when an
  import must retain pages, interfaces and other configuration.
- `diff` is read-only and compares canonical content by definition name. It reports
  `create/update/unchanged/remote-only`, read-back node/edge counts and bounded JSON-path differences.
- `validate` also puts condition-label, exclusive-condition overlap/coverage, unreachable-node,
  dangling-edge, unexpected-cycle and duplicate-edge-ID diagnostics in `designIssues`. In particular,
  every expression edge needs a nonblank `uel.name` or reports `CONDITION_LABEL_MISSING`; `--strict`
  rejects the import. Exact codes and fixes are available from both `graph nodes` and `graph guide`.
- `graph guide` contains a minimal golden sample with an exclusive gateway, condition/default edges
  and an explicit rejection edge. Replace its flow, page URL and condition placeholders with confirmed
  target values before strict validation; never import placeholders blindly.
- Keep semantic review separate from geometry. Layout and preview code may change only local
  coordinates and rendering artifacts; they must never change conditions, executors, node kinds,
  edge endpoints, default/agree/reverse flags or any other path semantics to resemble a visual reference.

## Verify business semantics by executing an expectation matrix

Structural validation is not business verification. Before `import --apply`, derive an expectation
matrix from the confirmed business input and write a local script that walks and evaluates the final
`eadp.bpm.graph.v1` file. Keep the matrix, script and comparison report as delivery evidence.

1. Give each matrix row a stable ID, business type, key-variable values (including explicit nulls),
  approval outcomes where relevant, the expected ordered approval-stage sequence (期望停留环节序列),
  expected skipped stages,
  and the expected modification/re-entry sequence. Cover every business type × key-variable
  combination needed by the confirmed rules; do not sample only one row per type.
2. Include, at minimum, null/empty values; every threshold below, exactly equal to and above its
  boundary; additive roles with several conditions true together; roles that must be skipped;
  both agree and disagree at each relevant approval; and modification followed by re-entry across
  the exact confirmed scope. Include an unknown business type and prove it does not go directly to
  a terminal state. Cover countersign/parallel and post-completion behavior when present.
3. Make the script traverse actual edges and evaluate the actual `groovyUel` using the row's variable
  values; never treat `uel.name` as the executable condition. Respect explicit parentheses, data
  types, null semantics and threshold inclusivity. Unsupported syntax or uncertain coercion is a
  failed verification row, not permission to guess.
4. At every gateway, evaluate all non-default outgoing conditions first. Take `uel.isDefault=true`
  **only when no conditional outgoing edge matches**. Never select the default merely because it is
  listed first, and never silently choose the first of several matches; report ambiguous exclusive
  routing. At approvals, feed the row's agree/disagree outcome and follow the corresponding actual
  edge. Detect unexpected cycles with a step limit rather than hanging.
5. Emit one result per matrix row containing expected sequence, actual sequence, skipped stages,
  re-entry sequence and their differences. Compare every row in order, including skipped roles and
  terminal state. Any mismatch, evaluation error, ambiguity or missing coverage leaves the diff
  nonzero; fix the confirmed business design or the matrix expectation through user clarification,
  then rerun the entire matrix.
6. Only a report with full required coverage and **zero row differences** unlocks `import --apply`.
  `valid=true`, `designValid=true` and `conditions.expressionValidation.failed=0` are still required,
  but none of them proves business paths, rule coverage or executor intent.

## Protect existing flow definitions

- When the request is to configure a new flow without touching an old version, assign a completely
  new definition `name`; keep `graphs[].name` and `graph.process.name` consistent and do not reuse the
  old definition's name or identity. Name matching is by `(flow, name)`, not a safer variant of update.
- At import preview, inspect every target definition and require `action=create` (and no `update`)
  for this new-flow/old-version-preserved scenario. `update` or `unchanged` means the selected name
  matched an existing definition: do not apply; choose another genuinely new name and preview again.
- Authorization is limited to the exact definitions and actions shown in the confirmed preview.
  Never modify, freeze, publish or otherwise operate on an old version or any other unauthorized
  definition. Draft import does not publish; publication requires separate explicit authorization.

## Interpret import results without repeating writes

`import --apply` returns independent `write` and `verify` objects. Handle these states differently:

- **Write failure** (`write.status=failed`, normally with `verify.status=skipped`): stop the write
  workflow and report the original CLI error. Do not retry, alter parameters, switch endpoints or
  claim that verification succeeded.
- **Write success + verification failure** (`write.status=success`, `verify.status=failed`, exit 2 /
  `GRAPH_IMPORT_VERIFY_FAILED`): the server accepted the draft write, but read-back failed or
  differed. Never assert "not written" and never repeat `--apply`.
- In the latter case, preserve the original CLI output, then run one full, same-environment export:
  `eadp bpm graph export --env <same-target> --flow <same-flow> --out <new-readback-file>`.
  Compare that exported target draft with the local source file offline by definition name, node
  and edge counts, conditions, executors and paths. Use `verify.readBack` and its differences as
  additional evidence, not as a reason for another write.
- Report the evidence-based state explicitly: "written and read-back equal", "written but read-back
  differs" (list differences), or "write reported success but actual content remains unconfirmed"
  (when export cannot read it). Always attach the original CLI error/output and identify the export
  and comparison files. If export itself fails, report that failure too and stop; do not retry it.
- Only a verified successful apply may be followed by the normal preview-for-`unchanged` check.
  Server validation failures use `GRAPH_SERVER_VALIDATION_FAILED` with `detail.locations`; report
  the node/edge location and original error without changing the write scope.
- A transport failure or server `success=false` at any step stops immediately. Never retry, switch
  endpoints/environments, substitute a raw request, or convert an uncertain transport result into
  either "written" or "not written".

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
  a variable the target business entity publishes. Use `graph expression` to generate and validate
  both UEL fields from one `logicUel`; strict graph validation must have zero failed expressions.
- Read node constraints and selection guidance from `eadp bpm graph nodes`, not from external
  project files. External designs are behavioral references only.
- `CallActivity`, `ProjectPosition`, and non-empty `smartAudit`/`ruleConfig` remain blocked.
  Do not silently delete or replace them to make an import pass.
- A target missing page, interface, employee, position, position category, organization,
  or dimension is reported as `missingDependencies`; fix it through the proper workflow, then preview again.
- Do not retry a failed HTTP call or a server `success: false` response, do not switch
  endpoints, and do not fall back to `resource sync bpm` or a raw request.
