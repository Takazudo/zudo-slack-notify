import { afterEach, describe, expect, test, vi } from "vitest";
import { createHandler, type Env } from "../src/index.ts";
import { buildSlackMessage, validateNotification, ValidationError } from "../src/notification.ts";

const API_KEY = "test-secret-do-not-use-in-production-0123456789";
const CHANNEL = "C0123456789";
const TS = "1750000000.000001";
const env: Env = {
  NOTIFY_API_KEY: API_KEY,
  SLACK_BOT_TOKEN: "xoxb-test-token-for-offline-tests",
  SLACK_TARGETS: JSON.stringify({
    releases: CHANNEL,
    private: "G0123456789",
    direct: "D0123456789",
  }),
};
const body = { target: "releases", message: "Ready for review." };

type SlackCall = { url: string; init: RequestInit | undefined; receiver: unknown };
const slackCalls: SlackCall[] = [];

afterEach(() => {
  vi.useRealTimers();
  // workerd rejects native fetch invoked with an options-object receiver, so the
  // handler must call the injected fetch as a plain function.
  for (const call of slackCalls) expect(call.receiver).toBeUndefined();
  slackCalls.length = 0;
});

function request(
  value: unknown = body,
  options: { auth?: string | null; contentType?: string; raw?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": options.contentType ?? "application/json" });
  const auth = options.auth === undefined ? `Bearer ${API_KEY}` : options.auth;
  if (auth !== null) headers.set("Authorization", auth);
  return new Request("https://notify.example/v1/notify", {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(value),
  });
}

function slackResponse(
  value: unknown = { ok: true, channel: CHANNEL, ts: TS },
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The Slack seam: an injected fetch that records every call and never touches the network. */
function harness(
  response: () => Response | Promise<Response> = () => slackResponse(),
  timeoutMs = 1000,
) {
  const calls: SlackCall[] = [];
  const handler = createHandler({
    fetchImpl: async function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
      const call = { url: String(url), init, receiver: this };
      calls.push(call);
      slackCalls.push(call);
      return response();
    } as typeof fetch,
    timeoutMs,
  });
  return { handler, calls };
}

describe("routing, configuration and authentication", () => {
  test("health is non-sensitive and requires neither configuration nor Slack", async () => {
    const { handler, calls } = harness();
    const response = await handler(new Request("https://notify.example/healthz"), {} as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "zudo-slack-notify" });
    expect(calls).toHaveLength(0);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("unknown paths and unsupported methods never call Slack", async () => {
    const { handler, calls } = harness();
    expect((await handler(new Request("https://notify.example/unknown"), env)).status).toBe(404);
    const response = await handler(new Request("https://notify.example/v1/notify"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    const health = await handler(
      new Request("https://notify.example/healthz", { method: "POST" }),
      env,
    );
    expect(health.status).toBe(405);
    expect(health.headers.get("Allow")).toBe("GET");
    expect(calls).toHaveLength(0);
  });

  test("missing, incorrect, oversized, and differently prefixed keys cannot reach Slack", async () => {
    const { handler, calls } = harness();
    for (const auth of [
      null,
      "Bearer wrong",
      `Basic ${API_KEY}`,
      `Bearer ${API_KEY.slice(0, -1)}x`,
      `Bearer ${"a".repeat(257)}`,
    ]) {
      const response = await handler(request(body, { auth }), env);
      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result.delivery).toBe("not_sent");
      expect(result.error.code).toBe("unauthorized");
      expect(result.retryable).toBe(false);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(calls).toHaveLength(0);
  });

  test("Bearer scheme is case-insensitive and correct secret authenticates", async () => {
    const { handler, calls } = harness();
    expect((await handler(request(body, { auth: `bearer ${API_KEY}` }), env)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("malformed server configuration fails closed", async () => {
    const { handler, calls } = harness();
    const cases: Env[] = [
      {} as Env,
      { ...env, NOTIFY_API_KEY: "too-short" },
      { ...env, NOTIFY_API_KEY: `${"a".repeat(32)}\n` },
      { ...env, SLACK_BOT_TOKEN: "not-a-bot-token" },
      { ...env, SLACK_TARGETS: "broken" },
      { ...env, SLACK_TARGETS: "null" },
      { ...env, SLACK_TARGETS: "[]" },
      { ...env, SLACK_TARGETS: "{}" },
      { ...env, SLACK_TARGETS: JSON.stringify({ releases: "#releases" }) },
      { ...env, SLACK_TARGETS: JSON.stringify({ releases: "U0123456789" }) },
      { ...env, SLACK_TARGETS: JSON.stringify({ "Bad-Alias": CHANNEL }) },
      { ...env, SLACK_TARGETS: `{"releases":"${CHANNEL}","__proto__":"${CHANNEL}"}` },
    ];
    for (const configuredEnv of cases) {
      const response = await handler(request(), configuredEnv);
      expect(response.status).toBe(503);
      const result = await response.json();
      expect(result.error.code).toBe("server_misconfigured");
      expect(result.delivery).toBe("not_sent");
    }
    expect(calls).toHaveLength(0);
  });

  test("configuration is checked before authentication", async () => {
    const { handler, calls } = harness();
    const response = await handler(request(body, { auth: null }), {} as Env);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("server_misconfigured");
    expect(calls).toHaveLength(0);
  });

  test("target resolution uses own configured properties and rejects raw channel passthrough", async () => {
    const { handler, calls } = harness();
    for (const target of ["unconfigured", "constructor"]) {
      const response = await handler(request({ ...body, target }), env);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("target_not_allowed");
    }
    for (const value of [
      { ...body, target: CHANNEL },
      { ...body, channel: CHANNEL },
      { ...body, target: "#releases" },
    ]) {
      expect((await handler(request(value), env)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("request body", () => {
  test("JSON media type and unsupported content encoding reject before Slack", async () => {
    const { handler, calls } = harness();
    for (const contentType of [
      "text/plain",
      "application/json; charset=latin1",
      "application/anything+json",
    ]) {
      expect((await handler(request(body, { contentType }), env)).status).toBe(415);
    }
    const compressed = request();
    compressed.headers.set("Content-Encoding", "gzip");
    expect((await handler(compressed, env)).status).toBe(415);
    expect(calls).toHaveLength(0);
    const utf8 = request(body, { contentType: "application/json; charset=utf-8" });
    expect((await handler(utf8, env)).status).toBe(200);
  });

  test("malformed JSON, scalars, unsupported properties and wrong field types are rejected", async () => {
    const { handler, calls } = harness();
    for (const raw of ["{", "null", "[]", '"hi"', "{}"]) {
      expect((await handler(request(undefined, { raw }), env)).status).toBe(400);
    }
    const cases = [
      { ...body, message: " \n " },
      { ...body, message: "a".repeat(2001) },
      { ...body, message: "contains\u0000control" },
      { ...body, title: null },
      { ...body, kind: "constructor" },
      { ...body, blocks: [] },
      { ...body, source: "a".repeat(101) },
      { ...body, fields: Array.from({ length: 7 }, () => ({ label: "x", value: "y" })) },
      { ...body, fields: [{ label: "x", value: "y", extra: true }] },
      { ...body, links: [{ label: "x", url: "https://example.com", onclick: "x" }] },
    ];
    for (const value of cases) expect((await handler(request(value), env)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("16KiB limit counts streamed UTF-8 bytes even when Content-Length lies", async () => {
    const { handler, calls } = harness();
    const oversized = new TextEncoder().encode(
      JSON.stringify({ ...body, message: "界".repeat(6000) }),
    );
    let offset = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= oversized.length) return controller.close();
        controller.enqueue(oversized.slice(offset, offset + 1024));
        offset += 1024;
      },
      cancel() {
        canceled = true;
      },
    });
    const streamed = new Request("https://notify.example/v1/notify", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": "20",
      },
    } as RequestInit);
    const response = await handler(streamed, env);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("payload_too_large");
    expect(canceled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("body at exactly 16KiB is accepted without relying on Content-Length", async () => {
    const { handler, calls } = harness();
    const raw = JSON.stringify(body).padEnd(16 * 1024, " ");
    const req = request(body, { raw });
    expect(req.headers.has("Content-Length")).toBe(false);
    expect((await handler(req, env)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("malformed UTF-8 is rejected instead of silently replacing bytes", async () => {
    const { handler, calls } = harness();
    const req = new Request("https://notify.example/v1/notify", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    const response = await handler(req, env);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(calls).toHaveLength(0);
  });
});

describe("validation and rendering", () => {
  test("mentions, markup and fields remain literal, including the accessible fallback", () => {
    const notification = validateNotification({
      ...body,
      title: "<@U0123456789> & release",
      message: "<!channel> @here <@U0123456789> <https://evil.example|click> *bold* &lt;!here&gt;",
      kind: "action_required",
      fields: [{ label: "<!here>", value: "<@U0123456789>" }],
      source: "<@U0123456789>",
      links: [
        { label: "Review <@U0123456789> & details", url: "https://example.com/review?a=1&b=2" },
      ],
    });
    const payload = buildSlackMessage(notification, CHANNEL);
    expect(payload.mrkdwn).toBe(false);
    expect(payload.parse).toBe("none");
    expect(payload.link_names).toBe(false);
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
    expect(payload.reply_broadcast).toBe(false);
    expect(payload.text).toContain("&lt;!channel&gt;");
    expect(payload.text).toContain("&amp;lt;!here&amp;gt;");
    expect(payload.text).not.toContain("<@");
    expect(payload.text).not.toContain("<!");
    expect(payload.text).toContain("Source:");
    expect(payload.text).toContain("https://example.com/review?a=1&amp;b=2");
    const textObjects = payload.blocks.flatMap((block) =>
      "text" in block ? [block.text] : "fields" in block ? block.fields : block.elements,
    );
    const markdown = textObjects.filter((text) => text.type === "mrkdwn");
    expect(markdown, "only explicit links use mrkdwn").toHaveLength(1);
    expect(markdown[0].type === "mrkdwn" && markdown[0].verbatim).toBe(true);
    expect(markdown[0].text).toBe(
      "<https://example.com/review?a=1&amp;b=2|Review &lt;@U0123456789&gt; &amp; details>",
    );
    expect("attachments" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('"type":"button"');
  });

  test("unsafe link targets and delimiters cannot enter the mrkdwn section", () => {
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "//example.com",
      "https:example.com",
      "https://user:password@example.com",
      "https://example.com/\n<!channel>",
      "https://example.com/|<!channel>",
      "https://example.com/>",
      "https://example.com/\\evil",
      " https://example.com",
      "https://example.com/a b",
      "https://example.com/" + "a".repeat(500),
    ]) {
      expect(
        () => validateNotification({ ...body, links: [{ label: "Review", url }] }),
        url,
      ).toThrow(ValidationError);
    }
    for (const label of ["Review|<!channel>", "Review\nAnother link"]) {
      expect(() =>
        validateNotification({ ...body, links: [{ label, url: "https://example.com" }] }),
      ).toThrow(ValidationError);
    }
    const normalized = validateNotification({
      ...body,
      links: [{ label: "Review", url: "https://example.com" }],
    });
    expect(normalized.links?.[0].url).toBe("https://example.com/");
  });

  test("final Slack limits are checked after escaping and before sending", async () => {
    const { handler, calls } = harness();
    for (const value of [
      { ...body, message: "&".repeat(1000) },
      { ...body, title: "<".repeat(120) },
    ]) {
      const response = await handler(request(value), env);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("rendered_message_too_long");
    }
    expect(calls).toHaveLength(0);
  });

  test("thread parent timestamps are strings, preserved exactly, and never broadcast", async () => {
    const { handler, calls } = harness();
    expect((await handler(request({ ...body, threadTs: TS }), env)).status).toBe(200);
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.thread_ts).toBe(TS);
    expect(sent.reply_broadcast).toBe(false);
    for (const threadTs of [1750000000, "1750000000.1", "1750000000.000001\n", "<@U0123456789>"]) {
      expect((await handler(request({ ...body, threadTs }), env)).status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("Slack delivery classification", () => {
  test("success awaits Slack acknowledgement and returns a receipt without response-body leakage", async () => {
    let resolveSlack!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSlack = resolve;
    });
    const { handler, calls } = harness(() => pending);
    let finished = false;
    const result = handler(request(), env).then((value) => {
      finished = true;
      return value;
    });
    // Let async authentication and fetch start without wall-clock sleeps.
    while (!calls.length) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    resolveSlack(
      slackResponse({ ok: true, channel: CHANNEL, ts: TS, message: { secret: "do-not-reflect" } }),
    );
    const response = await result;
    const receipt = await response.json();
    expect(response.status).toBe(200);
    expect(receipt).toEqual({
      ok: true,
      delivery: "sent",
      requestId: receipt.requestId,
      target: "releases",
      channel: CHANNEL,
      ts: TS,
    });
    expect(response.headers.get("X-Request-Id")).toBe(receipt.requestId);
    expect(receipt.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0].init?.redirect).toBe("manual");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.channel).toBe(CHANNEL);
    expect("target" in sent).toBe(false);
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
      `Bearer ${env.SLACK_BOT_TOKEN}`,
    );
  });

  test("HTTP success alone and Slack success without the correct receipt never mean sent", async () => {
    const cases = [
      { value: {}, status: 200 },
      { value: { ok: true }, status: 200 },
      { value: { ok: "true", channel: CHANNEL, ts: TS }, status: 200 },
      { value: { ok: true, channel: "C9999999999", ts: TS }, status: 200 },
      { value: { ok: true, channel: CHANNEL, ts: 1750000000.000001 }, status: 200 },
      { value: { ok: true, channel: CHANNEL, ts: "1750000000.1" }, status: 200 },
      { value: { ok: true, channel: CHANNEL, ts: TS }, status: 400 },
    ];
    for (const { value, status } of cases) {
      const { handler, calls } = harness(() => slackResponse(value, status));
      const response = await handler(request(), env);
      expect(response.status).toBe(502);
      const result = await response.json();
      expect(result.delivery).toBe("unknown");
      expect(result.retryable).toBe(false);
      expect(result.error.code).toBe("slack_invalid_response");
      expect(calls).toHaveLength(1);
    }
  });

  test("known Slack rejections are not_sent and require correction before another attempt", async () => {
    for (const error of [
      "not_in_channel",
      "invalid_auth",
      "channel_not_found",
      "is_archived",
      "missing_scope",
      "cannot_reply_to_message",
    ]) {
      const { handler, calls } = harness(() => slackResponse({ ok: false, error }));
      const response = await handler(request(), env);
      expect(response.status).toBe(502);
      const result = await response.json();
      expect(result.delivery).toBe("not_sent");
      expect(result.retryable).toBe(false);
      expect(result.error.code).toBe("slack_rejected");
      expect(result.error.message).toMatch(new RegExp(error));
      expect(calls).toHaveLength(1);
    }
  });

  test("HTTP 429 preserves long Retry-After instead of shortening it", async () => {
    for (const retry of ["0", "3600", "86400", "9999999999999999999999999"]) {
      const { handler, calls } = harness(() =>
        slackResponse({ ok: false }, 429, { "Retry-After": retry }),
      );
      const response = await handler(request(), env);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(retry);
      const result = await response.json();
      expect(result.error.code).toBe("slack_rate_limited");
      expect(result.delivery).toBe("not_sent");
      expect(result.retryable).toBe(true);
      if (Number.isSafeInteger(Number(retry))) expect(result.retryAfterSeconds).toBe(Number(retry));
      else expect("retryAfterSeconds" in result).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  test("valid HTTP-date Retry-After is preserved, missing/invalid values use 60 seconds", async () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const { handler } = harness(() => slackResponse({ ok: false }, 429, { "Retry-After": future }));
    const response = await handler(request(), env);
    expect(response.headers.get("Retry-After")).toBe(future);
    expect((await response.json()).retryAfterSeconds).toBeGreaterThanOrEqual(86_399);
    for (const value of [undefined, "soon", "-5", "1.5"]) {
      const testHarness = harness(() =>
        slackResponse({ ok: false }, 429, value ? { "Retry-After": value } : {}),
      );
      const result = await testHarness.handler(request(), env);
      expect(result.headers.get("Retry-After")).toBe("60");
      expect((await result.json()).retryAfterSeconds).toBe(60);
    }
  });

  test("Slack's JSON ratelimited variants get the same explicit rejection contract", async () => {
    for (const error of ["rate_limited", "ratelimited"]) {
      const { handler } = harness(() =>
        slackResponse({ ok: false, error }, 200, { "Retry-After": "120" }),
      );
      const response = await handler(request(), env);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("120");
      expect((await response.json()).delivery).toBe("not_sent");
    }
  });

  test("ambiguous Slack failures and 5xx cannot trigger a safe-retry claim or leak upstream data", async () => {
    for (const error of [
      "internal_error",
      "fatal_error",
      "service_unavailable",
      "unknown-secret-xoxb-something",
    ]) {
      const { handler, calls } = harness(() => slackResponse({ ok: false, error }));
      const response = await handler(request(), env);
      expect(response.status).toBe(502);
      const result = await response.json();
      expect(result.delivery).toBe("unknown");
      expect(result.retryable).toBe(false);
      expect(JSON.stringify(result)).not.toContain(error);
      expect(calls).toHaveLength(1);
    }
    const { handler } = harness(() => slackResponse({ ok: false, error: "not_in_channel" }, 503));
    const response = await handler(request(), env);
    expect(response.status).toBe(502);
    expect(
      (await response.json()).delivery,
      "5xx overrides apparently permanent errors in its body",
    ).toBe("unknown");
  });

  test("network failures return delivery unknown and do not leak exception text or retry", async () => {
    const { handler, calls } = harness(() => {
      throw new Error(`network ${env.SLACK_BOT_TOKEN}`);
    });
    const response = await handler(request(), env);
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.delivery).toBe("unknown");
    expect(result.error.code).toBe("slack_network_error");
    expect(result.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain(env.SLACK_BOT_TOKEN);
    expect(calls).toHaveLength(1);
  });

  test("Slack redirects are not followed and cannot move the bot token to another endpoint", async () => {
    const { handler, calls } = harness(() =>
      slackResponse({ ok: false, error: "not_in_channel" }, 302, {
        Location: "https://another.example/collect",
      }),
    );
    const response = await handler(request(), env);
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.delivery).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  test("deadline aborts the upstream attempt and reports unknown without retrying", async () => {
    const { handler, calls } = harness(() => new Promise<Response>(() => {}), 15);
    const response = await handler(request(), env);
    expect(response.status).toBe(504);
    const result = await response.json();
    expect(result.error.code).toBe("slack_timeout");
    expect(result.delivery).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.signal?.aborted).toBe(true);
  });

  test("deadline includes receipt body reading rather than only arrival of response headers", async () => {
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
    const { handler } = harness(() => new Response(stalledBody, { status: 200 }), 15);
    const response = await handler(request(), env);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("slack_timeout");
  });

  test("non-JSON or oversized Slack responses mean unknown delivery", async () => {
    for (const responseBody of [
      "<html>upstream-error-with-a-secret</html>",
      "x".repeat(129 * 1024),
    ]) {
      const { handler } = harness(() => new Response(responseBody));
      const response = await handler(request(), env);
      const result = await response.json();
      expect(response.status).toBe(502);
      expect(result.error.code).toBe("slack_invalid_response");
      expect(result.delivery).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("upstream-error-with-a-secret");
    }
  });

  test("the default Slack deadline is 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let called = false;
    const handler = createHandler({
      fetchImpl: (async () => {
        called = true;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
    let settled = false;
    const pending = handler(request(), env).then((response) => {
      settled = true;
      return response;
    });
    while (!called) await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("slack_timeout");
  });

  test("non-positive or non-finite deadlines are rejected at construction", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createHandler({ timeoutMs })).toThrow("timeoutMs must be positive.");
    }
  });
});
