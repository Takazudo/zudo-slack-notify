import {
  buildSlackMessage,
  CHANNEL_ID_PATTERN,
  SLACK_TIMESTAMP_PATTERN,
  TARGET_ALIAS_PATTERN,
  validateNotification,
  ValidationError,
} from "./notification.ts";

export { buildSlackMessage, validateNotification, ValidationError } from "./notification.ts";

/**
 * All three values are Worker secrets (`wrangler secret put`), never `[vars]`:
 * the repo is public, so channel IDs stay out of git along with the credentials.
 * If any is missing or invalid, POST /v1/notify fails closed with 503
 * `server_misconfigured` before authentication or any Slack request.
 */
export interface Env {
  /** Relay bearer key shared with local senders; 32-256 printable ASCII characters. */
  NOTIFY_API_KEY: string;
  /** Slack bot token (`xoxb-...`) with `chat:write`. Never handed to callers. */
  SLACK_BOT_TOKEN: string;
  /** JSON object: target alias -> encoded Slack C/G/D conversation ID. */
  SLACK_TARGETS: string;
}

interface Config {
  apiKey: string;
  slackToken: string;
  targets: Record<string, string>;
}

export interface HandlerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SLACK_ENDPOINT = "https://slack.com/api/chat.postMessage";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

// These are explicit Slack rejections with no successful post indicated. Do not
// classify unknown, internal_error, fatal_error, or service_unavailable as safe
// to retry: Slack documents possible partial success for internal/fatal errors.
const PERMANENT_SLACK_REJECTIONS = new Set([
  "access_denied",
  "accesslimited",
  "account_inactive",
  "app_access_restricted",
  "cannot_reply_to_message",
  "channel_not_found",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_auth",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "is_archived",
  "markdown_text_conflict",
  "message_limit_exceeded",
  "messages_tab_disabled",
  "method_deprecated",
  "missing_post_type",
  "missing_scope",
  "msg_blocks_too_long",
  "no_permission",
  "no_text",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "team_access_not_granted",
  "team_not_found",
  "token_expired",
  "token_revoked",
  "two_factor_setup_required",
]);

class BodyLimitError extends Error {}
class DeadlineError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(env: Env): Config | undefined {
  if (
    typeof env.NOTIFY_API_KEY !== "string" ||
    !/^[\x21-\x7e]{32,256}$/.test(env.NOTIFY_API_KEY) ||
    typeof env.SLACK_BOT_TOKEN !== "string" ||
    !/^xoxb-[A-Za-z0-9-]{5,495}$/.test(env.SLACK_BOT_TOKEN) ||
    typeof env.SLACK_TARGETS !== "string" ||
    env.SLACK_TARGETS.length > MAX_BODY_BYTES
  )
    return undefined;
  let targets: unknown;
  try {
    targets = JSON.parse(env.SLACK_TARGETS);
  } catch {
    return undefined;
  }
  if (!isRecord(targets)) return undefined;
  const entries = Object.entries(targets);
  if (!entries.length || entries.length > 100) return undefined;
  for (const [alias, channel] of entries) {
    if (
      alias.length > 64 ||
      !TARGET_ALIAS_PATTERN.test(alias) ||
      typeof channel !== "string" ||
      !CHANNEL_ID_PATTERN.test(channel)
    ) {
      return undefined;
    }
  }
  return {
    apiKey: env.NOTIFY_API_KEY,
    slackToken: env.SLACK_BOT_TOKEN,
    targets: targets as Record<string, string>,
  };
}

