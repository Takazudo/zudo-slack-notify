// Inert fakes shared by the workerd suite's config (Node) and its tests (workerd).
// None of these is a real credential or Slack channel.
export const API_KEY = "0123456789abcdef".repeat(4);
export const BOT_TOKEN = "xoxb-local-workerd-test-only";
export const CHANNEL = "C0123456789";
export const SLACK_TARGETS = JSON.stringify({ dev: CHANNEL, releases: CHANNEL });
export const TS = "1700000000.000001";

export const SLACK_ENDPOINT = "https://slack.com/api/chat.postMessage";
// Control channel for the outbound mock; `.invalid` can never resolve on a real network.
export const CONTROL_ORIGIN = "http://outbound-mock.invalid";
export const REDIRECT_LOCATION = "https://unexpected.invalid/never-follow-this";

export type Scenario = "success" | "rate_limit" | "redirect";

export interface SlackCall {
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

export interface OutboundLog {
  slack: SlackCall[];
  unexpected: string[];
}
