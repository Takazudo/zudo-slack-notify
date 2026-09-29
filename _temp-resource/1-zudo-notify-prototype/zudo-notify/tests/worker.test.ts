import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler, type Env } from "../src/index.ts";
import { buildSlackMessage, validateNotification, ValidationError } from "../src/notification.ts";

const API_KEY = "test-secret-do-not-use-in-production-0123456789";
const CHANNEL = "C0123456789";
const TS = "1750000000.000001";
const env: Env = {
  NOTIFY_API_KEY: API_KEY,
  SLACK_BOT_TOKEN: "xoxb-test-token-for-offline-tests",
  SLACK_TARGETS: JSON.stringify({ releases: CHANNEL, private: "G0123456789", direct: "D0123456789" }),
};
const body = { target: "releases", message: "Ready for review." };

function request(value: unknown = body, options: { auth?: string | null; contentType?: string; raw?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": options.contentType ?? "application/json" });
  const auth = options.auth === undefined ? `Bearer ${API_KEY}` : options.auth;
  if (auth !== null) headers.set("Authorization", auth);
  return new Request("https://notify.example/v1/notify", { method: "POST", headers, body: options.raw ?? JSON.stringify(value) });
}

function slackResponse(value: unknown = { ok: true, channel: CHANNEL, ts: TS }, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function harness(response: () => Response | Promise<Response> = () => slackResponse(), timeoutMs = 1000) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const handler = createHandler({
    fetchImpl: (async function (this: unknown, url, init) {
      assert.equal(this, undefined, "fetch must be invoked without an options-object receiver");
      calls.push({ url: String(url), init });
      return response();
    }) as typeof fetch,
    timeoutMs,
  });
  return { handler, calls };
}

test("health is non-sensitive and requires neither configuration nor Slack", async () => {
  const { handler, calls } = harness();
  const response = await handler(new Request("https://notify.example/healthz"), {} as Env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "zudo-notify" });
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("unknown paths and unsupported methods never call Slack", async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(new Request("https://notify.example/unknown"), env)).status, 404);
  const response = await handler(new Request("https://notify.example/v1/notify"), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.equal(calls.length, 0);
});

test("missing, incorrect, oversized, and differently prefixed keys cannot reach Slack", async () => {
  const { handler, calls } = harness();
  for (const auth of [null, "Bearer wrong", `Basic ${API_KEY}`, `Bearer ${API_KEY.slice(0, -1)}x`, `Bearer ${"a".repeat(257)}`]) {
    const response = await handler(request(body, { auth }), env);
    assert.equal(response.status, 401);
    const result = await response.json();
    assert.equal(result.delivery, "not_sent");
    assert.equal(result.error.code, "unauthorized");
    assert.equal(result.retryable, false);
    assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
  }
  assert.equal(calls.length, 0);
});

test("Bearer scheme is case-insensitive and correct secret authenticates", async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(request(body, { auth: `bearer ${API_KEY}` }), env)).status, 200);
  assert.equal(calls.length, 1);
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
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error.code, "server_misconfigured");
    assert.equal(result.delivery, "not_sent");
  }
  assert.equal(calls.length, 0);
});

