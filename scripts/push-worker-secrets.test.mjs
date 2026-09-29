import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseEnvFile } from "./push-worker-secrets.mjs";

const FAKE_KEY = "fake-relay-key-".padEnd(40, "k");
const FAKE_TOKEN = "xoxb-fake-not-a-real-token";
const FAKE_TARGETS = JSON.stringify({ alerts: "C0FAKE0001", ops: "G0FAKE0002" });
const VALUES = [FAKE_KEY, FAKE_TOKEN, "C0FAKE0001", "G0FAKE0002"];

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "push-secrets-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function envFile(lines) {
  const file = path.join(dir, "worker.env");
  await writeFile(file, lines.join("\n"));
  return file;
}

function harness({ exitCode = 0 } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const spawn = (cmd, args) => {
    const secretsFile = args[args.indexOf("bulk") + 1];
    calls.push({
      cmd,
      args,
      secretsFile,
      mode: statSync(secretsFile).mode & 0o777,
      dirMode: statSync(path.dirname(secretsFile)).mode & 0o777,
      body: JSON.parse(readFileSync(secretsFile)),
    });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", exitCode));
    return child;
  };
  return {
    out,
    err,
    calls,
    run: (argv, env = {}) =>
      main({
        argv,
        env,
        spawn,
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      }),
    all: () => [...out, ...err].join(""),
  };
}

const validLines = () => [
  `NOTIFY_API_KEY=${FAKE_KEY}`,
  `SLACK_BOT_TOKEN="${FAKE_TOKEN}"`,
  `SLACK_TARGETS='${FAKE_TARGETS}'`,
];

describe("parseEnvFile", () => {
  it("handles comments, export, and quotes", () => {
    expect(parseEnvFile("# c\nexport A=1\nB='two'\nC=\"three\"\nD=")).toEqual({
      A: "1",
      B: "two",
      C: "three",
      D: "",
    });
  });
});

describe("push-worker-secrets", () => {
  it("uploads all three keys with one wrangler bulk call and prints no values", async () => {
    const h = harness();
    const code = await h.run(["--env-file", await envFile(validLines())]);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call.args).toEqual(expect.arrayContaining(["exec", "wrangler", "secret", "bulk"]));
    expect(call.args.at(-2)).toBe("--config");
    expect(call.args.at(-1)).toBe("wrangler.toml");
    expect(call.body).toEqual({
      NOTIFY_API_KEY: FAKE_KEY,
      SLACK_BOT_TOKEN: FAKE_TOKEN,
      SLACK_TARGETS: FAKE_TARGETS,
    });
    expect(call.mode).toBe(0o600);
    expect(call.dirMode).toBe(0o700);
    expect(h.out.join("")).toContain("NOTIFY_API_KEY: set");
    for (const v of VALUES) expect(h.all()).not.toContain(v);
  });

  it("deletes the temp file after success and after wrangler failure", async () => {
    for (const exitCode of [0, 1]) {
      const h = harness({ exitCode });
      const code = await h.run(["--env-file", await envFile(validLines())]);
      expect(code).toBe(exitCode === 0 ? 0 : 1);
      expect(existsSync(h.calls[0].secretsFile)).toBe(false);
      expect(existsSync(path.dirname(h.calls[0].secretsFile))).toBe(false);
    }
  });

  it("skips empty keys, uploads the rest, and prints the delete hint", async () => {
    const h = harness();
    const file = await envFile([`NOTIFY_API_KEY=${FAKE_KEY}`, "SLACK_BOT_TOKEN=", "# no targets"]);
    expect(await h.run(["--env-file", file])).toBe(0);
    expect(h.calls[0].body).toEqual({ NOTIFY_API_KEY: FAKE_KEY });
    const out = h.out.join("");
    expect(out).toContain("SLACK_BOT_TOKEN: skipped (empty)");
    expect(out).toContain("SLACK_TARGETS: skipped (empty)");
    expect(out).toContain("pnpm exec wrangler secret delete SLACK_BOT_TOKEN");
    expect(h.all()).not.toContain(FAKE_KEY);
  });

  it("fails without upload when every key is empty", async () => {
    const h = harness();
    expect(await h.run(["--env-file", await envFile(["NOTIFY_API_KEY="])])).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  const invalidCases = [
    ["short key", "NOTIFY_API_KEY", "too-short"],
    ["key with space", "NOTIFY_API_KEY", `${FAKE_KEY} with space`],
    ["non-bot token", "SLACK_BOT_TOKEN", "xoxp-fake-user-token"],
    ["non-JSON targets", "SLACK_TARGETS", "{not json C0FAKE0001"],
    ["array targets", "SLACK_TARGETS", '["C0FAKE0001"]'],
    ["bad channel id", "SLACK_TARGETS", '{"alerts":"c0lowercase1"}'],
    ["non-string channel", "SLACK_TARGETS", '{"alerts":12345678901}'],
  ];
  it.each(invalidCases)(
    "rejects %s with no upload and no values printed",
    async (_l, name, bad) => {
      const h = harness();
      const good = Object.fromEntries(validLines().map((l) => [l.split("=")[0], l]));
      good[name] = `${name}=${bad}`;
      const code = await h.run(["--env-file", await envFile(Object.values(good))]);
      expect(code).toBe(1);
      expect(h.calls).toHaveLength(0);
      expect(h.err.join("")).toContain(`invalid ${name}`);
      for (const v of [...VALUES, bad]) expect(h.all()).not.toContain(v);
    },
  );

  it("--dry-run validates and lists without spawning", async () => {
    const h = harness();
    expect(await h.run(["--dry-run", "--env-file", await envFile(validLines())])).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.out.join("")).toContain("SLACK_TARGETS: would set");
    for (const v of VALUES) expect(h.all()).not.toContain(v);
  });

  it("reads the default path under DROPBOX_ROOT", async () => {
    const root = path.join(dir, "dropbox");
    const credDir = path.join(root, "env/zudo-slack-notify/credentials");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(credDir, { recursive: true });
    await writeFile(path.join(credDir, "worker.env"), validLines().join("\n"));
    const h = harness();
    expect(await h.run(["--dry-run"], { DROPBOX_ROOT: root })).toBe(0);
  });

  it("errors clearly without DROPBOX_ROOT or a readable file", async () => {
    const h = harness();
    expect(await h.run([])).toBe(2);
    expect(await h.run(["--env-file", path.join(dir, "missing.env")])).toBe(2);
    expect(await h.run(["--bogus"])).toBe(2);
  });
});
