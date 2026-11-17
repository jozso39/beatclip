/** Clean-up that must also run when the command is interrupted (Ctrl-C, kill): stopping a server, removing a lock. */
const pending = new Set<() => void>();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const fn of pending) fn();
    process.exit(130);
  });

/** Registers a clean-up; call the returned function to run it now (once) and forget it. */
export function atExit(fn: () => void): () => void {
  pending.add(fn);
  return () => {
    if (pending.delete(fn)) fn();
  };
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
