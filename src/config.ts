import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CliError } from "./time";

export const CONFIG_NAME = "beatclip.config.json";

export interface ShotDef {
  id: string;
  /** Start time in seconds; a shot ends where the next one starts. */
  s: number;
  /** Source file, relative to the project root (optional). */
  file?: string;
}
export interface Cue {
  name: string;
  t: number;
}
export type BeatsConfig = { first: number; interval: number; perBar?: number } | { file: string; perBar?: number };

export interface Config {
  /** Project root: the folder of the config file. Every relative path is resolved against it. */
  root: string;
  file: string;
  page: {
    url: string;
    width: number;
    height: number;
    /** Names of the hooks on `window`. */
    ready: string;
    seek: string;
    duration: string;
    /** Optional hook holding the shot list ([{id, s}]). */
    shots?: string;
    /** Optional command that starts the page's server when the URL does not answer. */
    start?: string;
    /** Browser channel for playwright-core. */
    channel: string;
  };
  fps: number;
  duration?: number;
  audio?: string;
  lyrics?: string;
  shots?: ShotDef[];
  /** Globs of the files the picture depends on: a change refreshes the cached shot list and makes a running render shoot again. */
  sources: string[];
  cues: Cue[];
  beats: BeatsConfig;
  out: { sheets: string; cache: string; video: string; proofs: string };
  notes: string;
  /** Two frames count as different when their difference (0..255, see ffmpeg.ts) reaches this. */
  differs: number;
  render: { workers: number; quality: number; scale: number; crf: number; preset: string; settleMs: number; samples: number; differs: number };
  check: {
    /** CSS selector of a word's element; {line} and {word} are replaced. */
    selector: string;
    /** Also check the letters of `shouts`. */
    shouts: boolean;
    before: number;
    after: number;
    visible: number;
    hidden: number;
    frame: { left: number; top: number; right: number; bottom: number };
    allow: string;
    probes: ProbeRule[];
  };
  python: string;
}

export interface ProbeRule {
  probe: string;
  /** "lowest-on-beat" | "highest-on-beat" | "no-overlap" */
  assert: string;
  from: number;
  to: number;
  /** For no-overlap: another probe name, or "words" for every lyric word. */
  with?: string;
  /** Allowed distance from the beat in seconds (default 0.05). */
  tolerance?: number;
  /** Use the half-beat grid. */
  half?: boolean;
}

/** Finds the config: an explicit file or folder, else the nearest one walking up from `cwd`. */
export function findConfig(explicit: string | undefined, cwd: string): string {
  if (explicit) {
    const p = resolve(cwd, explicit);
    const file = existsSync(p) && statSync(p).isDirectory() ? resolve(p, CONFIG_NAME) : p;
    if (!existsSync(file)) throw new CliError(`no config at ${file}`);
    return file;
  }
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = resolve(dir, CONFIG_NAME);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) throw new CliError(`no ${CONFIG_NAME} here or in any parent folder (pass --project <folder>)`);
  }
}

export function loadConfig(file: string): Config {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const root = dirname(file);
  const path = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const opt = (p?: string) => (p ? path(p) : undefined);
  if (!raw.page?.url) throw new CliError(`${file}: "page.url" is required`);
  if (!raw.beats || !("file" in raw.beats || ("first" in raw.beats && "interval" in raw.beats)))
    throw new CliError(`${file}: "beats" needs {first, interval} or {file}`);
  const outDir = path(raw.out?.dir ?? "out");
  const inOut = (p: string | undefined, dflt: string) => (p ? path(p) : resolve(outDir, dflt));
  const frame = { left: 0, top: 0, right: raw.page.width ?? 1920, bottom: raw.page.height ?? 1080, ...raw.check?.frame };
  return {
    root,
    file,
    page: {
      url: raw.page.url,
      width: raw.page.width ?? 1920,
      height: raw.page.height ?? 1080,
      ready: raw.page.ready ?? "__ready",
      seek: raw.page.seek ?? "__seek",
      duration: raw.page.duration ?? "__duration",
      shots: raw.page.shots,
      start: raw.page.start,
      channel: raw.page.channel ?? "chrome",
    },
    fps: raw.fps ?? 60,
    duration: raw.duration,
    audio: opt(raw.audio),
    lyrics: opt(raw.lyrics),
    shots: raw.shots,
    sources: raw.sources ?? [],
    cues: raw.cues ?? [],
    beats: "file" in raw.beats ? { ...raw.beats, file: path(raw.beats.file) } : raw.beats,
    out: {
      sheets: inOut(raw.out?.sheets, "sheets"),
      cache: inOut(raw.out?.cache, "cache/frames"),
      video: inOut(raw.out?.video, "video-{n}.mp4"),
      proofs: inOut(raw.out?.proofs, "proofs"),
    },
    notes: path(raw.notes ?? "beatclip.notes.json"),
    differs: raw.differs ?? 10,
    render: { workers: 8, quality: 93, scale: 1, crf: 17, preset: "medium", settleMs: 1500, samples: 40, differs: 8, ...raw.render },
    check: {
      selector: raw.check?.selector ?? '[data-word="{line}:{word}"]',
      shouts: raw.check?.shouts ?? false,
      before: raw.check?.before ?? 0.15,
      after: raw.check?.after ?? 0.02,
      visible: raw.check?.visible ?? 0.85,
      hidden: raw.check?.hidden ?? 0.5,
      frame,
      allow: path(raw.check?.allow ?? "beatclip.allow.json"),
      probes: raw.check?.probes ?? [],
    },
    python: raw.python ? (raw.python.includes("/") ? path(raw.python) : raw.python) : "python3",
  };
}
