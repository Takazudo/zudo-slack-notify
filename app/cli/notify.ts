#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  buildSlackMessage,
  CHANNEL_ID_PATTERN,
  SLACK_TIMESTAMP_PATTERN,
  validateNotification,
} from "../src/notification.ts";
import type { Notification } from "../src/notification.ts";

const MAX_BYTES = 16 * 1024;
const HELP = `zudo-slack-notify — notify a configured Slack destination

Node.js 24+; run from app/ in this checkout, or use the script's absolute path.

  node cli/notify.ts --file examples/npm-approval.json --dry-run
  node --env-file=.env cli/notify.ts --file notification.local.json
  node cli/notify.ts --target dev --message 'Build finished.' --kind success
  node cli/notify.ts --file - < notification.local.json

Required environment for actual sends:
  ZUDO_SLACK_NOTIFY_URL      Full HTTPS URL ending in /v1/notify
  ZUDO_SLACK_NOTIFY_API_KEY  Worker API key (never the Slack bot token)

Flags:
  --file PATH|-     Complete JSON payload; cannot mix with message flags
  --target ALIAS    Configured destination alias
  --message TEXT    Notification body
  --title TEXT      Optional heading
  --kind KIND       info, success, warning, error, action_required
  --source TEXT     Project/agent label
  --thread-ts TS    Parent receipt's ts; use with the same target
  --dry-run         Validate and print request + Slack payload; no network
  --help            Show this message

No automatic retries. Exit codes: 0 sent/dry-run, 1 rejected/not sent,
2 local input/config error, 3 Slack rate limited, 4 delivery unknown.
HTTP is allowed only for localhost/127.0.0.1/[::1] local development.
`;

export function parseArgs(args: string[]): {
  help: boolean;
  dryRun: boolean;
  file?: string;
  payload: Record<string, unknown>;
} {
  const result: {
    help: boolean;
    dryRun: boolean;
    file?: string;
    payload: Record<string, unknown>;
  } = { help: false, dryRun: false, payload: {} };
  const names: Record<string, string> = {
    "--target": "target",
    "--message": "message",
    "--title": "title",
    "--kind": "kind",
    "--source": "source",
    "--thread-ts": "threadTs",
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--help") {
      result.help = true;
      continue;
    }
    if (flag === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (flag !== "--file" && !Object.hasOwn(names, flag))
      throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--file") result.file = value;
    else result.payload[names[flag]] = value;
  }
  if (result.file && Object.keys(result.payload).length)
    throw new Error("Use either --file or message flags.");
  return result;
}

export function validateEndpoint(value: string | undefined): string {
  if (!value) throw new Error("Set ZUDO_SLACK_NOTIFY_URL to the full /v1/notify endpoint.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ZUDO_SLACK_NOTIFY_URL must be an absolute URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Use HTTPS, or HTTP on loopback for local development.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1/notify")
    throw new Error(
      "ZUDO_SLACK_NOTIFY_URL must end in /v1/notify with no credentials, query, or fragment.",
    );
  return url.href;
}

type Result = { exitCode: number; body: Record<string, unknown> };
const failure = (code: string, message: string, delivery = "unknown", exitCode = 4): Result => ({
  exitCode,
  body: { ok: false, delivery, retryable: false, error: { code, message } },
});

