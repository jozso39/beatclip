import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { readHook, withSession } from "./browser";
import type { Config, Cue, ShotDef } from "./config";
import { CliError, round3 } from "./time";

export interface Word {
  /** "<line id>.<index>", index from 0. */
  key: string;
  line: string;
  index: number;
  w: string;
  s: number;
  e: number;
}
export interface Line {
  id: string;
  /** "shout" for a line read from the lyrics file's `shouts` (chanted letters). */
  kind: "line" | "shout";
  text: string;
  s: number;
  e: number;
  words: Word[];
}
export interface Shot {
  id: string;
  s: number;
  e: number;
  /** Source file relative to the project root, with the line when it was found by search. */
  file?: string;
}

/** A beat grid: beats are numbered from 0 and may be fractional (1.5 = the half beat after beat 1). */
export interface Grid {
  /** Fractional beat number at time t. */
  pos(t: number): number;
  /** Time of (fractional) beat n. */
  time(n: number): number;
  perBar?: number;
}

export const constantGrid = (first: number, interval: number): Grid => ({
  pos: (t) => (t - first) / interval,
  time: (n) => first + n * interval,
});

/** A grid from measured beat times; between beats it interpolates, outside it continues the nearest interval. */
export function listGrid(times: number[]): Grid {
  if (times.length < 2) throw new CliError("a beats file needs at least two beat times");
  const last = times.length - 2;
  const seg = (i: number) => times[i + 1] - times[i];
  return {
    pos(t) {
      let lo = 0, hi = last;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo + (t - times[lo]) / seg(lo);
    },
    time(n) {
      const i = Math.min(last, Math.max(0, Math.floor(n)));
      return times[i] + (n - i) * seg(i);
    },
  };
}

export function loadGrid(cfg: Config): Grid {
  const b = cfg.beats;
  if (!("file" in b)) return { ...constantGrid(b.first, b.interval), perBar: b.perBar };
  if (!existsSync(b.file)) throw new CliError(`no beats file at ${b.file} (write one with: beatclip analyze beats <audio>)`);
  const raw = JSON.parse(readFileSync(b.file, "utf8"));
  const times = Array.isArray(raw) ? raw : raw.beats;
  if (!Array.isArray(times) || times.some((t) => typeof t !== "number")) throw new CliError(`${b.file} must be a list of beat times in seconds, or { "beats": [...] }`);
  return { ...listGrid(times), perBar: b.perBar };
}

/** Lyrics file: `lines` of words {w,s,e}; optional `shouts` of letters {c,s,e} are read as lines of one-letter words. */
export function loadLines(file: string | undefined): Line[] {
  if (!file) return [];
  if (!existsSync(file)) throw new CliError(`no lyrics file at ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const line = (kind: Line["kind"], l: any, parts: any[], text: (p: any) => string): Line => ({
    id: l.id,
    kind,
    text: l.text ?? parts.map(text).join(" "),
    s: l.s ?? parts[0]?.s,
    e: l.e ?? parts.at(-1)?.e,
    words: parts.map((p, index) => ({ key: `${l.id}.${index}`, line: l.id, index, w: text(p), s: p.s, e: p.e })),
  });
  const lines = [
    ...(raw.lines ?? []).map((l: any) => line("line", l, l.words ?? [], (p) => p.w)),
    ...(raw.shouts ?? []).map((l: any) => line("shout", l, l.letters ?? [], (p) => p.c)),
  ];
  return lines.sort((a, b) => a.s - b.s);
}

const SOURCE_TEXT = /\.(ts|tsx|js|jsx|mjs|json|html|vue|svelte)$/;

/** Every file matched by the config's `sources` globs. */
export function sourceFiles(cfg: Config): string[] {
  return cfg.sources.flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: cfg.root, onlyFiles: true })].map((f) => resolve(cfg.root, f)));
}

/** The most recently changed source file (the config itself counts). */
export function newestSource(cfg: Config): { mtime: number; file: string } {
  let best = { mtime: statSync(cfg.file).mtimeMs, file: cfg.file };
  for (const file of sourceFiles(cfg)) {
    const mtime = statSync(file).mtimeMs;
    if (mtime > best.mtime) best = { mtime, file };
  }
  return best;
}

interface Facts {
  duration: number;
  shots: ShotDef[];
}

/** Duration and shot list: from the config when it states them, otherwise from the page hooks (cached until a source changes). */
async function loadFacts(cfg: Config): Promise<Facts> {
  if (cfg.shots && cfg.duration !== undefined) return { shots: cfg.shots, duration: cfg.duration };
  if (!cfg.shots && !cfg.page.shots) throw new CliError(`the config needs "shots" (a list) or "page.shots" (the name of a window hook)`);
  const cacheFile = resolve(cfg.root, ".beatclip", "page.json");
  const newest = newestSource(cfg).mtime;
  if (cfg.sources.length && existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (c.url === cfg.page.url && c.stamp >= newest) return c.facts;
  }
  const facts = await withSession(cfg, async (s) => {
    const page = await s.open();
    const duration = cfg.duration ?? (await readHook<number>(page, cfg.page.duration));
    const shots = cfg.shots ?? (await readHook<ShotDef[]>(page, cfg.page.shots!));
    if (!Array.isArray(shots) || !shots.length) throw new CliError(`window.${cfg.page.shots} is not a list of shots on ${cfg.page.url}`);
    if (typeof duration !== "number") throw new CliError(`window.${cfg.page.duration} is not a number on ${cfg.page.url}`);
    return { duration, shots: shots.map(({ id, s, file }) => ({ id, s, file })) };
  });
  mkdirSync(resolve(cfg.root, ".beatclip"), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ url: cfg.page.url, stamp: Date.now(), facts }));
  return facts;
}

/** Where each `id: "<shot id>"` is written in the source files: id -> "path:line". */
function findShotSources(cfg: Config, ids: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(cfg)) {
    if (!SOURCE_TEXT.test(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      for (const m of text.matchAll(/\bid\s*[:=]\s*["'`]([\w.-]+)["'`]/g))
        if (ids.has(m[1]) && !found.has(m[1])) found.set(m[1], `${relative(cfg.root, file)}:${i + 1}`);
    });
  }
  return found;
}

