/** Shared, dependency-free validation and Slack rendering. Safe to import in the CLI. */
export type NotificationKind = "info" | "success" | "warning" | "error" | "action_required";

export interface Notification {
  target: string;
  message: string;
  title?: string;
  kind: NotificationKind;
  source?: string;
  fields?: Array<{ label: string; value: string }>;
  links?: Array<{ label: string; url: string }>;
  threadTs?: string;
}

type PlainText = { type: "plain_text"; text: string; emoji: false };
type MarkdownText = { type: "mrkdwn"; text: string; verbatim: true };
export type SlackBlock =
  | { type: "header"; text: PlainText }
  | { type: "section"; text: PlainText | MarkdownText }
  | { type: "section"; fields: PlainText[] }
  | { type: "context"; elements: PlainText[] };

export interface SlackMessagePayload {
  channel: string;
  text: string;
  blocks: SlackBlock[];
  mrkdwn: false;
  parse: "none";
  link_names: false;
  unfurl_links: false;
  unfurl_media: false;
  reply_broadcast: false;
  thread_ts?: string;
}

export class ValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_request") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export const TARGET_ALIAS_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{8,63}$/;
export const SLACK_TIMESTAMP_PATTERN = /^\d{10,16}\.\d{6}$/;

const KINDS: Readonly<Record<NotificationKind, string>> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  error: "Error",
  action_required: "Action required",
};
const NOTIFICATION_KEYS = new Set([
  "target", "message", "title", "kind", "source", "fields", "links", "threadTs",
]);
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${description} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, description: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ValidationError(`${description} contains an unsupported field.`);
  }
}

function requiredText(value: unknown, max: number, description: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || FORBIDDEN_CONTROLS.test(value)) {
    throw new ValidationError(`${description} must be nonblank text of at most ${max} characters, without control characters.`);
  }
  return value;
}

function optionalText(input: Record<string, unknown>, key: string, max: number): string | undefined {
  return Object.hasOwn(input, key) ? requiredText(input[key], max, key) : undefined;
}

