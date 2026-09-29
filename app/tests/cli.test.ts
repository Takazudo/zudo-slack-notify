import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main, parseArgs, sendNotification, validateEndpoint } from "../cli/notify.ts";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const payload = { target: "dev", message: "Ready for review." };
const apiKey = "a".repeat(64);
const endpoint = "https://notify.example.com/v1/notify";
const opts = (fetchImpl: typeof fetch) => ({ endpoint, apiKey, fetchImpl });
const receipt = {
  ok: true,
  delivery: "sent",
  requestId: "request-1",
  target: "dev",
  channel: "C0123456789",
  ts: "1700000000.000001",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ZUDO_SLACK_NOTIFY_URL;
  delete env.ZUDO_SLACK_NOTIFY_API_KEY;
  return env;
}

describe("argument and endpoint validation", () => {
  test("CLI flags reject ambiguity and accidental unsupported options", () => {
    expect(parseArgs(["--target", "dev", "--message", "Ready", "--dry-run"]).payload).toEqual({
      target: "dev",
      message: "Ready",
    });
    expect(() => parseArgs(["--file", "input.json", "--target", "dev"])).toThrow();
    expect(() => parseArgs(["--target", "dev", "--target", "releases"])).toThrow();
    expect(() => parseArgs(["--api-key", "secret"])).toThrow();
    expect(() => parseArgs(["--message"])).toThrow();
  });

  test("sender endpoint allows HTTPS or exact loopback, with no credential/query redirects", () => {
    expect(validateEndpoint(endpoint)).toBe(endpoint);
    expect(validateEndpoint("http://127.0.0.1:8787/v1/notify")).toBe(
      "http://127.0.0.1:8787/v1/notify",
    );
    for (const url of [
      "http://example.com/v1/notify",
      "https://user:pass@example.com/v1/notify",
      "https://example.com/v1/notify?key=secret",
      "https://example.com/v1/notify#fragment",
      "http://127.0.0.1.example.com/v1/notify",
      "https://example.com/other",
    ]) {
      expect(() => validateEndpoint(url), url).toThrow();
    }
  });

  test("a missing endpoint names the ZUDO_SLACK_NOTIFY_URL variable", () => {
    expect(() => validateEndpoint(undefined)).toThrow("ZUDO_SLACK_NOTIFY_URL");
  });
});

describe("sendNotification", () => {
  test("sender checks receipt and sends only one authenticated POST with redirect error", async () => {
    let calls = 0;
    const result = await sendNotification(
      payload,
      opts(async (url, init) => {
        calls++;
        expect(url).toBe(endpoint);
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
        expect(JSON.parse(String(init?.body)).target).toBe("dev");
        return Response.json(receipt);
      }),
    );
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.body.delivery).toBe("sent");
  });

  test("200 without a valid destination receipt is unknown, never success", async () => {
    for (const body of [
      { ok: true },
      { ...receipt, target: "elsewhere" },
      { ...receipt, ts: "invalid" },
      { ...receipt, channel: ["C0123456789"], ts: ["1700000000.000001"] },
    ]) {
      const result = await sendNotification(
        payload,
        opts(async () => Response.json(body)),
      );
      expect(result.exitCode).toBe(4);
      expect(result.body.delivery).toBe("unknown");
    }
  });

  test("API key is redacted before shortening error messages or copying identifiers", async () => {
    const result = await sendNotification(
      payload,
      opts(async () =>
        Response.json(
          {
            ok: false,
            delivery: "not_sent",
            retryable: false,
            requestId: apiKey,
            error: { code: apiKey, message: "x".repeat(380) + apiKey },
          },
          { status: 502 },
        ),
      ),
    );
    expect(JSON.stringify(result)).not.toContain("a".repeat(20));
    expect((result.body.error as { message: string }).message).toMatch(/\[redacted\]/);
  });

  test("429 exposes full wait and performs no retry", async () => {
    let calls = 0;
    const result = await sendNotification(
      payload,
      opts(async () => {
        calls++;
        return Response.json(
          {
            ok: false,
            delivery: "not_sent",
            retryable: true,
            retryAfterSeconds: 120,
            error: { code: "slack_rate_limited", message: "Wait before retrying." },
          },
          { status: 429 },
        );
      }),
    );
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(3);
    expect(result.body.retryAfterSeconds).toBe(120);
  });

  test("network uncertainty and unrecognized proxy content never become retryable", async () => {
    const results = [
      await sendNotification(
        payload,
        opts(async () => {
          throw new Error("connection lost");
        }),
      ),
      await sendNotification(
        payload,
        opts(async () => new Response("<html>private diagnostic page</html>", { status: 502 })),
      ),
      await sendNotification(
        payload,
        opts(async () => new Response("x".repeat(17000), { status: 502 })),
      ),
    ];
    for (const result of results) {
      expect(result.exitCode).toBe(4);
      expect(result.body.retryable).toBe(false);
      expect(result.body.delivery).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("private diagnostic");
    }
  });

  test("large Retry-After values remain available without inventing a shorter delay", async () => {
    const value = "999999999999999999999999";
    const result = await sendNotification(
      payload,
      opts(async () =>
        Response.json(
          {
            ok: false,
            delivery: "not_sent",
            retryable: true,
            error: { code: "slack_rate_limited", message: "Wait before retrying." },
          },
          { status: 429, headers: { "retry-after": value } },
        ),
      ),
    );
    expect(result.exitCode).toBe(3);
    expect(result.body.retryAfter).toBe(value);
    expect(Object.hasOwn(result.body, "retryAfterSeconds")).toBe(false);
  });

  test("timeout ends request without a second attempt", async () => {
    let calls = 0;
    const result = await sendNotification(payload, {
      endpoint,
      apiKey,
      timeoutMs: 10,
      fetchImpl: async (_url, init) => {
        calls++;
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(4);
    expect((result.body.error as { code: string }).code).toBe("client_timeout");
  });

  test("a timeout while the response body streams is still client_timeout", async () => {
    const result = await sendNotification(payload, {
      endpoint,
      apiKey,
      timeoutMs: 10,
      fetchImpl: async (_url, init) => {
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
              once: true,
            });
          },
        });
        return new Response(stalled, { status: 200 });
      },
    });
    expect(result.exitCode).toBe(4);
    expect((result.body.error as { code: string }).code).toBe("client_timeout");
  });
});

