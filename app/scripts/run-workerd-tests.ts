// Runs the workerd suite in its own process group and signals that whole group on
// every exit path, so a crashed or killed vitest cannot leave orphaned workerd
// children behind. Reaps by group id, never by process name. POSIX only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GRACE_MS = 2_000;
const appDir = fileURLToPath(new URL("..", import.meta.url));
const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

const child = spawn(
  process.execPath,
  [vitestCli, "run", "--config", "vitest.workerd.config.ts", ...process.argv.slice(2)],
  { cwd: appDir, detached: true, stdio: "inherit" },
);

function signalGroup(signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false; // ESRCH: no process is left in the group.
  }
}

async function reapGroup(): Promise<void> {
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!signalGroup(0)) return;
  }
  signalGroup("SIGKILL");
}

// The detached group no longer receives terminal signals, so forward them.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    signalGroup(signal);
  });
}

child.on("error", (error) => {
  console.error(`Could not start vitest: ${error.message}`);
  process.exit(1);
});

child.on("exit", async (code) => {
  await reapGroup();
  process.exit(code ?? 1);
});