test("target resolution uses own configured properties and rejects raw channel passthrough", async () => {
  const { handler, calls } = harness();
  for (const target of ["unconfigured", "constructor"]) {
    const response = await handler(request({ ...body, target }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "target_not_allowed");
  }
  for (const value of [{ ...body, target: CHANNEL }, { ...body, channel: CHANNEL }, { ...body, target: "#releases" }]) {
    assert.equal((await handler(request(value), env)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("JSON media type and unsupported content encoding reject before Slack", async () => {
  const { handler, calls } = harness();
  for (const contentType of ["text/plain", "application/json; charset=latin1", "application/anything+json"]) {
    assert.equal((await handler(request(body, { contentType }), env)).status, 415);
  }
  const compressed = request();
  compressed.headers.set("Content-Encoding", "gzip");
  assert.equal((await handler(compressed, env)).status, 415);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request(body, { contentType: "application/json; charset=utf-8" }), env)).status, 200);
});

test("malformed JSON, scalars, unsupported properties and wrong field types are rejected", async () => {
  const { handler, calls } = harness();
  for (const raw of ["{", "null", "[]", '"hi"', "{}"]) {
    assert.equal((await handler(request(undefined, { raw }), env)).status, 400);
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
  for (const value of cases) assert.equal((await handler(request(value), env)).status, 400);
  assert.equal(calls.length, 0);
});

test("16KiB limit counts streamed UTF-8 bytes even when Content-Length lies", async () => {
  const { handler, calls } = harness();
  const oversized = new TextEncoder().encode(JSON.stringify({ ...body, message: "界".repeat(6000) }));
  let offset = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= oversized.length) return controller.close();
      controller.enqueue(oversized.slice(offset, offset + 1024));
      offset += 1024;
    },
    cancel() { canceled = true; },
  });
  const streamed = new Request("https://notify.example/v1/notify", {
    method: "POST", body: stream, duplex: "half",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", "Content-Length": "20" },
  } as RequestInit);
  const response = await handler(streamed, env);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "payload_too_large");
  assert.equal(canceled, true);
  assert.equal(calls.length, 0);
});

test("body at exactly 16KiB is accepted without relying on Content-Length", async () => {
  const { handler, calls } = harness();
  const raw = JSON.stringify(body).padEnd(16 * 1024, " ");
  const req = request(body, { raw });
  assert.equal(req.headers.has("Content-Length"), false);
  assert.equal((await handler(req, env)).status, 200);
  assert.equal(calls.length, 1);
});

test("malformed UTF-8 is rejected instead of silently replacing bytes", async () => {
  const { handler, calls } = harness();
  const req = new Request("https://notify.example/v1/notify", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: new Uint8Array([0x7b, 0xff, 0x7d]),
  });
  const response = await handler(req, env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_json");
  assert.equal(calls.length, 0);
});

test("mentions, markup and fields remain literal, including the accessible fallback", () => {
  const notification = validateNotification({
    ...body,
    title: "<@U0123456789> & release",
    message: "<!channel> @here <@U0123456789> <https://evil.example|click> *bold* &lt;!here&gt;",
    kind: "action_required",
    fields: [{ label: "<!here>", value: "<@U0123456789>" }],
    source: "<@U0123456789>",
    links: [{ label: "Review <@U0123456789> & details", url: "https://example.com/review?a=1&b=2" }],
  });
  const payload = buildSlackMessage(notification, CHANNEL);
  assert.equal(payload.mrkdwn, false);
  assert.equal(payload.parse, "none");
  assert.equal(payload.link_names, false);
  assert.equal(payload.unfurl_links, false);
  assert.equal(payload.unfurl_media, false);
  assert.equal(payload.reply_broadcast, false);
  assert.ok(payload.text.includes("&lt;!channel&gt;"));
  assert.ok(payload.text.includes("&amp;lt;!here&amp;gt;"));
  assert.ok(!payload.text.includes("<@"));
  assert.ok(!payload.text.includes("<!"));
  assert.ok(payload.text.includes("Source:"));
  assert.ok(payload.text.includes("https://example.com/review?a=1&amp;b=2"));
  const textObjects = payload.blocks.flatMap((block) => "text" in block ? [block.text] : "fields" in block ? block.fields : block.elements);
  const markdown = textObjects.filter((text) => text.type === "mrkdwn");
  assert.equal(markdown.length, 1, "only explicit links use mrkdwn");
  assert.equal(markdown[0].type === "mrkdwn" && markdown[0].verbatim, true);
  assert.equal(markdown[0].text, "<https://example.com/review?a=1&amp;b=2|Review &lt;@U0123456789&gt; &amp; details>");
  assert.equal("attachments" in payload, false);
  assert.ok(!JSON.stringify(payload).includes('"type":"button"'));
});

