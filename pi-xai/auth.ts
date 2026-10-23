import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import {
  login as oauthLogin,
  OAuthError,
  refreshToken,
  type DeviceCode,
  type OAuthOptions,
  type TokenResponse,
} from "./src/oauth.ts";
import { readEnvironment, type EnvironmentReader } from "./src/secret.ts";

export interface LocalAuthOptions extends OAuthOptions {
  authPath?: string;
  env?: EnvironmentReader;
  lockTimeoutMs?: number;
}

export interface AuthStatus {
  authenticated: boolean;
  path: string;
  expiresAt?: string;
  refreshable?: boolean;
  expired?: boolean;
}

/** The complete provider response is retained under token, including extra fields. */
export interface CachedLogin {
  version: 1;
  obtainedAt: number;
  expiresAt: number;
  token: TokenResponse;
}

export class LocalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAuthError";
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < 8.64e15
  );
}

export function resolveAuthPath({
  authPath,
  env = readEnvironment,
}: Pick<LocalAuthOptions, "authPath" | "env"> = {}): string {
  return resolve(
    authPath ??
      env("XAI_AUTH_FILE") ??
      join(
        env("XDG_CONFIG_HOME") || join(homedir(), ".config"),
        "xai",
        "auth.json",
      ),
  );
}

/** Node host adapter; importing this module never reads or creates credentials. */
export function createLocalAuth(options: LocalAuthOptions = {}) {
  const path = resolveAuthPath(options);
  const now = options.now ?? Date.now;
  const lockTimeout = options.lockTimeoutMs ?? 35_000;
  if (!Number.isFinite(lockTimeout) || lockTimeout <= 0) {
    throw new RangeError("lockTimeoutMs must be positive");
  }

  async function read(): Promise<CachedLogin | undefined> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw new LocalAuthError(
        "Cannot read the xAI login cache; check its path and permissions.",
      );
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error();
      const data = JSON.parse(await file.readFile("utf8")) as CachedLogin;
      if (
        !data ||
        data.version !== 1 ||
        !validTime(data.obtainedAt) ||
        !validTime(data.expiresAt) ||
        data.expiresAt <= data.obtainedAt ||
        !data.token ||
        typeof data.token !== "object" ||
        Array.isArray(data.token) ||
        !nonempty(data.token.access_token) ||
        (data.token.refresh_token !== undefined &&
          !nonempty(data.token.refresh_token)) ||
        typeof data.token.expires_in !== "number" ||
        !Number.isFinite(data.token.expires_in) ||
        data.token.expires_in <= 0
      ) {
        throw new Error();
      }
      return data;
    } catch {
      throw new LocalAuthError(
        "Invalid xAI login cache. Run pnpm auth login to replace it.",
      );
    } finally {
      await file.close();
    }
  }

  function statusOf(cache?: CachedLogin): AuthStatus {
    return cache
      ? {
          authenticated: true,
          path,
          expiresAt: new Date(cache.expiresAt).toISOString(),
          refreshable: nonempty(cache.token.refresh_token),
          expired: cache.expiresAt <= now(),
        }
      : { authenticated: false, path };
  }

  function fresh(cache: CachedLogin): boolean {
    const skew = Math.min(300_000, cache.token.expires_in! * 500);
    return cache.expiresAt - now() > skew;
  }

  async function ensureRegularPath() {
    try {
      if (!(await lstat(path)).isFile())
        throw new LocalAuthError("The xAI login cache must be a regular file.");
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
  }

  async function withLock<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal = options.signal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const compromised = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, compromised.signal])
      : compromised.signal;
    const deadline = Date.now() + lockTimeout;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      combined.throwIfAborted();
      try {
        release = await lockfile.lock(path, {
          realpath: false,
          stale: 30_000,
          update: 5_000,
          retries: 0,
          onCompromised() {
            compromised.abort(
              new LocalAuthError(
                "The xAI cache lock was lost; retry the command.",
              ),
            );
          },
        });
      } catch (error) {
        if (code(error) !== "ELOCKED")
          throw new LocalAuthError(
            "Cannot lock the xAI login cache; check its directory permissions.",
          );
        if (Date.now() >= deadline)
          throw new LocalAuthError(
            "The xAI login cache is busy; retry when the other auth command finishes.",
          );
        try {
          await delay(
            Math.min(100, Math.max(1, deadline - Date.now())),
            undefined,
            { signal: combined },
          );
        } catch {
          combined.throwIfAborted();
          throw new LocalAuthError("Unable to wait for the xAI cache lock.");
        }
      }
    }
    try {
      combined.throwIfAborted();
      await ensureRegularPath();
      return await operation(combined);
    } finally {
      try {
        await release();
      } catch {
        if (!combined.aborted)
          throw new LocalAuthError("Unable to release the xAI cache lock.");
      }
    }
  }

  async function save(
    token: TokenResponse,
    signal: AbortSignal,
  ): Promise<CachedLogin> {
    const obtainedAt = now();
    const expiresAt = obtainedAt + token.expires_in! * 1000;
    if (
      !validTime(obtainedAt) ||
      !validTime(expiresAt) ||
      expiresAt <= obtainedAt
    ) {
      throw new LocalAuthError("The xAI token has an invalid expiry.");
    }
    const cache: CachedLogin = { version: 1, obtainedAt, expiresAt, token };
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(cache, null, 2) + "\n", "utf8");
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      await rename(temporary, path);
      return cache;
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }

  async function refresh(
    cache: CachedLogin,
    signal: AbortSignal,
  ): Promise<CachedLogin> {
    if (!nonempty(cache.token.refresh_token)) {
      throw new LocalAuthError(
        "This xAI login cannot be refreshed. Run pnpm auth login again.",
      );
    }
    try {
      const token = await refreshToken(cache.token.refresh_token, {
        ...options,
        signal,
      });
      // Fields omitted on refresh remain available in the cached provider JSON.
      return await save({ ...cache.token, ...token }, signal);
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_grant") {
        throw new LocalAuthError(
          "The xAI session has expired. Run pnpm auth login again.",
        );
      }
      throw error;
    }
  }

  async function getCachedAccessToken(): Promise<string | undefined> {
    options.signal?.throwIfAborted();
    const cache = await read();
    if (!cache) return undefined;
    if (fresh(cache)) return cache.token.access_token;
    return await withLock(async (signal) => {
      const latest = await read();
      if (!latest) return undefined;
      return (fresh(latest) ? latest : await refresh(latest, signal)).token
        .access_token;
    });
  }

  return {
    path,
    getCachedAccessToken,
    async getAccessToken(): Promise<string> {
      const token = await getCachedAccessToken();
      if (!token)
        throw new LocalAuthError(
          "No cached xAI login. Run pnpm auth login first.",
        );
      return token;
    },
    async login({
      onDeviceCode,
      signal,
    }: {
      onDeviceCode: (device: DeviceCode) => void | Promise<void>;
      signal?: AbortSignal;
    }): Promise<AuthStatus> {
      const loginSignal =
        signal && options.signal
          ? AbortSignal.any([signal, options.signal])
          : (signal ?? options.signal);
      return await withLock(async (lockedSignal) => {
        const token = await oauthLogin({
          ...options,
          signal: lockedSignal,
          onDeviceCode,
        });
        return statusOf(await save(token, lockedSignal));
      }, loginSignal);
    },
    async refresh(): Promise<AuthStatus> {
      return await withLock(async (signal) => {
        const cache = await read();
        if (!cache)
          throw new LocalAuthError(
            "No cached xAI login. Run pnpm auth login first.",
          );
        return statusOf(await refresh(cache, signal));
      });
    },
    async status(): Promise<AuthStatus> {
      return statusOf(await read());
    },
    async logout(): Promise<void> {
      // Avoid creating a directory for a login that has never existed.
      try {
        await lstat(path);
      } catch (error) {
        if (code(error) === "ENOENT") {
          // A first login can hold the lock before it has created the cache.
          try {
            await lstat(`${path}.lock`);
          } catch (lockError) {
            if (code(lockError) === "ENOENT") return;
            throw lockError;
          }
        } else {
          throw error;
        }
      }
      await withLock(async (signal) => {
        signal.throwIfAborted();
        await rm(path, { force: true });
      });
    },
  };
}
