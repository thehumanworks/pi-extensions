import assert from "node:assert/strict";
import { test } from "node:test";
import {
  login,
  OAuthError,
  pollDeviceCode,
  refreshToken,
  requestDeviceCode,
} from "../src/oauth.ts";
import type { DeviceCode, OAuthOptions } from "../src/oauth.ts";

const DEVICE = {
  device_code: "device-secret",
  user_code: "VISIBLE",
  verification_uri: "https://accounts.x.ai/device",
  verification_uri_complete: "https://accounts.x.ai/device?code=VISIBLE",
  expires_in: 600,
  interval: 5,
};
const TOKEN = {
  access_token: "access-secret",
  refresh_token: "refresh-secret",
  expires_in: 3600,
};

function fixture(replies: Array<unknown | Response>) {
  let now = 1000;
  const requests: Array<{ url: string; init: RequestInit; at: number }> = [];
  const waits: number[] = [];
  const options: OAuthOptions = {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init: init!, at: now });
      assert(replies.length, "Unexpected OAuth request");
      const reply = replies.shift();
      return reply instanceof Response ? reply : Response.json(reply);
    }) as typeof fetch,
  };
  return {
    options,
    requests,
    waits,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function form(request: { init: RequestInit }): Record<string, string> {
  return Object.fromEntries(
    new URLSearchParams(request.init.body as URLSearchParams),
  );
}

function isError(code: string, status?: number) {
  return (error: unknown) => {
    assert(error instanceof OAuthError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test("device request uses the public client and conservatively anchors expiry", async () => {
  const f = fixture([DEVICE]);
  const device = await requestDeviceCode(f.options);
  assert.deepEqual(device, { ...DEVICE, expires_at: 601000 });
  assert.equal(f.requests[0].url, "https://auth.x.ai/oauth2/device/code");
  assert.deepEqual(form(f.requests[0]), {
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    scope: "openid profile email offline_access grok-cli:access api:access",
    referrer: "xai-cli",
  });
  assert.equal(f.requests[0].init.method, "POST");
  assert.equal(f.requests[0].init.redirect, "error");
  assert.deepEqual(f.requests[0].init.headers, {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
});

test("login awaits notification, waits before first poll, and retains all provider fields", async () => {
  const token = {
    ...TOKEN,
    id_token: "id-secret",
    scope: "api:access",
    metadata: { principal: "fixture" },
    extra: [1, true],
  };
  const f = fixture([DEVICE, token]);
  let notified = false;
  const result = await login({
    ...f.options,
    async onDeviceCode(device) {
      assert.equal(device.user_code, "VISIBLE");
      assert.equal(f.requests.length, 1);
      await Promise.resolve();
      notified = true;
    },
  });
  assert(notified);
  assert.deepEqual(result, token);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(f.requests[1].at, 6000);
  assert.deepEqual(form(f.requests[1]), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    device_code: "device-secret",
  });
});

test("pending polls preserve cadence and each slow_down adds five seconds or server interval", async () => {
  const error = (body: object) => Response.json(body, { status: 400 });
  const f = fixture([
    DEVICE,
    error({ error: "authorization_pending" }),
    error({ error: "slow_down", interval: 2 }),
    error({ error: "slow_down", interval: 20 }),
    TOKEN,
  ]);
  const device = await requestDeviceCode(f.options);
  assert.deepEqual(await pollDeviceCode(device, f.options), TOKEN);
  assert.deepEqual(f.waits, [5000, 5000, 10000, 20000]);
});

test("device default and RFC zero intervals use a five-second wait", async () => {
  for (const interval of [undefined, 0]) {
    const f = fixture([{ ...DEVICE, interval }, TOKEN]);
    const device = await requestDeviceCode(f.options);
    assert.equal(device.interval, 5);
    await pollDeviceCode(device, f.options);
    assert.deepEqual(f.waits, [5000]);
  }
});

test("denial and provider expiry terminate polling with safe errors", async () => {
  for (const code of [
    "access_denied",
    "authorization_denied",
    "expired_token",
  ]) {
    const f = fixture([
      DEVICE,
      Response.json(
        { error: code, error_description: "secret-server-data" },
        { status: 400 },
      ),
    ]);
    const device = await requestDeviceCode(f.options);
    await assert.rejects(pollDeviceCode(device, f.options), isError(code, 400));
    assert.equal(f.requests.length, 2);
  }
});

test("absolute expiry is preserved across delays and never sends an expired poll", async () => {
  const f = fixture([{ ...DEVICE, expires_in: 6 }]);
  const device = await requestDeviceCode(f.options);
  f.advance(2000);
  await assert.rejects(
    pollDeviceCode(device, f.options),
    isError("expired_token"),
  );
  assert.deepEqual(f.waits, [4000]);
  assert.equal(f.requests.length, 1);
  await assert.rejects(
    pollDeviceCode(device, f.options),
    isError("expired_token"),
  );
});

test("request latency consumes device lifetime", async () => {
  const f = fixture([]);
  f.options.fetch = (async () => {
    f.advance(1000);
    return Response.json({ ...DEVICE, expires_in: 0.5 });
  }) as typeof fetch;
  await assert.rejects(requestDeviceCode(f.options), isError("expired_token"));
});

test("malformed device success bodies and untrusted verification URLs reject", async () => {
  const invalid = [
    null,
    [],
    "secret-server-data",
    {},
    { ...DEVICE, device_code: " " },
    { ...DEVICE, expires_in: 0 },
    { ...DEVICE, expires_in: "600" },
    { ...DEVICE, interval: -1 },
    { ...DEVICE, verification_uri_complete: "" },
    ...[
      "javascript:alert(1)",
      "http://accounts.x.ai/device",
      "https://evil.test/",
      "https://x.ai.evil.test/",
      "https://x.ai@evil.test/",
      "https://secret@accounts.x.ai/",
      "https://accounts.x.ai:444/",
    ].map((verification_uri) => ({ ...DEVICE, verification_uri })),
    { ...DEVICE, verification_uri_complete: "https://evil.test/" },
  ];
  for (const body of invalid)
    await assert.rejects(
      requestDeviceCode(fixture([body]).options),
      isError("invalid_response"),
    );
});

test("initial token success requires usable access, refresh, and a positive provided lifetime", async () => {
  for (const body of [
    {},
    { ...TOKEN, access_token: " " },
    { ...TOKEN, access_token: 3 },
    { ...TOKEN, refresh_token: undefined },
    { ...TOKEN, refresh_token: null },
    { ...TOKEN, expires_in: 0 },
    { ...TOKEN, expires_in: -1 },
    { ...TOKEN, expires_in: "3600" },
  ]) {
    const f = fixture([DEVICE, body]);
    const device = await requestDeviceCode(f.options);
    await assert.rejects(
      pollDeviceCode(device, f.options),
      isError("invalid_response"),
    );
  }
});

test("missing token lifetime uses the pinned provider's conservative one-hour fallback", async () => {
  const f = fixture([
    DEVICE,
    {
      access_token: TOKEN.access_token,
      refresh_token: TOKEN.refresh_token,
      extra: 1,
    },
  ]);
  const device = await requestDeviceCode(f.options);
  assert.deepEqual(await pollDeviceCode(device, f.options), {
    ...TOKEN,
    extra: 1,
  });
});

test("refresh sends a refresh grant and preserves rotated or omitted refresh tokens and metadata", async () => {
  for (const refresh_token of ["rotated-secret", undefined]) {
    const body = {
      access_token: "new-secret",
      ...(refresh_token ? { refresh_token } : {}),
      expires_in: 900,
      id_token: "id-secret",
      custom: { value: true },
    };
    const f = fixture([body]);
    assert.deepEqual(await refreshToken("previous-secret", f.options), {
      ...body,
      refresh_token: refresh_token ?? "previous-secret",
    });
    assert.equal(f.requests[0].url, "https://auth.x.ai/oauth2/token");
    assert.deepEqual(form(f.requests[0]), {
      grant_type: "refresh_token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      refresh_token: "previous-secret",
    });
  }
  await assert.rejects(
    refreshToken("", fixture([]).options),
    isError("invalid_options"),
  );
  await assert.rejects(
    refreshToken(
      "previous-secret",
      fixture([{ ...TOKEN, refresh_token: "" }]).options,
    ),
    isError("invalid_response"),
  );
});

test("server errors, invalid JSON and network errors never disclose arbitrary data", async () => {
  const fixtures: Array<[OAuthOptions, string, number | undefined]> = [
    [
      fixture([
        Response.json(
          {
            error: "invalid_grant",
            error_description: "leaked-secret",
            token: "leaked-secret",
          },
          { status: 400 },
        ),
      ]).options,
      "invalid_grant",
      400,
    ],
    [
      fixture([Response.json({ error: "leaked-secret" }, { status: 500 })])
        .options,
      "request_failed",
      500,
    ],
    [
      fixture([new Response("leaked-secret", { status: 502 })]).options,
      "invalid_response",
      502,
    ],
    [
      {
        fetch: (async () => {
          throw new Error("leaked-secret");
        }) as typeof fetch,
      },
      "network_error",
      undefined,
    ],
  ];
  for (const [options, code, status] of fixtures) {
    await assert.rejects(refreshToken("leaked-secret", options), (error) => {
      isError(code, status)(error);
      assert(!String(error).includes("leaked-secret"));
      assert(!JSON.stringify(error).includes("leaked-secret"));
      assert.equal((error as Error).cause, undefined);
      return true;
    });
  }
  assert(!new OAuthError("leaked-secret").message.includes("leaked-secret"));
});

test("already cancelled operations send no requests", async () => {
  const controller = new AbortController();
  controller.abort("leaked-secret");
  const f = fixture([]);
  f.options.signal = controller.signal;
  await assert.rejects(requestDeviceCode(f.options), isError("cancelled"));
  await assert.rejects(
    refreshToken("refresh", f.options),
    isError("cancelled"),
  );
  await assert.rejects(
    pollDeviceCode({ ...DEVICE, expires_at: 601000 }, f.options),
    isError("cancelled"),
  );
  assert.deepEqual(f.requests, []);
});

test("cancellation interrupts even a fetch which ignores the signal", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const result = requestDeviceCode({
    signal: controller.signal,
    fetch: (async (_, init) => {
      signal = init!.signal as AbortSignal;
      controller.abort("leaked-secret");
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  await assert.rejects(result, isError("cancelled"));
  assert(signal?.aborted);
});

test("cancellation interrupts injected and native polling waits", async () => {
  for (const injected of [false, true]) {
    const controller = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    const options: OAuthOptions = {
      signal: controller.signal,
      fetch: (async () => {
        assert.fail("Must not poll during cancellation");
      }) as typeof fetch,
      ...(injected
        ? {
            sleep: async (_: number, signal?: AbortSignal) => {
              sleepSignal = signal;
              controller.abort();
              await new Promise<void>(() => {});
            },
          }
        : {}),
    };
    const result = pollDeviceCode(
      { ...DEVICE, expires_at: Date.now() + 60000 },
      options,
    );
    if (!injected) setTimeout(() => controller.abort(), 5);
    await assert.rejects(result, isError("cancelled"));
    if (injected) assert(sleepSignal?.aborted);
  }
});

test("timeout bounds both fetch and response JSON consumption", async () => {
  for (const duringJson of [false, true]) {
    let signal: AbortSignal | undefined;
    const result = refreshToken("refresh", {
      requestTimeoutMs: 10,
      fetch: (async (_, init) => {
        signal = init!.signal as AbortSignal;
        if (!duringJson) return new Promise<Response>(() => {});
        const response = Response.json(TOKEN);
        response.json = () => new Promise(() => {});
        return response;
      }) as typeof fetch,
    });
    await assert.rejects(result, isError("timeout"));
    assert(signal?.aborted);
  }
  for (const requestTimeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      refreshToken("refresh", { ...fixture([]).options, requestTimeoutMs }),
      isError("invalid_options"),
    );
  }
});

test("device expiry aborts a hung poll before the longer network timeout", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    pollDeviceCode(
      { ...DEVICE, interval: 0.001, expires_at: Date.now() + 20 },
      {
        requestTimeoutMs: 500,
        sleep: async () => {},
        fetch: (async (_, init) => {
          signal = init!.signal as AbortSignal;
          return new Promise<Response>(() => {});
        }) as typeof fetch,
      },
    ),
    isError("expired_token"),
  );
  assert(signal?.aborted);
});

test("device expiry bounds an injected sleep which never resolves", async () => {
  await assert.rejects(
    pollDeviceCode(
      { ...DEVICE, expires_at: Date.now() + 10 },
      {
        sleep: () => new Promise(() => {}),
        fetch: (async () => {
          assert.fail("Must not send expired request");
        }) as typeof fetch,
      },
    ),
    isError("expired_token"),
  );
});
