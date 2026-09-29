import {
  CHANNEL,
  CONTROL_ORIGIN,
  REDIRECT_LOCATION,
  SLACK_ENDPOINT,
  TS,
  type OutboundLog,
  type Scenario,
} from "./fakes.ts";

const SCENARIOS = new Set<string>(["success", "rate_limit", "redirect"]);

/**
 * Miniflare `outboundService` for the workerd suite. It runs in the Node vitest
 * process and receives every fetch the workerd isolate makes, so there is no
 * path to the real network: Slack is answered from the active scenario, the
 * control origin lets tests pick a scenario and read the call log, and any
 * other destination is recorded as unexpected and answered locally.
 */
export function createOutboundMock(): (request: Request) => Promise<Response> {
  let scenario: Scenario = "success";
  let log: OutboundLog = { slack: [], unexpected: [] };

  return async function outbound(request) {
    const url = new URL(request.url);
    if (url.origin === CONTROL_ORIGIN) {
      if (request.method === "POST" && url.pathname === "/reset") {
        const next = await request.text();
        if (!SCENARIOS.has(next)) return new Response(`Unknown scenario: ${next}`, { status: 400 });
        scenario = next as Scenario;
        log = { slack: [], unexpected: [] };
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/log") return Response.json(log);
      return new Response("Unknown control request", { status: 404 });
    }

    if (request.url !== SLACK_ENDPOINT) {
      log.unexpected.push(`${request.method} ${request.url}`);
      return new Response("Unexpected outbound destination", { status: 500 });
    }
    log.slack.push({
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    if (scenario === "rate_limit") {
      return Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "37" } },
      );
    }
    if (scenario === "redirect") {
      return new Response(null, { status: 302, headers: { Location: REDIRECT_LOCATION } });
    }
    return Response.json({ ok: true, channel: CHANNEL, ts: TS });
  };
}