async function authenticates(header: string | null, secret: string): Promise<boolean> {
  const match = header?.match(/^Bearer ([\x21-\x7e]{1,256})$/i);
  if (!match) return false;
  // Web Crypto verifies a fixed-size HMAC instead of a JS early-exit string
  // comparison. This is a best-effort timing defense, not a whole-request timing
  // guarantee. Inputs are bounded before cryptographic work.
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(secret));
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(match[1]));
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Do not await cancellation: a hostile stream's cancel promise may not
        // settle. The limit must still produce a bounded response.
        void reader.cancel().catch(() => {});
        throw new BodyLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function json(status: number, data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function failure(
  requestId: string,
  status: number,
  code: string,
  message: string,
  delivery: "not_sent" | "unknown" = "not_sent",
  retryable = false,
  extra: { retryAfterSeconds?: number; headers?: Record<string, string> } = {},
): Response {
  return json(
    status,
    {
      ok: false,
      delivery,
      requestId,
      error: { code, message },
      retryable,
      ...(extra.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: extra.retryAfterSeconds }
        : {}),
    },
    { "X-Request-Id": requestId, ...extra.headers },
  );
}

function retryAfter(header: string | null): { header: string; seconds?: number } {
  const value = header?.trim();
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value);
    // Preserve even exceptionally large valid values; never cap them to a
    // shorter delay. Omit the numeric JSON field when it is not safely exact.
    return { header: value, ...(Number.isSafeInteger(seconds) ? { seconds } : {}) };
  }
  if (value && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date))
      return { header: value, seconds: Math.max(0, Math.ceil((date - Date.now()) / 1000)) };
  }
  return { header: "60", seconds: 60 };
}

function rateLimited(requestId: string, header: string | null): Response {
  const wait = retryAfter(header);
  return failure(
    requestId,
    429,
    "slack_rate_limited",
    "Slack rejected this request due to rate limiting. Wait at least the Retry-After interval before a deliberate retry.",
    "not_sent",
    true,
    {
      retryAfterSeconds: wait.seconds,
      headers: { "Retry-After": wait.header },
    },
  );
}

