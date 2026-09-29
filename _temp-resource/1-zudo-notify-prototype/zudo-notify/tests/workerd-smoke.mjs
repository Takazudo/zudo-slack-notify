/**
 * Exercise the bundled production entry point in real workerd, without Slack.
 * Run `pnpm build && node tests/workerd-smoke.mjs` from the project directory.
 *
 * Miniflare 4.20260424.0 supports a function-valued outboundService. It replaces
 * the Worker's global outbound service, so every native fetch reaches the
 * callback below. There is deliberately no fetch(), proxy, or network fallback
 * in that callback. The Worker itself retains its real, receiver-sensitive
 * native fetch and runs separate request invocations in workerd.
 */
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Log, LogLevel, Miniflare, Response as MockResponse } from 'miniflare';

const projectRoot = new URL('../', import.meta.url);
const bundlePath = fileURLToPath(new URL('dist/index.js', projectRoot));
const apiKey = '0123456789abcdef'.repeat(4);
const botToken = 'xoxb-local-workerd-test-only';
const channel = 'C0123456789';
const timestamp = '1700000000.000001';
const endpoint = 'https://notify.invalid/v1/notify';
const payload = { target: 'dev', message: 'A local workerd notification test.' };

test('production bundle handles notifications in workerd with fully mocked egress', {
  timeout: 60_000,
}, async (t) => {
  await access(bundlePath).catch(() => {
    throw new Error('Missing dist/index.js. Run `pnpm build` before the workerd smoke.');
  });
  const config = await readFile(new URL('wrangler.toml', projectRoot), 'utf8');
  const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([\d-]+)"\s*$/m)?.[1];
  assert.ok(compatibilityDate, 'Smoke test must use the committed compatibility date');
  assert.doesNotMatch(config, /^compatibility_flags\s*=/m,
    'If compatibility flags are introduced, pass them to Miniflare here as well');

  let scenario = 'success';
  const calls = [];
  const mockFailures = [];
  const worker = new Miniflare({
    name: 'zudo-notify-workerd-smoke',
    modules: true,
    scriptPath: bundlePath,
    compatibilityDate,
    log: new Log(LogLevel.ERROR),
    bindings: {
      NOTIFY_API_KEY: apiKey,
      SLACK_BOT_TOKEN: botToken,
      SLACK_TARGETS: JSON.stringify({ dev: channel, releases: channel }),
    },
    outboundService: async (request) => {
      const bodyText = await request.text();
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
        bodyText,
      });

      // Always record unexpected destinations and return locally. Even if the
      // application is broken, this mock can never send a real Slack message.
      if (request.url !== 'https://slack.com/api/chat.postMessage') {
        mockFailures.push(`Unexpected outgoing URL: ${request.url}`);
        return new MockResponse('Unexpected outgoing destination', { status: 500 });
      }
      if (scenario === 'rate_limit') {
        return MockResponse.json({ ok: false, error: 'ratelimited' }, {
          status: 429,
          headers: { 'Retry-After': '37' },
        });
      }
      if (scenario === 'invalid_json') {
        return new MockResponse('<html>mock Slack gateway error</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (scenario === 'invalid_receipt') {
        return MockResponse.json({ ok: true, channel, ts: 'not-a-timestamp' });
      }
      if (scenario === 'redirect') {
        return new MockResponse(null, {
          status: 302,
          headers: { Location: 'https://unexpected.invalid/never-follow-this' },
        });
      }
      return MockResponse.json({ ok: true, channel, ts: timestamp });
    },
  });
  t.after(async () => { await worker.dispose(); });
  await worker.ready;

  async function post({ authorized = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authorized) headers.Authorization = `Bearer ${apiKey}`;
    const response = await worker.dispatchFetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  await t.test('unauthorized request cannot reach the outbound service', async () => {
    const before = calls.length;
    const result = await post({ authorized: false });
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.delivery, 'not_sent');
    assert.equal(calls.length, before);
  });

  await t.test('native fetch posts and returns a complete delivery receipt across invocations', async () => {
    scenario = 'success';
    const before = calls.length;
    // A second invocation also catches reusing request-owned I/O objects.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await post();
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.delivery, 'sent');
      assert.equal(result.body.target, 'dev');
      assert.equal(result.body.channel, channel);
      assert.equal(result.body.ts, timestamp);
      assert.equal(typeof result.body.requestId, 'string');
      assert.ok(result.body.requestId.length > 0);
    }
    assert.equal(calls.length - before, 2);
    for (const call of calls.slice(before)) {
      assert.equal(call.method, 'POST');
      assert.equal(call.authorization, `Bearer ${botToken}`);
      assert.match(call.contentType ?? '', /^application\/json/);
      const sent = JSON.parse(call.bodyText);
      assert.equal(sent.channel, channel);
      assert.ok(JSON.stringify(sent).includes(payload.message));
    }
  });

  await t.test('Slack rate limiting keeps Retry-After and does not retry', async () => {
    scenario = 'rate_limit';
    const before = calls.length;
    const result = await post();
    assert.equal(calls.length - before, 1);
    assert.equal(result.status, 429);
    assert.equal(result.headers.get('Retry-After'), '37');
    assert.equal(result.body.ok, false);
    assert.equal(result.body.delivery, 'not_sent');
    assert.equal(result.body.retryable, true);
    assert.equal(result.body.retryAfterSeconds, 37);
  });

  for (const malformed of ['invalid_json', 'invalid_receipt', 'redirect']) {
    await t.test(`${malformed} cannot become a successful or retryable delivery`, async () => {
      scenario = malformed;
      const before = calls.length;
      const result = await post();
      assert.equal(calls.length - before, 1);
      assert.equal(result.status, 502);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.delivery, 'unknown');
      assert.equal(result.body.retryable, false);
      assert.ok(!JSON.stringify(result.body).includes('mock Slack gateway error'));
    });
  }

  assert.deepEqual(mockFailures, []);
});
