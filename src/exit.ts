import { readFileSync } from "node:fs";

/** Clean-up that must also run when the command is interrupted (Ctrl-C, kill): stopping a server, removing a lock. */
const pending = new Set<() => void>();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const fn of pending) fn();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });

/** Registers a clean-up; call the returned function to run it now (once) and forget it. */
export function atExit(fn: () => void): () => void {
  pending.add(fn);
  return () => {
    if (pending.delete(fn)) fn();
  };
}

/** A running process, named so that a later process with a recycled pid is not mistaken for it. */
export interface ProcessId {
  pid: number;
  /** When it started, as `ps` prints it. */
  started: string;
}

/** Start time of a running process as `ps` prints it, or null when there is no such process. */
function startOf(pid: number): string | null {
  const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]).stdout.toString().trim();
  return out || null;
}

export const identify = (pid: number): ProcessId => ({ pid, started: startOf(pid) ?? "" });

/** Whether that very process is still running. */
const stillRunning = (id: ProcessId | null | undefined) => !!id && !!id.started && startOf(id.pid) === id.started;

/** Whether that very process is still running, from a record file holding a ProcessId (false when unreadable). */
export function recordAlive(file: string): boolean {
  try {
    return stillRunning(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}
