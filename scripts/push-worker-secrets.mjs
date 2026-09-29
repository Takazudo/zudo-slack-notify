#!/usr/bin/env node
// Uploads the Worker runtime secrets from the operator store with ONE
// `wrangler secret bulk` call. Never prints values; only key names and status.
//   pnpm ops:push-secrets [--env-file <path>] [--dry-run]
// Default file: $DROPBOX_ROOT/env/zudo-slack-notify/credentials/worker.env
import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSlackTargets,
  RELAY_KEY_PATTERN,
  SLACK_BOT_TOKEN_PATTERN,
} from "../app/src/notification.ts";

const KEYS = ["NOTIFY_API_KEY", "SLACK_BOT_TOKEN", "SLACK_TARGETS"];
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

// Returns an error message (never containing the value) or null when valid.
// Uses the Worker's own checks, so a value that passes here cannot leave the
// deployed Worker failing closed with 503 server_misconfigured.
export function validate(name, value) {
  if (name === "NOTIFY_API_KEY") {
    return RELAY_KEY_PATTERN.test(value)
      ? null
      : "must be 32-256 printable ASCII characters without whitespace";
  }
  if (name === "SLACK_BOT_TOKEN") {
    return SLACK_BOT_TOKEN_PATTERN.test(value)
      ? null
      : "must be a Slack bot token: xoxb- followed by 5-495 letters, digits, or dashes";
  }
  const result = parseSlackTargets(value);
  return "problem" in result ? result.problem : null;
}

function parseArgs(argv) {
  const opts = { envFile: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--env-file") {
      opts.envFile = argv[++i];
      if (!opts.envFile) throw new Error("--env-file requires a path");
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function runWrangler(spawn, file, io) {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["--dir", APP_DIR, "exec", "wrangler", "secret", "bulk", file, "--config", "wrangler.toml"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk) => io.stdout(String(chunk)));
    child.stderr?.on("data", (chunk) => io.stderr(String(chunk)));
    child.on("error", () => {
      io.stderr("failed to start wrangler\n");
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = nodeSpawn,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  const io = { stdout, stderr };
  const say = (line) => stdout(`${line}\n`);
  const err = (line) => stderr(`${line}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`error: ${e.message}`);
    return 2;
  }

  let envFile = opts.envFile;
  if (!envFile) {
    if (!env.DROPBOX_ROOT) {
      err("error: set DROPBOX_ROOT or pass --env-file <path>");
      return 2;
    }
    envFile = path.join(env.DROPBOX_ROOT, "env/zudo-slack-notify/credentials/worker.env");
  }

  let text;
  try {
    text = await readFile(envFile, "utf8");
  } catch {
    err(`error: cannot read env file ${envFile}`);
    return 2;
  }

  const parsed = parseEnvFile(text);
  const secrets = {};
  const skipped = [];
  let invalid = false;
  for (const name of KEYS) {
    const value = parsed[name] ?? "";
    if (value === "") {
      skipped.push(name);
      continue;
    }
    const problem = validate(name, value);
    if (problem) {
      err(`invalid ${name}: ${problem}`);
      invalid = true;
    } else secrets[name] = value;
  }
  if (invalid) {
    err("no secrets uploaded");
    return 1;
  }

  const names = Object.keys(secrets);
  for (const name of skipped) say(`${name}: skipped (empty)`);
  if (skipped.length > 0) {
    say("Empty values are skipped, not deleted. To revoke a deployed secret, run in app/:");
    for (const name of skipped) say(`  pnpm exec wrangler secret delete ${name}`);
  }
  if (names.length === 0) {
    err("error: no non-empty secrets to upload");
    return 1;
  }
  if (opts.dryRun) {
    for (const name of names) say(`${name}: would set (dry run)`);
    return 0;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "zudo-slack-notify-secrets-"));
  await chmod(dir, 0o700);
  const file = path.join(dir, "secrets.json");
  try {
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    await chmod(file, 0o600);
    const code = await runWrangler(spawn, file, io);
    if (code !== 0) {
      err(`error: wrangler secret bulk exited with ${code}`);
      return 1;
    }
    for (const name of names) say(`${name}: set`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  // Node realpaths import.meta.url but not argv[1]; compare real paths so a run
  // through a symlinked checkout does not silently do nothing.
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();