export interface Project {
  cfg: Config;
  fps: number;
  duration: number;
  lines: Line[];
  words: Word[];
  shots: Shot[];
  cues: Cue[];
  grid: Grid;
}

export async function loadProject(cfg: Config): Promise<Project> {
  const facts = await loadFacts(cfg);
  const defs = [...facts.shots].sort((a, b) => a.s - b.s);
  const sources = findShotSources(cfg, new Set(defs.filter((d) => !d.file).map((d) => d.id)));
  const shots = defs.map((d, i) => ({ id: d.id, s: d.s, e: defs[i + 1]?.s ?? facts.duration, file: d.file ?? sources.get(d.id) }));
  const lines = loadLines(cfg.lyrics);
  return {
    cfg,
    fps: cfg.fps,
    duration: facts.duration,
    lines,
    words: lines.flatMap((l) => l.words).sort((a, b) => a.s - b.s),
    shots,
    cues: [...cfg.cues].sort((a, b) => a.t - b.t),
    grid: loadGrid(cfg),
  };
}

/** Number of frames in the video; frames are numbered 0 .. frameCount - 1. */
export const frameCount = (p: Project) => Math.floor(p.duration * p.fps);
/** The video frame showing time t (times outside the video give its first or last frame). */
export const frameAt = (p: Project, t: number) => Math.min(Math.max(Math.round(t * p.fps), 0), frameCount(p) - 1);

export const shotAt = (p: Project, t: number) => p.shots.findLast((s) => s.s <= t) ?? null;
export const wordAt = (p: Project, t: number) => p.words.findLast((w) => w.s <= t && t < w.e) ?? null;

export function shotById(p: Project, id: string): Shot {
  const shot = p.shots.find((s) => s.id === id);
  if (!shot) throw new CliError(`no shot "${id}" (shots: ${p.shots.map((s) => s.id).join(", ")})`);
  return shot;
}

/** A word by its key "<line>.<index>". */
export function wordByKey(p: Project, key: string): Word {
  const word = p.words.find((w) => w.key === key);
  if (!word) throw new CliError(`no lyric word "${key}" (write <line id>.<index from 0>, for example ${p.words[0]?.key ?? "v1.0"})`);
  return word;
}

/** The beat nearest to `t` on the whole-beat or half-beat grid. */
export function nearestBeat(grid: Grid, t: number, half = false) {
  const step = half ? 0.5 : 1;
  const n = Math.round(grid.pos(t) / step) * step;
  return { n, t: round3(grid.time(n)), delta: round3(t - grid.time(n)) };
}

export interface Moment {
  t: number;
  frame: number;
  shot: (Shot & { into: number }) | null;
  line: { id: string; text: string; s: number; e: number } | null;
  /** The word being sung at t. */
  word: Word | null;
  /** When no word is being sung: the last one that ended and the next one to start. */
  prevWord: (Word & { ago: number }) | null;
  nextWord: (Word & { in: number }) | null;
  cue: (Cue & { delta: number }) | null;
  beat: { index: number; phase: number; bar?: number; inBar?: number; nearest: { n: number; t: number; delta: number } };
}

/** Everything that is true at time t: shot, lyric, nearest cue, beat. */
export function describe(p: Project, t: number): Moment {
  const shot = shotAt(p, t);
  const word = wordAt(p, t);
  const line = (word && p.lines.find((l) => l.id === word.line)) ?? p.lines.findLast((l) => l.s <= t && t < l.e) ?? null;
  const prev = word ? null : (p.words.findLast((w) => w.e <= t) ?? null);
  const next = word ? null : (p.words.find((w) => w.s > t) ?? null);
  const cue = p.cues.reduce<Cue | null>((best, c) => (!best || Math.abs(c.t - t) < Math.abs(best.t - t) ? c : best), null);
  const pos = p.grid.pos(t);
  const index = Math.floor(pos + 1e-9);
  const bars = p.grid.perBar ? { bar: Math.floor(index / p.grid.perBar) + 1, inBar: (((index % p.grid.perBar) + p.grid.perBar) % p.grid.perBar) + 1 } : {};
  return {
    t: round3(t),
    frame: frameAt(p, t),
    shot: shot && { ...shot, into: round3(t - shot.s) },
    line: line && { id: line.id, text: line.text, s: line.s, e: line.e },
    word,
    prevWord: prev && { ...prev, ago: round3(t - prev.e) },
    nextWord: next && { ...next, in: round3(next.s - t) },
    cue: cue && { ...cue, delta: round3(t - cue.t) },
    beat: { index, phase: round3(pos - index), ...bars, nearest: nearestBeat(p.grid, t) },
  };
}
