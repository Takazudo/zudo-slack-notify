import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "smoke.sh");
const servers = [];

async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(() => Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))));

function smoke(target, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, target], {
      env: {
        ...process.env,
        SMOKE_RETRY_WINDOW_SECONDS: "1",
        SMOKE_RETRY_INTERVAL_SECONDS: "1",
        SLACK_WIRED: "",
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (code) => resolve({ code, output }));
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const fail = (code) => ({ ok: false, error: { code, message: "x" } });
const worker = (notifyStatus, notifyCode) => (req, res) => {
  if (req.url === "/healthz") return json(res, 200, { ok: true, service: "zudo-slack-notify" });
  return json(res, notifyStatus, notifyStatus < 300 ? { ok: true } : fail(notifyCode));
};

describe("smoke.sh app", () => {
  it("requires APP_BASE_URL (missing or empty) before any network call", async () => {
    for (const env of [{ APP_BASE_URL: undefined }, { APP_BASE_URL: "" }]) {
      const r = await smoke("app", env);
      expect(r.code).not.toBe(0);
      expect(r.output).toContain("SMOKE FAIL: APP_BASE_URL is required (the deployed API origin)");
    }
  });

  it("passes on healthz 200 + notify 401", async () => {
    const url = await serve(worker(401, "unauthorized"));
    const r = await smoke("app", { APP_BASE_URL: url });
    expect(r.code).toBe(0);
    expect(r.output).toContain(url);
  });

  it("accepts 503 server_misconfigured only while SLACK_WIRED is not true", async () => {
    const url = await serve(worker(503, "server_misconfigured"));
    expect((await smoke("app", { APP_BASE_URL: url })).code).toBe(0);
    expect((await smoke("app", { APP_BASE_URL: url, SLACK_WIRED: "true" })).code).toBe(1);
  });

  it("fails when unauthenticated notify succeeds", async () => {
    const url = await serve(worker(200, ""));
    expect((await smoke("app", { APP_BASE_URL: url })).code).toBe(1);
  });

  it("fails on a wrong healthz body", async () => {
    const url = await serve((req, res) => json(res, 200, { ok: true, service: "other" }));
    expect((await smoke("app", { APP_BASE_URL: url })).code).toBe(1);
  });

  it("fails within the bounded window when the host never answers", async () => {
    const url = await serve((req, res) => {
      res.writeHead(502);
      res.end("bad gateway");
    });
    const r = await smoke("app", { APP_BASE_URL: url });
    expect(r.code).toBe(1);
    expect(r.output).toContain("never produced a real answer");
  });

  it("stops tolerating once the host has answered (latch)", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/healthz") return json(res, 200, { ok: true, service: "zudo-slack-notify" });
      res.writeHead(502);
      res.end("bad gateway");
    });
    const r = await smoke("app", { APP_BASE_URL: url, SMOKE_RETRY_WINDOW_SECONDS: "60" });
    expect(r.code).toBe(1);
    expect(r.output).toContain("already up");
  });
});

describe("smoke.sh doc", () => {
  it("requires DOC_BASE_URL (missing or empty) before any network call", async () => {
    for (const env of [{ DOC_BASE_URL: undefined }, { DOC_BASE_URL: "" }]) {
      const r = await smoke("doc", env);
      expect(r.code).not.toBe(0);
      expect(r.output).toContain("SMOKE FAIL: DOC_BASE_URL is required (the deployed docs origin)");
    }
  });

  const site = (root) => (req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(root);
    }
    res.writeHead(404);
    res.end("nope");
  };

  it("passes on 200 with marker and 404 elsewhere", async () => {
    const url = await serve(site("<title>zudo-slack-notify</title>"));
    expect((await smoke("doc", { DOC_BASE_URL: url })).code).toBe(0);
  });

  it("fails without the site marker", async () => {
    const url = await serve(site("<title>other</title>"));
    expect((await smoke("doc", { DOC_BASE_URL: url })).code).toBe(1);
  });

  it("fails when an unknown path is not 404", async () => {
    const url = await serve((req, res) => {
      res.writeHead(200);
      res.end("zudo-slack-notify");
    });
    expect((await smoke("doc", { DOC_BASE_URL: url })).code).toBe(1);
  });
});

describe("smoke.sh usage", () => {
  it("exits 2 without a target", async () => {
    expect((await smoke("", {})).code).toBe(2);
  });
});