test("unsafe link targets and delimiters cannot enter the mrkdwn section", () => {
  for (const url of [
    "http://example.com", "javascript:alert(1)", "//example.com", "https:example.com",
    "https://user:password@example.com", "https://example.com/\n<!channel>",
    "https://example.com/|<!channel>", "https://example.com/>", "https://example.com/\\evil",
    " https://example.com", "https://example.com/a b", "https://example.com/" + "a".repeat(500),
  ]) {
    assert.throws(() => validateNotification({ ...body, links: [{ label: "Review", url }] }), ValidationError, url);
  }
  for (const label of ["Review|<!channel>", "Review\nAnother link"]) {
    assert.throws(() => validateNotification({ ...body, links: [{ label, url: "https://example.com" }] }), ValidationError);
  }
  assert.equal(validateNotification({ ...body, links: [{ label: "Review", url: "https://example.com" }] }).links?.[0].url, "https://example.com/");
});

test("final Slack limits are checked after escaping and before sending", async () => {
  const { handler, calls } = harness();
  for (const value of [{ ...body, message: "&".repeat(1000) }, { ...body, title: "<".repeat(120) }]) {
    const response = await handler(request(value), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "rendered_message_too_long");
  }
  assert.equal(calls.length, 0);
});

test("success awaits Slack acknowledgement and returns a receipt without response-body leakage", async () => {
  let resolveSlack!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveSlack = resolve; });
  const { handler, calls } = harness(() => pending);
  let finished = false;
  const result = handler(request(), env).then((value) => { finished = true; return value; });
  // Let async authentication and fetch start without wall-clock sleeps.
  while (!calls.length) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  resolveSlack(slackResponse({ ok: true, channel: CHANNEL, ts: TS, message: { secret: "do-not-reflect" } }));
  const response = await result;
  const receipt = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(receipt, { ok: true, delivery: "sent", requestId: receipt.requestId, target: "releases", channel: CHANNEL, ts: TS });
  assert.equal(response.headers.get("X-Request-Id"), receipt.requestId);
  assert.match(receipt.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].init?.redirect, "manual");
  const sent = JSON.parse(calls[0].init?.body as string);
  assert.equal(sent.channel, CHANNEL);
  assert.equal("target" in sent, false);
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), `Bearer ${env.SLACK_BOT_TOKEN}`);
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
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.delivery, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(result.error.code, "slack_invalid_response");
    assert.equal(calls.length, 1);
  }
});

test("known Slack rejections are not_sent and require correction before another attempt", async () => {
  for (const error of ["not_in_channel", "invalid_auth", "channel_not_found", "is_archived", "missing_scope", "cannot_reply_to_message"]) {
    const { handler, calls } = harness(() => slackResponse({ ok: false, error }));
    const response = await handler(request(), env);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.delivery, "not_sent");
    assert.equal(result.retryable, false);
    assert.equal(result.error.code, "slack_rejected");
    assert.match(result.error.message, new RegExp(error));
    assert.equal(calls.length, 1);
  }
});

test("HTTP 429 preserves long Retry-After instead of shortening it", async () => {
  for (const retry of ["0", "3600", "86400", "9999999999999999999999999"]) {
    const { handler, calls } = harness(() => slackResponse({ ok: false }, 429, { "Retry-After": retry }));
    const response = await handler(request(), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), retry);
    const result = await response.json();
    assert.equal(result.error.code, "slack_rate_limited");
    assert.equal(result.delivery, "not_sent");
    assert.equal(result.retryable, true);
    if (Number.isSafeInteger(Number(retry))) assert.equal(result.retryAfterSeconds, Number(retry));
    else assert.equal("retryAfterSeconds" in result, false);
    assert.equal(calls.length, 1);
  }
});