/** Injectable for meaningful offline tests; the default handler uses native fetch. */
export function createHandler(options: HandlerOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");

  return async function handle(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        return failure(
          requestId,
          405,
          "method_not_allowed",
          "Use GET for this endpoint.",
          "not_sent",
          false,
          { headers: { Allow: "GET" } },
        );
      }
      return json(200, { ok: true, service: "zudo-slack-notify" }, { "X-Request-Id": requestId });
    }
    if (pathname !== "/v1/notify")
      return failure(requestId, 404, "not_found", "Endpoint not found.");
    if (request.method !== "POST") {
      return failure(
        requestId,
        405,
        "method_not_allowed",
        "Use POST for this endpoint.",
        "not_sent",
        false,
        { headers: { Allow: "POST" } },
      );
    }
    const config = readConfig(env);
    if (!config)
      return failure(
        requestId,
        503,
        "server_misconfigured",
        "The notification service is not configured correctly.",
      );
    try {
      if (!(await authenticates(request.headers.get("Authorization"), config.apiKey))) {
        return failure(
          requestId,
          401,
          "unauthorized",
          "A valid bearer token is required.",
          "not_sent",
          false,
          { headers: { "WWW-Authenticate": "Bearer" } },
        );
      }
    } catch {
      return failure(
        requestId,
        503,
        "auth_unavailable",
        "The notification service could not verify authentication.",
      );
    }
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) {
      return failure(
        requestId,
        415,
        "unsupported_media_type",
        "Use application/json with UTF-8 encoding.",
      );
    }
    if (
      request.headers.has("Content-Encoding") &&
      request.headers.get("Content-Encoding")?.toLowerCase() !== "identity"
    ) {
      return failure(
        requestId,
        415,
        "unsupported_content_encoding",
        "Compressed request bodies are not supported.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(await readLimited(request.body, MAX_BODY_BYTES));
    } catch (error) {
      if (error instanceof BodyLimitError)
        return failure(
          requestId,
          413,
          "payload_too_large",
          "The JSON body must not exceed 16 KiB.",
        );
      return failure(requestId, 400, "invalid_json", "The body must contain valid UTF-8 JSON.");
    }
    let payload;
    let target: string;
    try {
      const notification = validateNotification(input);
      target = notification.target;
      if (!Object.hasOwn(config.targets, target)) {
        return failure(
          requestId,
          403,
          "target_not_allowed",
          "The target alias is not configured for this service.",
        );
      }
      payload = buildSlackMessage(notification, config.targets[target]);
    } catch (error) {
      if (error instanceof ValidationError)
        return failure(requestId, 400, error.code, error.message);
      return failure(
        requestId,
        500,
        "internal_error",
        "The service could not prepare the notification.",
      );
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject before aborting; fetch abort handlers cannot replace our
        // meaningful timeout classification with a generic network error.
        reject(new DeadlineError());
        controller.abort();
      }, timeoutMs);
    });
    const send = async (): Promise<Response> => {
      // Keep this a local function call. Calling options.fetchImpl(...) can
      // produce an illegal receiver in workerd when native fetch is injected.
      const upstream = await fetchImpl(SLACK_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.slackToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        // workerd supports follow/manual, but not Node's redirect: "error".
        // Never follow a redirect carrying the Slack bot Authorization header.
        redirect: "manual",
      });
      if (upstream.status === 429) {
        void upstream.body?.cancel().catch(() => {});
        return rateLimited(requestId, upstream.headers.get("Retry-After"));
      }
      if (upstream.status >= 500) {
        void upstream.body?.cancel().catch(() => {});
        return failure(
          requestId,
          502,
          "slack_delivery_unknown",
          "Slack returned a server error; delivery is unknown. Check the channel before retrying.",
          "unknown",
        );
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        void upstream.body?.cancel().catch(() => {});
        return failure(
          requestId,
          502,
          "slack_delivery_unknown",
          "Slack returned an unexpected redirect; delivery is unknown. Check the channel before retrying.",
          "unknown",
        );
      }
      let receipt: unknown;
      try {
        receipt = JSON.parse(await readLimited(upstream.body, MAX_UPSTREAM_BYTES));
      } catch {
        return failure(
          requestId,
          502,
          "slack_invalid_response",
          "Slack returned an unreadable response; delivery is unknown. Check the channel before retrying.",
          "unknown",
        );
      }
      if (isRecord(receipt) && receipt.ok === false && typeof receipt.error === "string") {
        if (receipt.error === "ratelimited" || receipt.error === "rate_limited") {
          return rateLimited(requestId, upstream.headers.get("Retry-After"));
        }
        if (PERMANENT_SLACK_REJECTIONS.has(receipt.error)) {
          return failure(
            requestId,
            502,
            "slack_rejected",
            `Slack rejected this notification (${receipt.error}). Check the Slack app configuration and request.`,
          );
        }
        return failure(
          requestId,
          502,
          "slack_delivery_unknown",
          "Slack reported an unconfirmed failure; delivery is unknown. Check the channel before retrying.",
          "unknown",
        );
      }
      if (
        !upstream.ok ||
        !isRecord(receipt) ||
        receipt.ok !== true ||
        receipt.channel !== payload.channel ||
        typeof receipt.ts !== "string" ||
        !SLACK_TIMESTAMP_PATTERN.test(receipt.ts)
      ) {
        return failure(
          requestId,
          502,
          "slack_invalid_response",
          "Slack did not return a valid delivery receipt; delivery is unknown. Check the channel before retrying.",
          "unknown",
        );
      }
      return json(
        200,
        { ok: true, delivery: "sent", requestId, target, channel: receipt.channel, ts: receipt.ts },
        { "X-Request-Id": requestId },
      );
    };
    try {
      return await Promise.race([send(), deadline]);
    } catch (error) {
      if (error instanceof DeadlineError) {
        return failure(
          requestId,
          504,
          "slack_timeout",
          "Slack did not confirm delivery before the deadline. Delivery is unknown; check the channel before retrying.",
          "unknown",
        );
      }
      return failure(
        requestId,
        502,
        "slack_network_error",
        "Slack delivery could not be confirmed after a network error. Check the channel before retrying.",
        "unknown",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export default { fetch: createHandler() };
