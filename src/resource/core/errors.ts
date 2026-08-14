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
  reason: "invalid" | "ambiguous";
  message: string;
  /** Optional identity details supplied by aggregate behavior extensions. */
  identityField?: string;
  value?: string | null;
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
