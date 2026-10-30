/**
 * Public SDK errors. Messages carry at most Loggly's short error text, never
 * response bodies (which can contain private log data) or credentials.
 */
export class LogglyError extends Error {
  override name = "LogglyError";
}

/** The request failed at the network layer or timed out after all retries. */
export class LogglyTransportError extends LogglyError {
  override name = "LogglyTransportError";
}

/** Loggly answered with an unexpected document (invalid JSON or schema). */
export class LogglyResponseError extends LogglyError {
  override name = "LogglyResponseError";
}

/** A pagination URL was unsafe to follow or repeated an earlier page. */
export class LogglyPaginationError extends LogglyError {
  override name = "LogglyPaginationError";
}

export interface LogglyApiErrorDetails {
  status: number;
  /** Loggly's short error text, when it supplied one. */
  serverMessage?: string;
  /** Loggly's x-loggly-request-uuid header, useful for support tickets. */
  requestId?: string;
}

/** Loggly returned a non-success HTTP status. */
export class LogglyApiError extends LogglyError {
  override name = "LogglyApiError";
  readonly status: number;
  readonly serverMessage?: string;
  readonly requestId?: string;

  constructor(details: LogglyApiErrorDetails) {
    super(describeStatus(details));
    this.status = details.status;
    this.serverMessage = details.serverMessage;
    this.requestId = details.requestId;
  }
}

/** HTTP 401: the API token is invalid or retired. */
export class LogglyAuthenticationError extends LogglyApiError {
  override name = "LogglyAuthenticationError";
}

/** HTTP 403: the token's user may not perform this action. */
export class LogglyPermissionError extends LogglyApiError {
  override name = "LogglyPermissionError";
}

/** HTTP 429 or 503: throttled or temporarily unavailable. */
export class LogglyRateLimitError extends LogglyApiError {
  override name = "LogglyRateLimitError";
}

function describeStatus({ status, serverMessage }: LogglyApiErrorDetails): string {
  const detail = serverMessage ? ` (${serverMessage})` : "";
  const base = `Loggly API request failed with HTTP ${status}${detail}`;
  // Loggly reports malformed search syntax as a generic HTTP 500.
  if (status === 500) return `${base}. Loggly also returns HTTP 500 for malformed queries: check quotes, parentheses and field names.`;
  if (status === 400) return `${base}. Check time ranges (relative like -15m or ISO 8601) and parameters.`;
  return base;
}

export function apiErrorFor(details: LogglyApiErrorDetails): LogglyApiError {
  if (details.status === 401) return new LogglyAuthenticationError(details);
  if (details.status === 403) return new LogglyPermissionError(details);
  if (details.status === 429 || details.status === 503) return new LogglyRateLimitError(details);
  return new LogglyApiError(details);
}
