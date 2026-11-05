import { CliError } from "../../errors.js";

export interface MissingDependency {
  resource: string;
  identityField: "code";
  value: string;
  reason: "missing" | "ambiguous";
}

export interface BlockingIssue {
  resource: string;
  field: string;
  reason: "invalid" | "ambiguous" | "undeclared-delete";
  message: string;
  /** Optional identity details supplied by aggregate behavior extensions. */
  identityField?: string;
  value?: string | null;
  /** Stable machine-readable discriminator, e.g. NODE_EXIT_COUNT. */
  code?: string;
  severity?: "error" | "warning";
  scope?: "graph" | "node" | "edge" | "executor";
  nodeId?: string;
  nodeName?: string;
  /** Stable edge identity and exact JSON location when an issue belongs to one edge. */
  edgeId?: string;
  jsonPath?: string;
  expectedType?: string;
  actualValue?: unknown;
  /** Actionable repair hint for humans and agents. */
  fix?: string;
}

export class DependencyResolutionError extends CliError {
  constructor(readonly missingDependencies: MissingDependency[]) {
    super(
      missingDependencies
        .map((dependency) =>
          `${dependency.resource}.${dependency.identityField}=${dependency.value} (${dependency.reason})`
        )
        .join(", ")
    );
  }
}

export class RecordMappingError extends CliError {
  constructor(readonly blockingIssues: BlockingIssue[]) {
    super(blockingIssues.map((issue) => issue.message).join(", "));
  }
}