test("valid HTTP-date Retry-After is preserved, missing/invalid values use 60 seconds", async () => {
  const future = new Date(Date.now() + 86_400_000).toUTCString();
  const { handler } = harness(() => slackResponse({ ok: false }, 429, { "Retry-After": future }));
  const response = await handler(request(), env);
  assert.equal(response.headers.get("Retry-After"), future);
  assert.ok((await response.json()).retryAfterSeconds >= 86_399);
  for (const value of [undefined, "soon", "-5", "1.5"]) {
    const testHarness = harness(() => slackResponse({ ok: false }, 429, value ? { "Retry-After": value } : {}));
    const result = await testHarness.handler(request(), env);
    assert.equal(result.headers.get("Retry-After"), "60");
    assert.equal((await result.json()).retryAfterSeconds, 60);
  }
});

test("Slack's JSON ratelimited variants get the same explicit rejection contract", async () => {
  for (const error of ["rate_limited", "ratelimited"]) {
    const { handler } = harness(() => slackResponse({ ok: false, error }, 200, { "Retry-After": "120" }));
    const response = await handler(request(), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "120");
    assert.equal((await response.json()).delivery, "not_sent");
  }
});

test("ambiguous Slack failures and 5xx cannot trigger a safe-retry claim or leak upstream data", async () => {
  for (const error of ["internal_error", "fatal_error", "service_unavailable", "unknown-secret-xoxb-something"]) {
    const { handler, calls } = harness(() => slackResponse({ ok: false, error }));
    const response = await handler(request(), env);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.delivery, "unknown");
    assert.equal(result.retryable, false);
    assert.ok(!JSON.stringify(result).includes(error));
    assert.equal(calls.length, 1);
  }
  const { handler } = harness(() => slackResponse({ ok: false, error: "not_in_channel" }, 503));
  const response = await handler(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).delivery, "unknown", "5xx overrides apparently permanent errors in its body");
});

test("network failures return delivery unknown and do not leak exception text or retry", async () => {
  const { handler, calls } = harness(() => { throw new Error(`network ${env.SLACK_BOT_TOKEN}`); });
  const response = await handler(request(), env);
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.delivery, "unknown");
  assert.equal(result.error.code, "slack_network_error");
  assert.equal(result.retryable, false);
  assert.ok(!JSON.stringify(result).includes(env.SLACK_BOT_TOKEN));
  assert.equal(calls.length, 1);
});

test("Slack redirects are not followed and cannot move the bot token to another endpoint", async () => {
  const { handler, calls } = harness(() => slackResponse({ ok: false, error: "not_in_channel" }, 302, {
    Location: "https://another.example/collect",
  }));
  const response = await handler(request(), env);
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.delivery, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, "manual");
});

test("deadline aborts the upstream attempt and reports unknown without retrying", async () => {
  const { handler, calls } = harness(() => new Promise<Response>(() => {}), 15);
  const response = await handler(request(), env);
  assert.equal(response.status, 504);
  const result = await response.json();
  assert.equal(result.error.code, "slack_timeout");
  assert.equal(result.delivery, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.signal?.aborted, true);
});

test("deadline includes receipt body reading rather than only arrival of response headers", async () => {
  const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
  const { handler } = harness(() => new Response(stalledBody, { status: 200 }), 15);
  const response = await handler(request(), env);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "slack_timeout");
});

test("non-JSON or oversized Slack responses mean unknown delivery", async () => {
  for (const responseBody of ["<html>upstream-error-with-a-secret</html>", "x".repeat(129 * 1024)]) {
    const { handler } = harness(() => new Response(responseBody));
    const response = await handler(request(), env);
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.equal(result.error.code, "slack_invalid_response");
    assert.equal(result.delivery, "unknown");
    assert.ok(!JSON.stringify(result).includes("upstream-error-with-a-secret"));
  }
});

test("thread parent timestamps are strings, preserved exactly, and never broadcast", async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(request({ ...body, threadTs: TS }), env)).status, 200);
  const sent = JSON.parse(calls[0].init?.body as string);
  assert.equal(sent.thread_ts, TS);
  assert.equal(sent.reply_broadcast, false);
  for (const threadTs of [1750000000, "1750000000.1", "1750000000.000001\n", "<@U0123456789>"]) {
    assert.equal((await handler(request({ ...body, threadTs }), env)).status, 400);
  }
  assert.equal(calls.length, 1);
});
