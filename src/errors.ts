export type CliErrorCode =
  | "CLI_ERROR"
  | "INTERNAL_ERROR"
  | "INVALID_ARGUMENT"
  | "CONFIG_INVALID"
  | "ENVIRONMENT_UNKNOWN"
  | "UNKNOWN_RESOURCE"
  | "CAPABILITY_MISSING"
  | "INVALID_ACTION"
  | "UNKNOWN_SELECTOR"
  | "REQUIRED_SELECTOR_MISSING"
  | "GRAPH_SOURCE_EMPTY"
  | "GRAPH_FLOW_ENTITY_MISSING"
  | "CONDITION_EXPRESSION_MISSING"
  | "CONDITION_PROPERTY_UNKNOWN"
  | "CONDITION_EXPRESSION_INVALID"
  | "CONDITION_EXPRESSION_MISMATCH"
  | "CONDITION_LABEL_MISSING"
  | "CONDITION_OVERLAP"
  | "CONDITION_COVERAGE_INCOMPLETE"
  | "GRAPH_SERVER_VALIDATION_FAILED"
  | "GRAPH_IMPORT_VERIFY_FAILED"
  | "EXECUTOR_NOT_FOUND"
  | "EXECUTOR_AMBIGUOUS"
  | "RESOURCE_DIRECTORY_INVALID"
  | "RESOURCE_DIRECTORY_MISSING"
  | "RESOURCE_CONTRACT_INVALID"
  | "RESOURCE_CONTRACT_CONFLICT"
  | "EADP_REQUEST_FAILED";

export interface CliErrorDetails {
  /** Stable machine-readable discriminator; defaults to "CLI_ERROR". */
  code?: CliErrorCode;
  /** Candidate values when the input could not be resolved uniquely. */
  candidates?: readonly string[];
  /** The parameter the caller must supply to proceed. */
  requiredInput?: string;
  /** Per-file or per-item diagnostics collected before the command stops. */
  issues?: readonly CliErrorIssue[];
  /** Server-provided failure detail, preserved without truncation. */
  detail?: unknown;
  /** Server or gateway trace identifier. */
  traceId?: string;
  /** Server or gateway request identifier. */
  requestId?: string;
}

export interface CliErrorIssue {
  path: string;
  message: string;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: CliErrorCode;
  readonly candidates: readonly string[] | undefined;
  readonly requiredInput: string | undefined;
  readonly issues: readonly CliErrorIssue[] | undefined;
  readonly detail: unknown | undefined;
  readonly traceId: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, exitCode = 1, details: CliErrorDetails = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = details.code ?? "CLI_ERROR";
    this.candidates = details.candidates;
    this.requiredInput = details.requiredInput;
    this.issues = details.issues;
    this.detail = details.detail;
    this.traceId = details.traceId;
    this.requestId = details.requestId;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render any thrown value as the machine-consumable failure envelope every
 * command writes to stderr. The `message` keeps the human-readable text while
 * `code`, `candidates`, and `requiredInput` let agents react deterministically.
 */
export function renderCliError(error: unknown): Record<string, unknown> {
  if (error instanceof CliError) {
    return {
      success: false,
      code: error.code,
      message: error.message,
      ...(error.candidates === undefined ? {} : { candidates: [...error.candidates] }),
      ...(error.requiredInput === undefined ? {} : { requiredInput: error.requiredInput }),
      ...(error.issues === undefined
        ? {}
        : { issues: error.issues.map((issue) => ({ ...issue })) }),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    };
  }
  if (isCommanderError(error)) {
    return {
      success: false,
      code: "INVALID_ARGUMENT",
      message: error.message
    };
  }
  return {
    success: false,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

/** Copy every structured field when adding context to an existing CLI error. */
export function cliErrorDetails(error: CliError): CliErrorDetails {
  return {
    code: error.code,
    ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
    ...(error.requiredInput === undefined ? {} : { requiredInput: error.requiredInput }),
    ...(error.issues === undefined ? {} : { issues: error.issues }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId })
  };
}

function isCommanderError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as unknown as Record<string, unknown>).code;
  return typeof code === "string" && code.startsWith("commander.");
}
