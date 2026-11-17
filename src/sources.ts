import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Config } from "./config";

/** Every file matched by the config's `sources` globs. */
export function sourceFiles(cfg: Config): string[] {
  return cfg.sources.flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: cfg.root, onlyFiles: true })].map((f) => resolve(cfg.root, f)));
}

/** Every source file (and the config) with its modification time and size: what the picture was made from. */
export function snapshotSources(cfg: Config): Map<string, string> {
  const of = (file: string) => {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  };
  return new Map([cfg.file, ...sourceFiles(cfg).sort()].map((file) => [relative(cfg.root, file), of(file)]));
}

/** The first file that was added, removed or modified between two snapshots, or null when they are the same. */
export function changedSource(before: Map<string, string>, after: Map<string, string>): string | null {
  for (const [file, state] of after) if (before.get(file) !== state) return file;
  for (const file of before.keys()) if (!after.has(file)) return file;
  return null;
}

/** The newest modification time among the source files and the config. */
export const lastSourceChange = (cfg: Config) => Math.max(...[cfg.file, ...sourceFiles(cfg)].map((f) => statSync(f).mtimeMs));

/** A value that changes whenever a source file is added, removed or modified in any way. */
export const sourceStamp = (cfg: Config) => JSON.stringify([...snapshotSources(cfg)]);

/**
 * Waits until the sources have been quiet for `settleMs`, so the dev server has finished reloading the page.
 * Quiet is judged by watching them, not by their dates: a file dated in the future must not hold a command up.
 */
export async function settle(cfg: Config) {
  if (!cfg.sources.length || Date.now() - lastSourceChange(cfg) >= cfg.render.settleMs) return;
  console.error("beatclip: a source file has just changed; waiting for the page to settle");
  let seen = sourceStamp(cfg);
  for (let quietSince = Date.now(); Date.now() - quietSince < cfg.render.settleMs; ) {
    await Bun.sleep(100);
    const now = sourceStamp(cfg);
    if (now !== seen) [seen, quietSince] = [now, Date.now()];
  }
}