function safeLinkUrl(value: unknown): string {
  const raw = requiredText(value, 500, "links[].url");
  // Slack uses <url|label>. Do not let an input escape that syntax; do not
  // accept URL-parser repair of whitespace, backslashes, or bare https: paths.
  if (!/^https:\/\//i.test(raw) || /[\s<>|\\]/u.test(raw)) {
    throw new ValidationError("links[].url must be an absolute HTTPS URL without whitespace or Slack link delimiters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError("links[].url must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.href.length > 500) {
    throw new ValidationError("links[].url must be an absolute HTTPS URL of at most 500 characters, without credentials.");
  }
  return parsed.href;
}

/** Validate strict JSON and return a normalized copy. No Slack access occurs. */
export function validateNotification(value: unknown): Notification {
  const input = record(value, "Notification");
  onlyKeys(input, NOTIFICATION_KEYS, "Notification");
  const target = requiredText(input.target, 64, "target");
  if (!TARGET_ALIAS_PATTERN.test(target)) {
    throw new ValidationError("target must be a lowercase kebab-case alias.");
  }
  const notification: Notification = {
    target,
    message: requiredText(input.message, 2000, "message"),
    kind: "info",
  };
  if (Object.hasOwn(input, "kind")) {
    if (typeof input.kind !== "string" || !Object.hasOwn(KINDS, input.kind)) {
      throw new ValidationError("kind must be info, success, warning, error, or action_required.");
    }
    notification.kind = input.kind as NotificationKind;
  }
  const title = optionalText(input, "title", 120);
  const source = optionalText(input, "source", 100);
  if (title !== undefined) notification.title = title;
  if (source !== undefined) notification.source = source;

  if (Object.hasOwn(input, "fields")) {
    if (!Array.isArray(input.fields) || input.fields.length > 6) {
      throw new ValidationError("fields must be an array of at most 6 objects.");
    }
    notification.fields = input.fields.map((value) => {
      const field = record(value, "Each field");
      onlyKeys(field, new Set(["label", "value"]), "Each field");
      return {
        label: requiredText(field.label, 60, "fields[].label"),
        value: requiredText(field.value, 300, "fields[].value"),
      };
    });
  }
  if (Object.hasOwn(input, "links")) {
    if (!Array.isArray(input.links) || input.links.length > 3) {
      throw new ValidationError("links must be an array of at most 3 objects.");
    }
    notification.links = input.links.map((value) => {
      const link = record(value, "Each link");
      onlyKeys(link, new Set(["label", "url"]), "Each link");
      const label = requiredText(link.label, 60, "links[].label");
      if (/[|\r\n]/.test(label)) {
        throw new ValidationError("links[].label must not contain a pipe or newline.");
      }
      return { label, url: safeLinkUrl(link.url) };
    });
  }
  if (Object.hasOwn(input, "threadTs")) {
    if (typeof input.threadTs !== "string" || !SLACK_TIMESTAMP_PATTERN.test(input.threadTs)) {
      throw new ValidationError("threadTs must be a parent Slack timestamp string, for example 1750000000.000001.");
    }
    notification.threadTs = input.threadTs;
  }
  return notification;
}

/** Slack recognizes these three HTML entities; encode ampersands first. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderedLimit(text: string, max: number, description: string): string {
  if (text.length > max) {
    throw new ValidationError(
      `${description} exceeds Slack's ${max}-character limit after escaping; shorten this text.`,
      "rendered_message_too_long",
    );
  }
  return text;
}

function plain(text: string, max: number, description: string): PlainText {
  return { type: "plain_text", text: renderedLimit(escapeSlackText(text), max, description), emoji: false };
}

/**
 * The channel comes exclusively from server configuration. Validate input again
 * here so a CLI caller cannot accidentally bypass validation during a dry run.
 */
export function buildSlackMessage(input: Notification, channel: string): SlackMessagePayload {
  const notification = validateNotification(input);
  if (!CHANNEL_ID_PATTERN.test(channel)) {
    throw new ValidationError("The resolved Slack channel must be an encoded C, G, or D conversation ID.");
  }
  const heading = notification.title
    ? `${KINDS[notification.kind]}: ${notification.title}`
    : KINDS[notification.kind];
  const blocks: SlackBlock[] = [
    { type: "header", text: plain(heading, 150, "title") },
    { type: "section", text: plain(notification.message, 3000, "message") },
  ];
  const fallback = [heading, notification.message];
  if (notification.fields?.length) {
    blocks.push({
      type: "section",
      fields: notification.fields.map((field) => plain(`${field.label}\n${field.value}`, 2000, "field")),
    });
    fallback.push(...notification.fields.map((field) => `${field.label}: ${field.value}`));
  }
  if (notification.links?.length) {
    // Only explicitly validated links use mrkdwn. verbatim disables automatic
    // parsing, and escaped labels cannot introduce <@users> or <!channel>.
    const text = notification.links
      .map((link) => `<${escapeSlackText(link.url)}|${escapeSlackText(link.label)}>`)
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: renderedLimit(text, 3000, "links"), verbatim: true } });
    fallback.push(...notification.links.map((link) => `${link.label}: ${link.url}`));
  }
  if (notification.source) {
    blocks.push({ type: "context", elements: [plain(`Source: ${notification.source}`, 2000, "source")] });
    fallback.push(`Source: ${notification.source}`);
  }
  if (blocks.length > 50) {
    throw new ValidationError("The message contains too many Slack blocks.", "rendered_message_too_long");
  }
  const payload: SlackMessagePayload = {
    channel,
    text: renderedLimit(escapeSlackText(fallback.join("\n")), 40000, "fallback text"),
    blocks,
    mrkdwn: false,
    parse: "none",
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
    reply_broadcast: false,
  };
  if (notification.threadTs) payload.thread_ts = notification.threadTs;
  return payload;
}