export async function sendNotification(
  input: unknown,
  options: { endpoint: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<Result> {
  const notification = validateNotification(input);
  const endpoint = validateEndpoint(options.endpoint);
  if (!/^[\x21-\x7e]{32,256}$/.test(options.apiKey))
    throw new Error(
      "ZUDO_SLACK_NOTIFY_API_KEY must contain 32–256 printable ASCII characters without spaces.",
    );
  // Validate the exact renderer locally as well, using a placeholder channel ID.
  buildSlackMessage(notification, "C0000000000");
  const body = JSON.stringify(notification);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Notification exceeds 16 KiB.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json; charset=utf-8",
      },
      body,
      signal: controller.signal,
    });
    // Never print an HTML proxy page, credentials, or arbitrary upstream body.
    let data: any;
    try {
      data = JSON.parse(await readResponse(response));
    } catch {
      return failure(
        "unrecognized_response",
        "The API response could not be verified. Check Slack before resending.",
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      return failure(
        "unrecognized_response",
        "The API response could not be verified. Check Slack before resending.",
      );
    const requestId =
      typeof data.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.requestId,
      ) &&
      !data.requestId.includes(options.apiKey)
        ? data.requestId
        : undefined;
    if (
      response.status === 200 &&
      data.ok === true &&
      data.delivery === "sent" &&
      data.target === notification.target &&
      typeof data.channel === "string" &&
      CHANNEL_ID_PATTERN.test(data.channel) &&
      typeof data.ts === "string" &&
      SLACK_TIMESTAMP_PATTERN.test(data.ts)
    ) {
      return {
        exitCode: 0,
        body: {
          ok: true,
          delivery: "sent",
          requestId,
          target: data.target,
          channel: data.channel,
          ts: data.ts,
        },
      };
    }
    if (response.ok || data.ok !== false || !["not_sent", "unknown"].includes(data.delivery))
      return failure(
        "unrecognized_response",
        "No valid delivery receipt was returned. Check Slack before resending.",
      );
    const code =
      typeof data.error?.code === "string" &&
      /^[a-z_]{1,80}$/.test(data.error.code) &&
      !data.error.code.includes(options.apiKey)
        ? data.error.code
        : "api_error";
    const message =
      typeof data.error?.message === "string"
        ? data.error.message.split(options.apiKey).join("[redacted]").slice(0, 400)
        : "Notification API rejected the request.";
    const rateLimited =
      response.status === 429 && data.delivery === "not_sent" && data.retryable === true;
    const retryHeader = response.headers.get("retry-after")?.trim();
    const numericHeader = retryHeader && /^\d+$/.test(retryHeader) ? retryHeader : undefined;
    const dateHeader =
      retryHeader &&
      /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryHeader) &&
      Number.isFinite(Date.parse(retryHeader))
        ? retryHeader
        : undefined;
    // Preserve an oversized numeric Retry-After as text instead of silently
    // substituting a shorter 60-second wait when it exceeds safe integer range.
    const retryAfter = numericHeader ?? dateHeader;
    const headerSeconds = numericHeader
      ? Number(numericHeader)
      : dateHeader
        ? Math.max(0, Math.ceil((Date.parse(dateHeader) - Date.now()) / 1000))
        : undefined;
    const retryAfterSeconds =
      headerSeconds !== undefined
        ? Number.isSafeInteger(headerSeconds)
          ? headerSeconds
          : undefined
        : Number.isSafeInteger(data.retryAfterSeconds) && data.retryAfterSeconds >= 0
          ? data.retryAfterSeconds
          : 60;
    return {
      exitCode: rateLimited ? 3 : data.delivery === "unknown" ? 4 : 1,
      body: {
        ok: false,
        delivery: data.delivery,
        requestId,
        retryable: rateLimited,
        ...(rateLimited
          ? {
              ...(retryAfter ? { retryAfter } : {}),
              ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            }
          : {}),
        error: { code, message },
      },
    };
  } catch {
    return failure(
      controller.signal.aborted ? "client_timeout" : "client_network_error",
      "Delivery is uncertain. Check Slack before resending; no automatic retry was attempted.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("Oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function readInput(file: string): Promise<string> {
  if (file !== "-") {
    const content = await readFile(file);
    if (content.byteLength > MAX_BYTES) throw new Error("Input exceeds 16 KiB.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error("The input file must contain valid UTF-8.");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BYTES) throw new Error("Input exceeds 16 KiB.");
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("Standard input must contain valid UTF-8.");
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      process.stdout.write(HELP);
      return 0;
    }
    let input: unknown = parsed.payload;
    if (parsed.file) {
      const source = await readInput(parsed.file);
      try {
        input = JSON.parse(source);
      } catch {
        throw new Error("The input file must contain valid JSON.");
      }
    }
    const notification: Notification = validateNotification(input);
    const slackPayload = buildSlackMessage(notification, "C0000000000");
    if (Buffer.byteLength(JSON.stringify(notification)) > MAX_BYTES)
      throw new Error("Notification exceeds 16 KiB.");
    if (parsed.dryRun) {
      process.stdout.write(
        JSON.stringify({ dryRun: true, notification, slackPayload }, null, 2) + "\n",
      );
      return 0;
    }
    const result = await sendNotification(notification, {
      endpoint: process.env.ZUDO_SLACK_NOTIFY_URL ?? "",
      apiKey: process.env.ZUDO_SLACK_NOTIFY_API_KEY ?? "",
    });
    process.stdout.write(JSON.stringify(result.body, null, 2) + "\n");
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid input.";
    process.stderr.write(
      JSON.stringify({
        ok: false,
        delivery: "not_sent",
        retryable: false,
        error: { code: "local_input_error", message },
      }) + "\n",
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
