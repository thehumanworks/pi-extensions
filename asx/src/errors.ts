export class WorkflowError extends Error {
  readonly code: string;
  readonly stepKey?: string;
  constructor(code: string, message: string, stepKey?: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.stepKey = stepKey;
  }
}

export function errorDetails(error: unknown): { code: string; message: string; stepKey?: string } {
  return error instanceof WorkflowError
    ? { code: error.code, message: error.message, ...(error.stepKey ? { stepKey: error.stepKey } : {}) }
    : { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}
