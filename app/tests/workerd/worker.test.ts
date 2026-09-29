// Runs inside workerd via @cloudflare/vitest-plugin. The Worker uses its real,
// receiver-sensitive native fetch; vitest.workerd.config.ts routes every outbound
// request to a local mock, so nothing here can reach Slack or the network.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../../src/index.ts";
import {
  API_KEY,
  BOT_TOKEN,
  CHANNEL,
  CONTROL_ORIGIN,
  TS,
  type OutboundLog,
  type Scenario,
} from "../support/fakes.ts";

const ORIGIN = "https://zudo-slack-notify-app.test";
const PAYLOAD = { target: "dev", message: "A local workerd notification test." };

async function useScenario(scenario: Scenario): Promise<void> {
  const response = await fetch(`${CONTROL_ORIGIN}/reset`, { method: "POST", body: scenario });
  expect(response.status).toBe(204);
}

async function outboundLog(): Promise<OutboundLog> {
  return (await fetch(`${CONTROL_ORIGIN}/log`)).json();
}

function notifyRequest({ authorized = true } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorized) headers.set("Authorization", `Bearer ${API_KEY}`);
  return new Request(`${ORIGIN}/v1/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify(PAYLOAD),
  });
}

interface ApiBody {
  ok: boolean;
  delivery?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  error?: { code: string };
  [key: string]: unknown;
}

beforeEach(async () => {
  await useScenario("success");
});

afterEach(async () => {
  // A followed redirect or any stray destination shows up here.
  expect((await outboundLog()).unexpected).toEqual([]);
});

describe("workerd runtime", () => {
  it("GET /healthz answers without configuration or egress", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "zudo-slack-notify" });
    expect((await outboundLog()).slack).toHaveLength(0);
  });

  it("rejects a request without a bearer key before any Slack request", async () => {
    const response = await exports.default.fetch(notifyRequest({ authorized: false }));
    expect(response.status).toBe(401);
    const body = await response.json<ApiBody>();
    expect(body.ok).toBe(false);
    expect(body.delivery).toBe("not_sent");
    expect(body.error?.code).toBe("unauthorized");
    expect((await outboundLog()).slack).toHaveLength(0);
  });

  it("fails closed with 503 when the secrets are missing", async () => {
    const response = await worker.fetch(notifyRequest(), {} as Env);
    expect(response.status).toBe(503);
    const body = await response.json<ApiBody>();
    expect(body.delivery).toBe("not_sent");
    expect(body.error?.code).toBe("server_misconfigured");
    expect((await outboundLog()).slack).toHaveLength(0);
  });

  it("posts once per request with native fetch and returns the Slack receipt", async () => {
    // A second invocation also catches reuse of request-owned I/O objects.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await exports.default.fetch(notifyRequest());
      expect(response.status).toBe(200);
      const body = await response.json<ApiBody>();
      expect(body).toEqual({
        ok: true,
        delivery: "sent",
        requestId: expect.any(String),
        target: "dev",
        channel: CHANNEL,
        ts: TS,
      });
      expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
    }
    const { slack } = await outboundLog();
    expect(slack).toHaveLength(2);
    for (const call of slack) {
      expect(call.method).toBe("POST");
      expect(call.authorization).toBe(`Bearer ${BOT_TOKEN}`);
      expect(call.contentType).toMatch(/^application\/json/);
      const sent = JSON.parse(call.body);
      expect(sent.channel).toBe(CHANNEL);
      expect(sent.text).toContain(PAYLOAD.message);
    }
  });

  it("keeps Slack's Retry-After on a rate limit and does not retry", async () => {
    await useScenario("rate_limit");
    const response = await exports.default.fetch(notifyRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    const body = await response.json<ApiBody>();
    expect(body.delivery).toBe("not_sent");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(37);
    expect((await outboundLog()).slack).toHaveLength(1);
  });

  it("does not follow a Slack redirect and reports delivery unknown", async () => {
    await useScenario("redirect");
    const response = await exports.default.fetch(notifyRequest());
    expect(response.status).toBe(502);
    const body = await response.json<ApiBody>();
    expect(body.delivery).toBe("unknown");
    expect(body.retryable).toBe(false);
    expect(body.error?.code).toBe("slack_delivery_unknown");
    expect((await outboundLog()).slack).toHaveLength(1);
  });
});