describe("main", () => {
  test("live send reads ZUDO_SLACK_NOTIFY_URL and ZUDO_SLACK_NOTIFY_API_KEY", async () => {
    vi.stubEnv("ZUDO_SLACK_NOTIFY_URL", endpoint);
    vi.stubEnv("ZUDO_SLACK_NOTIFY_API_KEY", apiKey);
    const fetchStub = vi.fn<typeof fetch>(async () => Response.json(receipt));
    vi.stubGlobal("fetch", fetchStub);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--target", "dev", "--message", "Ready for review."])).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(stdout.mock.calls[0][0])).delivery).toBe("sent");
  });

  test("a live send without sender configuration is a local error and never fetches", async () => {
    vi.stubEnv("ZUDO_SLACK_NOTIFY_URL", undefined);
    vi.stubEnv("ZUDO_SLACK_NOTIFY_API_KEY", undefined);
    const fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchStub);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--target", "dev", "--message", "Ready for review."])).toBe(2);
    expect(fetchStub).not.toHaveBeenCalled();
    const report = JSON.parse(String(stderr.mock.calls[0][0]));
    expect(report.delivery).toBe("not_sent");
    expect(report.error.message).toContain("ZUDO_SLACK_NOTIFY_URL");
  });

  test("dry-run executable works without secrets and invalid JSON exits 2", () => {
    const env = cliEnv();
    const dry = spawnSync(
      process.execPath,
      ["cli/notify.ts", "--file", "examples/npm-approval.json", "--dry-run"],
      { cwd: appDir, encoding: "utf8", env },
    );
    expect(dry.status, dry.stderr).toBe(0);
    const result = JSON.parse(dry.stdout);
    expect(result.dryRun).toBe(true);
    expect(result.notification.target).toBe("releases");
    expect(result.slackPayload.channel).toBe("C0000000000");
    const invalid = spawnSync(process.execPath, ["cli/notify.ts", "--file", "-"], {
      cwd: appDir,
      encoding: "utf8",
      input: "{bad",
      env,
    });
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stderr).delivery).toBe("not_sent");
    const malformedBytes = Buffer.concat([
      Buffer.from('{"target":"dev","message":"'),
      Buffer.from([255]),
      Buffer.from('"}'),
    ]);
    const invalidUtf8 = spawnSync(process.execPath, ["cli/notify.ts", "--file", "-", "--dry-run"], {
      cwd: appDir,
      encoding: "utf8",
      input: malformedBytes,
      env,
    });
    expect(invalidUtf8.status).toBe(2);
    expect(JSON.parse(invalidUtf8.stderr).error.message).toMatch(/UTF-8/);
  });

  test("runs when invoked through a symlinked checkout path", () => {
    const linkDir = mkdtempSync(join(tmpdir(), "zudo-slack-notify-cli-"));
    try {
      const linkedApp = join(linkDir, "app");
      symlinkSync(appDir, linkedApp, "dir");
      const dry = spawnSync(
        process.execPath,
        [join(linkedApp, "cli/notify.ts"), "--file", "examples/simple.json", "--dry-run"],
        { cwd: appDir, encoding: "utf8", env: cliEnv() },
      );
      expect(dry.status, dry.stderr).toBe(0);
      expect(JSON.parse(dry.stdout).dryRun).toBe(true);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  test("help names the zudo-slack-notify sender variables", () => {
    const help = spawnSync(process.execPath, ["cli/notify.ts", "--help"], {
      cwd: appDir,
      encoding: "utf8",
      env: cliEnv(),
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^zudo-slack-notify /);
    expect(help.stdout).toContain("ZUDO_SLACK_NOTIFY_URL");
    expect(help.stdout).toContain("ZUDO_SLACK_NOTIFY_API_KEY");
  });
});
