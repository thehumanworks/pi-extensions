/** Runtime-neutral xAI subscription OAuth; callers own UI and persistence. */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  [field: string]: unknown;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  /** Absolute expiry in milliseconds, measured before the device request. */
  expires_at: number;
}

export interface OAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const SAFE_CODES = [
  "authorization_pending",
  "slow_down",
  "access_denied",
  "authorization_denied",
  "expired_token",
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
  "request_failed",
  "invalid_response",
  "cancelled",
  "timeout",
  "network_error",
  "invalid_options",
] as const;
type ErrorCode = (typeof SAFE_CODES)[number];

/** Errors never carry server descriptions, response bodies, or underlying causes. */
export class OAuthError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(code: string, status?: number) {
    const safe = SAFE_CODES.includes(code as ErrorCode)
      ? (code as ErrorCode)
      : "request_failed";
    super(
      `xAI OAuth: ${safe}${status === undefined ? "" : ` (HTTP ${status})`}`,
    );
    this.name = "OAuthError";
    this.code = safe;
    this.status = status;
  }
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== "string" || !body[field].trim()) {
    throw new OAuthError("invalid_response");
  }
  return body[field];
}

function verificationUri(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))
    )
      return value;
  } catch {
    /* Reject without including the untrusted URL. */
  }
  throw new OAuthError("invalid_response");
}

function check(options: OAuthOptions, deadline = Infinity): void {
  if (options.signal?.aborted) throw new OAuthError("cancelled");
  if ((options.now ?? Date.now)() >= deadline)
    throw new OAuthError("expired_token");
}

/** Race even non-cooperative injected transports/sleepers, and abort real I/O. */
async function bounded<T>(
  options: OAuthOptions,
  duration: number,
  code: ErrorCode,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  check(options);
  const controller = new AbortController();
  let reject!: (error: OAuthError) => void;
  const interrupted = new Promise<never>((_, failure) => {
    reject = failure;
  });
  const abort = () => {
    reject(new OAuthError("cancelled"));
    controller.abort();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => {
      reject(new OAuthError(code));
      controller.abort();
    },
    Math.min(duration, 2_147_483_647),
  );
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new OAuthError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function post(
  url: string,
  fields: Record<string, string>,
  options: OAuthOptions,
  deadline = Infinity,
): Promise<{ body: Record<string, unknown>; status: number; ok: boolean }> {
  check(options, deadline);
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!positive(timeout)) throw new OAuthError("invalid_options");
  const remaining = deadline - (options.now ?? Date.now)();
  return bounded(
    options,
    Math.min(timeout, remaining),
    remaining <= timeout ? "expired_token" : "timeout",
    async (signal) => {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: "POST",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
          signal,
        });
      } catch {
        throw new OAuthError("network_error");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new OAuthError("invalid_response", response.status);
      }
      check(options, deadline);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new OAuthError("invalid_response", response.status);
      }
      return {
        body: body as Record<string, unknown>,
        status: response.status,
        ok: response.ok,
      };
    },
  );
}

function failure(response: {
  body: Record<string, unknown>;
  status: number;
}): OAuthError {
  return new OAuthError(
    typeof response.body.error === "string"
      ? response.body.error
      : "request_failed",
    response.status,
  );
}

function tokens(
  body: Record<string, unknown>,
  previousRefresh?: string,
): TokenResponse {
  requiredString(body, "access_token");
  const refresh =
    body.refresh_token === undefined && previousRefresh
      ? previousRefresh
      : requiredString(body, "refresh_token");
  // The pinned Pi xAI OAuth provider uses one hour when xAI omits expires_in.
  const lifetime = body.expires_in === undefined ? 3600 : body.expires_in;
  if (!positive(lifetime)) throw new OAuthError("invalid_response");
  return {
    ...body,
    access_token: body.access_token as string,
    refresh_token: refresh,
    expires_in: lifetime,
  };
}

export async function requestDeviceCode(
  options: OAuthOptions = {},
): Promise<DeviceCode> {
  const started = (options.now ?? Date.now)();
  const response = await post(
    DEVICE_URL,
    { client_id: CLIENT_ID, scope: SCOPE, referrer: "xai-cli" },
    options,
  );
  if (!response.ok || response.body.error !== undefined)
    throw failure(response);
  const body = response.body;
  if (
    !positive(body.expires_in) ||
    (body.interval !== undefined &&
      body.interval !== 0 &&
      !positive(body.interval))
  ) {
    throw new OAuthError("invalid_response");
  }
  const device: DeviceCode = {
    device_code: requiredString(body, "device_code"),
    user_code: requiredString(body, "user_code"),
    verification_uri: verificationUri(requiredString(body, "verification_uri")),
    expires_in: body.expires_in,
    interval: positive(body.interval) ? body.interval : 5,
    expires_at: started + body.expires_in * 1000,
  };
  if (body.verification_uri_complete !== undefined) {
    device.verification_uri_complete = verificationUri(
      requiredString(body, "verification_uri_complete"),
    );
  }
  check(options, device.expires_at);
  return device;
}

export async function pollDeviceCode(
  device: DeviceCode,
  options: OAuthOptions = {},
): Promise<TokenResponse> {
  if (
    !positive(device.interval) ||
    !Number.isFinite(device.expires_at) ||
    !device.device_code?.trim()
  ) {
    throw new OAuthError("invalid_response");
  }
  let interval = device.interval * 1000;
  while (true) {
    check(options, device.expires_at);
    const remaining = device.expires_at - (options.now ?? Date.now)();
    await bounded(options, remaining, "expired_token", (signal) =>
      (options.sleep ?? sleep)(Math.min(interval, remaining), signal),
    );
    check(options, device.expires_at);
    const response = await post(
      TOKEN_URL,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: device.device_code,
      },
      options,
      device.expires_at,
    );
    if (response.ok && response.body.error === undefined)
      return tokens(response.body);
    if (response.body.error === "authorization_pending") continue;
    if (response.body.error === "slow_down") {
      interval = Math.max(
        interval + 5000,
        positive(response.body.interval) ? response.body.interval * 1000 : 0,
      );
      continue;
    }
    throw failure(response);
  }
}

export async function refreshToken(
  refresh: string,
  options: OAuthOptions = {},
): Promise<TokenResponse> {
  if (typeof refresh !== "string" || !refresh.trim())
    throw new OAuthError("invalid_options");
  const response = await post(
    TOKEN_URL,
    {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    },
    options,
  );
  if (!response.ok || response.body.error !== undefined)
    throw failure(response);
  return tokens(response.body, refresh);
}

export async function login(
  options: OAuthOptions & {
    onDeviceCode: (device: DeviceCode) => void | Promise<void>;
  },
): Promise<TokenResponse> {
  const device = await requestDeviceCode(options);
  await options.onDeviceCode(device);
  return pollDeviceCode(device, options);
}
