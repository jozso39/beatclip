import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { Args } from "../args";
import { isReload, openSession, shootJpeg, type Session } from "../browser";
import type { Config } from "../config";
import { encodeRange, encodeSegments, framePath, requireAudio } from "../encode";
import { difference, must, pool } from "../ffmpeg";
import { atExit, identify, recordAlive, type ProcessId } from "../exit";
import { frameCount, shotAt, shotById, type Project } from "../project";
import { changedSource, settle, snapshotSources, sourceStamp } from "../sources";
import { CliError, fmtSpan, fmtTime, parseTime, round3 } from "../time";
import type { Result } from "./lookup";
import { loadNotes, noteById, noteRange, pendingNotes } from "./notes";

/** A run of frames: first frame and the frame after the last. */
export type Range = [number, number];

export function mergeRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const inRanges = (ranges: Range[], f: number) => ranges.some(([a, b]) => f >= a && f < b);
const framesOf = (ranges: Range[]) => ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
const sizeOf = (ranges: Range[]) => ranges.reduce((n, [a, b]) => n + b - a, 0);

const manifestPath = (cfg: Config) => resolve(cfg.out.cache, "manifest.json");

interface Manifest {
  /** What the cached frames were shot with; a change of any of these makes the cache useless. */
  params: { url: string; fps: number; width: number; height: number; scale: number; quality: number; frames: number };
  /** False while a full render is under way: until it finishes, the cache may hold frames of several versions or none. */
  complete: boolean;
  /** Ranges whose re-shoot was started but not finished and checked. */
  dirty: Range[];
  /** When the manifest was last written (for people looking at the file). */
  updated: string;
}

function readManifest(cfg: Config): Manifest | null {
  return existsSync(manifestPath(cfg)) ? JSON.parse(readFileSync(manifestPath(cfg), "utf8")) : null;
}
function writeManifest(cfg: Config, m: Omit<Manifest, "updated">) {
  mkdirSync(cfg.out.cache, { recursive: true });
  writeFileSync(manifestPath(cfg), JSON.stringify({ ...m, updated: new Date().toISOString() }));
}

/** Numbers of the frames in the cache folder. */
const cachedFrames = (cfg: Config) => readdirSync(cfg.out.cache).filter((f) => /^\d+\.jpg$/.test(f)).map((f) => parseInt(f));

/**
 * Only one render may write a project's frame cache at a time. Returns the function that gives the lock back.
 * A lock left by a render that died is taken over.
 */
function lockCache(cfg: Config): () => void {
  const file = resolve(cfg.out.cache, ".lock");
  mkdirSync(cfg.out.cache, { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch {
      // An empty lock is one being written right now, unless it has sat there for a while.
      const text = readFileSync(file, "utf8");
      const fresh = !text && Date.now() - statSync(file).mtimeMs < 5000;
      const busy = (holder: string) => new CliError(`another beatclip render is using this frame cache${holder ? ` (process ${(JSON.parse(holder) as ProcessId).pid})` : ""}; wait for it to finish`);
      if (recordAlive(file) || fresh) throw busy(text);
      // Take the dead lock over by moving it aside: of several renders trying at once, only one rename succeeds.
      const aside = `${file}.${process.pid}`;
      try {
        renameSync(file, aside);
      } catch {
        continue;
      }
      const moved = readFileSync(aside, "utf8");
      if (moved !== text) {
        // Another render had already replaced the dead lock with its own: give it back.
        renameSync(aside, file);
        throw busy(moved);
      }
      rmSync(aside);
      continue;
    }
    writeSync(fd, JSON.stringify(identify(process.pid)));
    closeSync(fd);
    return atExit(() => rmSync(file, { force: true }));
  }
  throw new CliError(`cannot lock the frame cache at ${file}`);
}

/** Why a partial render cannot use the cache, or null when it can. */
function cacheProblem(cfg: Config, m: Manifest | null, params: Manifest["params"]): string | null {
  if (!m) return "there is no frame cache yet";
  if (!m.complete) return "the frame cache is incomplete (the last full render did not finish)";
  const changed = (Object.keys(params) as (keyof Manifest["params"])[]).find((k) => m.params[k] !== params[k]);
  if (changed) return `the frame cache was shot with another ${changed} (${m.params[changed]}, now ${params[changed]})`;
  const have = cachedFrames(cfg).filter((f) => f < params.frames).length;
  return have === params.frames ? null : `the frame cache holds ${have} of the video's ${params.frames} frames`;
}

/**
 * Shoots the given frames with a pool of pages. Returns null when all were shot from one unchanged page,
 * or the reason why the shots cannot be trusted (the page reloaded, a source file changed).
 */
async function shootOnce(session: Session, p: Project, frames: number[], sink: (frame: number, jpeg: Buffer) => Promise<unknown>, tick: () => void): Promise<string | null> {
  const cfg = p.cfg;
  const before = snapshotSources(cfg);
  let stop: string | null = null;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(cfg.render.workers, frames.length) }, async () => {
      let page;
      try {
        page = await session.open(cfg.render.scale);
        const main = page.mainFrame();
        page.on("framenavigated", (f) => {
          if (f === main) stop ??= "the page reloaded";
        });
        while (!stop && next < frames.length) {
          const frame = frames[next++];
          const jpeg = await shootJpeg(page, cfg, frame / p.fps);
          if (stop) break;
          await sink(frame, jpeg);
          tick();
        }
      } catch (e) {
        if (!stop && !isReload(e)) throw e;
        stop ??= "the page reloaded";
      } finally {
        await page?.context().close().catch(() => {});
      }
    }),
  );
  const changed = stop ? null : changedSource(before, snapshotSources(cfg));
  if (changed) stop = `${changed} changed during the shoot`;
  return stop;
}

const ATTEMPTS = 4;

/**
 * Shoots frames, starting over (all of them) whenever the page changed underneath.
 * Returns how many times it had to start over and the source stamp all the frames were shot at.
 */
async function shoot(session: Session, p: Project, frames: number[], sink: (frame: number, jpeg: Buffer) => Promise<unknown>, label: string): Promise<{ restarts: number; stamp: string }> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await settle(p.cfg);
    const stamp = sourceStamp(p.cfg);
    if (!frames.length) return { restarts: 0, stamp };
    const started = Date.now();
    let done = 0;
    let said = started;
    const reason = await shootOnce(session, p, frames, sink, () => {
      done++;
      if (Date.now() - said < 10000) return;
      said = Date.now();
      const secs = (said - started) / 1000;
      console.error(`${label}: ${done}/${frames.length} frames, ${secs.toFixed(0)} s, ${(done / secs).toFixed(1)} frames/s`);
    });
    if (!reason) return { restarts: attempt - 1, stamp };
    console.error(`${label}: ${reason}${attempt < ATTEMPTS ? `; waiting for it to settle and shooting these ${frames.length} frames again (attempt ${attempt + 1} of ${ATTEMPTS})` : ""}`);
  }
  throw new CliError(`${label}: the page kept changing during ${ATTEMPTS} attempts; render again when the edits are done`);
}

/** Frames outside the re-shot ranges to check against the cache: next to each edge, the middle of every shot, and a spread over the rest. */
export function pickSamples(p: Project, ranges: Range[], total: number, count: number, random = Math.random): number[] {
  const outside = (f: number) => f >= 0 && f < total && !inRanges(ranges, f);
  const picks = new Set<number>();
  for (const [a, b] of ranges)
    for (const d of [1, p.fps / 4, p.fps / 2, p.fps].map(Math.round)) {
      picks.add(a - d);
      picks.add(b - 1 + d);
    }
  for (const s of p.shots) picks.add(Math.round(((s.s + s.e) / 2) * p.fps));
  const valid = [...picks].filter(outside);
  const rest = Array.from({ length: total }, (_, f) => f).filter((f) => outside(f) && !picks.has(f));
  const more = Math.min(Math.max(0, count - valid.length), rest.length);
  const offset = random();
  for (let i = 0; i < more; i++) valid.push(rest[Math.floor(((i + offset) * rest.length) / more)]);
  return [...new Set(valid)].sort((x, y) => x - y);
}

interface Differing {
  t: number;
  time: string;
  shot: string | null;
  /** How far the fresh frame is from the cached one (0..255). */
  diff: number;
}

interface Checked {
  samples: number;
  /** Frames that no longer match the cache however they are arrived at: the cache is stale there. */
  differing: Differing[];
  /** Frames whose picture depends on what the page drew before; one of the ways of arriving at them reproduces the cache. */
  unstable: Differing[];
}

/**
 * Whether some way of arriving at a frame reproduces the cached picture. A browser does not always paint a frame
 * identically after different earlier frames (layers keep the raster scale of their first paint), so one
 * mismatching shot is not proof of a stale cache; a frame is stale only when no path gives the cached picture back.
 */
async function reproducesCache(page: Page, p: Project, frame: number, differs: (jpeg: Buffer) => Promise<number>): Promise<boolean> {
  const step = p.cfg.render.workers;
  const paths = [[frame - 3 * step, frame - 2 * step, frame - step], [0], [frame - 1], [frame + 5 * p.fps]];
  for (const path of paths) {
    for (const f of [...path, frame]) {
      const jpeg = await shootJpeg(page, p.cfg, Math.min(Math.max(0, f), frameCount(p) - 1) / p.fps);
      if (f === frame && (await differs(jpeg)) < p.cfg.render.differs) return true;
    }
  }
  return false;
}

/** Shoots the given frames and sorts those that do not match the cache into stale and unstable. */
async function compareWithCache(session: Session, p: Project, samples: number[], label: string): Promise<Checked> {
  const cfg = p.cfg;
  const fresh = new Map<number, Buffer>();
  await shoot(session, p, samples, async (f, jpeg) => fresh.set(f, jpeg), label);
  const work = mkdtempSync(resolve(tmpdir(), "beatclip-"));
  try {
    const aspect = cfg.page.width / cfg.page.height;
    const against = (f: number) => async (jpeg: Buffer) => {
      if (jpeg.equals(readFileSync(framePath(cfg, f)))) return 0;
      const file = resolve(work, `${f}-${Math.random().toString(36).slice(2)}.jpg`);
      writeFileSync(file, jpeg);
      return difference(file, framePath(cfg, f), aspect);
    };
    const diffs = await pool(samples, 6, (f) => against(f)(fresh.get(f)!));
    const off = samples
      .map((f, i) => ({ f, t: round3(f / p.fps), time: fmtTime(f / p.fps), shot: shotAt(p, f / p.fps)?.id ?? null, diff: round3(diffs[i]) }))
      .filter((d) => d.diff >= cfg.render.differs);
    const checked: Checked = { samples: samples.length, differing: [], unstable: [] };
    if (off.length) {
      const page = await session.open(cfg.render.scale);
      for (const { f, ...d } of off) (await reproducesCache(page, p, f, against(f)) ? checked.unstable : checked.differing).push(d);
      await page.context().close();
    }
    if (checked.unstable.length) console.error(`${label}: ${checked.unstable.length} sampled frames paint differently depending on what was drawn before (not a stale cache): ${listed(checked.unstable)}`);
    return checked;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The frames of a shot, first to one past the last. */
const shotFrames = (p: Project, s: { s: number; e: number }): Range => [Math.max(0, Math.floor(s.s * p.fps)), Math.min(frameCount(p), Math.ceil(s.e * p.fps))];

/** What stands before the first shot, when the shot list does not start at 0. */
const BEFORE_SHOTS = "(before the first shot)";

/** The stretch of video around a time that is re-shot as one piece: its shot, or the time before the first shot. */
const stretchAt = (p: Project, t: number): { s: number; e: number } => shotAt(p, t) ?? { s: 0, e: p.shots[0]?.s ?? p.duration };

/** For `render --changed`: the first and last frame of every shot (and of the time before the first one) and `perShot` frames spread between them. */
export function shotSamples(p: Project, perShot: number): number[] {
  const picks = new Set<number>();
  for (const shot of p.shots[0]?.s === 0 ? p.shots : [stretchAt(p, 0), ...p.shots]) {
    const [a, end] = shotFrames(p, shot);
    const b = end - 1;
    if (b < a) continue;
    picks.add(a).add(b);
    for (let i = 1; i <= perShot; i++) picks.add(Math.round(a + (i * (b - a)) / (perShot + 1)));
  }
  return [...picks].sort((x, y) => x - y);
}

/** Compares samples of every shot with the cache and returns the shots where the page now draws something else. */
async function changedShots(session: Session, p: Project, perShot: number): Promise<{ ranges: Range[]; shots: string[]; checked: Checked }> {
  const checked = await compareWithCache(session, p, shotSamples(p, perShot), "scan");
  const shots = [...new Set(checked.differing.map((d) => d.shot ?? BEFORE_SHOTS))];
  return { ranges: mergeRanges(checked.differing.map((d) => shotFrames(p, stretchAt(p, d.t)))), shots, checked };
}

/** The output file: "{n}" in the pattern becomes the first number not taken yet. */
export function videoPath(pattern: string): string {
  if (!pattern.includes("{n}")) return pattern;
  for (let n = 1; ; n++) {
    const file = pattern.replaceAll("{n}", String(n));
    if (!existsSync(file)) return file;
  }
}

/** The ranges asked for on the command line, in frames: --from/--to pairs, --shot, --note, --notes. */
function requestedRanges(p: Project, args: Args): Range[] {
  const seconds: [number, number][] = [];
  const froms = args.all("from").map(parseTime), tos = args.all("to").map(parseTime);
  for (let i = 0; i < Math.max(froms.length, tos.length); i++) seconds.push([froms[i] ?? 0, tos[i] ?? p.duration]);
  for (const id of args.all("shot")) seconds.push([shotById(p, id).s, shotById(p, id).e]);
  const notes = loadNotes(p.cfg);
  for (const id of args.all("note")) seconds.push(noteRange(p, noteById(notes, id)));
  if (args.has("notes")) {
    const pending = pendingNotes(notes);
    if (!pending.length) throw new CliError("--notes: no open or done notes in the ledger; nothing to render");
    seconds.push(...pending.map((n) => noteRange(p, n)));
  }
  for (const [a, b] of seconds) {
    if (!(b > a)) throw new CliError(`the range ${fmtSpan(a, b)} is empty`);
    if (a >= p.duration) throw new CliError(`the range ${fmtSpan(a, b)} starts past the end of the video (${fmtTime(p.duration)})`);
  }
  return mergeRanges(seconds.map(([a, b]) => [Math.max(0, Math.floor(a * p.fps)), Math.min(frameCount(p), Math.ceil(b * p.fps))]));
}

/** The output pattern, checked before any frame is shot: a fixed name that already exists is never overwritten. */
function outputPattern(p: Project, args: Args, cwd: string): string | null {
  if (args.has("no-encode")) return null;
  const pattern = args.str("out") ? resolve(cwd, args.str("out")!) : p.cfg.out.video;
  if (!pattern.includes("{n}") && existsSync(pattern)) throw new CliError(`${pattern} already exists; choose another --out, or put {n} in the name to number the drafts`);
  requireAudio(p.cfg);
  return pattern;
}

interface Shooting {
  /** What ended up re-shot (the whole video for a full render). */
  ranges: Range[];
  /** Why everything was shot although ranges were asked for, if so. */
  fullBecause: string | null;
  checks: Checked[];
  /** Screenshots taken into the cache, counting frames shot again. */
  shot: number;
  restarts: number;
  ms: { screenshots: number; check: number };
}

const spans = (p: Project, rs: Range[]) => rs.map(([a, b]) => fmtSpan(a / p.fps, b / p.fps)).join(", ");
const listed = (ds: Differing[]) => ds.map((d) => `${d.time} (${d.shot ?? "no shot"}, diff ${d.diff.toFixed(1)})`).join(", ");

/**
 * Brings the cache up to date for the given ranges: shoots them, checks frames outside them against the cache,
 * widens by whole shots where the cache turned out stale, and shoots everything when that is not enough.
 * If a source file changes at any point, all ranges shot so far are shot again, so the cache never keeps
 * frames of two versions of the page.
 */
async function shootChecked(session: Session, p: Project, start: Range[], fullBecause: string | null, opts: { verify: boolean; widen: boolean }): Promise<Shooting> {
  const cfg = p.cfg;
  const total = frameCount(p);
  const everything: Range[] = [[0, total]];
  const params = { url: cfg.page.url, fps: p.fps, width: cfg.page.width, height: cfg.page.height, scale: cfg.render.scale, quality: cfg.render.quality, frames: total };
  // A frame that came out byte for byte as before is left alone, so the segment encoded from it stays valid.
  const store = async (f: number, jpeg: Buffer) => {
    const file = framePath(cfg, f);
    if (existsSync(file) && statSync(file).size === jpeg.length && jpeg.equals(readFileSync(file))) return;
    await Bun.write(file, jpeg);
  };
  const out: Shooting = { ranges: start, fullBecause, checks: [], shot: 0, restarts: 0, ms: { screenshots: 0, check: 0 } };
  const save = (done: boolean) => writeManifest(cfg, { params, complete: !(sizeOf(out.ranges) === total && !done), dirty: done || sizeOf(out.ranges) === total ? [] : out.ranges });

  save(false);
  // The source stamp every frame of `out.ranges` in the cache was shot at; null until the first shoot.
  let stamp: string | null = null;
  let todo = framesOf(out.ranges);
  for (let widenings = 0, redone = 0; ; ) {
    const started = Date.now();
    const shot = await shoot(session, p, todo, store, "render");
    out.restarts += shot.restarts;
    out.shot += todo.length;
    out.ms.screenshots += Date.now() - started;
    // The first shoot (and a re-shoot of everything) sets the stamp; frames added by widening must have the same one.
    stamp ??= shot.stamp;

    let result: Checked | null = null;
    if (shot.stamp === stamp && sizeOf(out.ranges) < total && opts.verify) {
      const checkStarted = Date.now();
      result = await compareWithCache(session, p, pickSamples(p, out.ranges, total, cfg.render.samples), "check");
      out.ms.check += Date.now() - checkStarted;
    }
    // A source changed since the ranges were shot: part of them is the old version. Shoot them all again.
    if (sourceStamp(cfg) !== stamp) {
      if (++redone >= ATTEMPTS) throw new CliError(`render: the sources kept changing during ${ATTEMPTS} attempts; render again when the edits are done`);
      console.error(`render: a source file changed while rendering; shooting ${spans(p, out.ranges)} again`);
      out.restarts++;
      stamp = null;
      todo = framesOf(out.ranges);
      continue;
    }
    if (!result) break;
    out.checks.push(result);
    if (!result.differing.length) break;
    console.error(`check: ${result.differing.length} of ${result.samples} frames outside ${spans(p, out.ranges)} no longer match the cache: ${listed(result.differing)}`);
    if (!opts.widen) throw new CliError(`frames outside the rendered range changed too (${listed(result.differing)}); render those ranges as well, or drop --no-widen`);

    const widened = mergeRanges([...out.ranges, ...result.differing.map((d) => shotFrames(p, stretchAt(p, d.t)))]);
    const next = ++widenings > 2 || sizeOf(widened) > 0.6 * total ? everything : widened;
    if (next === everything) out.fullBecause = `frames outside the ranges kept differing from the cache (${listed(result.differing)})`;
    console.error(next === everything ? "check: falling back to a full render" : `check: widening to ${spans(p, next)}`);
    todo = framesOf(next).filter((f) => !inRanges(out.ranges, f));
    out.ranges = next;
    save(false);
  }
  // After a full shoot, frames past the end (the video got shorter) must not linger in the cache.
  if (sizeOf(out.ranges) === total) for (const f of cachedFrames(cfg)) if (f >= total) rmSync(framePath(cfg, f));
  save(true);
  return out;
}

const secs = (ms: number) => Math.round(ms / 100) / 10;
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * How many bytes a full render still needs on the disk: the frames not in the cache yet, plus the encoded segments
 * and the joined video (together about a third of the frames at the default settings), plus a gigabyte to spare.
 */
export const spaceNeeded = (frames: number, have: number) => Math.max(0, frames - have) + 0.3 * frames + 1e9;

/**
 * Before a full render: shoots a few frames to learn their size, and stops when the frame cache and the video
 * would not fit on the disk (a render that fills the disk half-way leaves nothing usable).
 */
async function checkSpace(session: Session, p: Project, enforce: boolean) {
  const cfg = p.cfg;
  const total = frameCount(p);
  const sizes: number[] = [];
  await shoot(session, p, Array.from({ length: 8 }, (_, i) => Math.floor(((i + 0.5) * total) / 8)), async (_, jpeg) => sizes.push(jpeg.length), "estimate");
  const frames = (sizes.reduce((a, b) => a + b, 0) / sizes.length) * total;
  const have = cachedFrames(cfg).reduce((sum, f) => sum + statSync(framePath(cfg, f)).size, 0);
  const disk = statfsSync(cfg.out.cache);
  const free = disk.bavail * disk.bsize;
  console.error(`render: the frame cache will take about ${gb(frames)} (${total} frames of ${Math.round(frames / total / 1000)} KB), ${gb(have)} of it is there already; ${gb(free)} free`);
  const need = spaceNeeded(frames, have);
  if (enforce && need > free)
    throw new CliError(`not enough disk space for a full render: it needs about ${gb(need)} and ${gb(free)} are free. Free some space, lower "render.scale" or "render.quality", or pass --no-space-check`);
}

/**
 * Full render, or a partial one that re-shoots only some ranges into the persistent frame cache
 * and encodes the video (or with --excerpt only that stretch) from the cache.
 */
export async function render(p: Project, args: Args, cwd: string): Promise<Result> {
  args.allow(["notes", "full", "changed", "samples", "whole", "out", "no-encode", "no-verify", "no-widen", "excerpt", "drop-cache", "no-space-check"], ["from", "to", "shot", "note"]);
  args.noMore();
  if (args.has("excerpt") && args.has("no-encode")) throw new CliError("--excerpt and --no-encode cannot be combined");
  if (args.has("out") && (args.has("no-encode") || args.has("excerpt"))) throw new CliError("--out cannot be combined with --no-encode or --excerpt (an excerpt gets its own name next to the videos)");
  if (args.has("drop-cache") && (args.has("no-encode") || args.has("excerpt"))) throw new CliError("--drop-cache deletes the frames after the whole video is encoded; it cannot be combined with --no-encode or --excerpt");
  const cfg = p.cfg;
  const total = frameCount(p);
  const asked = requestedRanges(p, args);
  const findChanged = args.has("changed");
  if (findChanged && (asked.length || args.has("full"))) throw new CliError("--changed finds the ranges itself; do not combine it with --from/--to, --shot, --note, --notes or --full");
  if (args.has("samples") && !findChanged) throw new CliError("--samples only applies with --changed");
  const pattern = outputPattern(p, args, cwd);
  const t0 = Date.now();
  const unlock = lockCache(cfg);
  let done: Shooting | null = null;
  let scan: Awaited<ReturnType<typeof changedShots>> | null = null;
  let scanMs = 0;
  let out: string | null = null;
  let encodeMs = 0;
  let excerpt = false;
  let segments: { segments: number; encoded: number } | null = null;
  try {
    const before = readManifest(cfg);
    const params = { url: cfg.page.url, fps: p.fps, width: cfg.page.width, height: cfg.page.height, scale: cfg.render.scale, quality: cfg.render.quality, frames: total };
    const wantFull = args.has("full") || (!asked.length && !findChanged);
    const fullBecause = wantFull ? "a full render was asked for" : cacheProblem(cfg, before, params);
    if (fullBecause && !wantFull) console.error(`render: ${fullBecause}; doing a full render instead`);
    const session = await openSession(cfg);
    try {
      let start: Range[];
      if (fullBecause) {
        await checkSpace(session, p, !args.has("no-space-check"));
        start = [[0, total]];
      } else if (findChanged) {
        const started = Date.now();
        scan = await changedShots(session, p, args.num("samples") ?? cfg.render.changedSamples);
        scanMs = Date.now() - started;
        const hits = (id: string) => scan!.checked.differing.filter((d) => (d.shot ?? BEFORE_SHOTS) === id);
        console.error(scan.shots.length ? `scan: ${scan.shots.length} shots differ from the cache: ${scan.shots.map((id) => `${id} (${hits(id).length} frames, first at ${hits(id)[0].time})`).join(", ")}` : "scan: no shot differs from the cache");
        start = mergeRanges([...scan.ranges, ...(before?.dirty ?? [])]);
      } else start = mergeRanges([...asked, ...(before?.dirty ?? [])]);
      if (start.length) done = await shootChecked(session, p, start, fullBecause, { verify: !args.has("no-verify"), widen: !args.has("no-widen") });
    } finally {
      await session.close();
    }
    if (done && pattern) {
      // --excerpt encodes only the rendered stretch (a quick look) instead of the whole video.
      excerpt = args.has("excerpt") && done.ranges.length === 1 && sizeOf(done.ranges) < total;
      if (args.has("excerpt") && !excerpt) console.error("render: --excerpt needs one partial range; encoding the whole video");
      const started = Date.now();
      if (excerpt) {
        const [a, b] = done.ranges[0];
        out = videoPath(resolve(dirname(pattern), `excerpt-${(a / p.fps).toFixed(2)}-${(b / p.fps).toFixed(2)}-{n}.mp4`));
        await encodeRange(p, out, a, b - a);
      } else {
        out = videoPath(pattern);
        if (args.has("whole") || cfg.render.segment <= 0) await encodeRange(p, out, 0, total);
        else segments = await encodeSegments(p, out);
      }
      encodeMs = Date.now() - started;
      // Still under the lock: another render must not start on a cache that is about to go.
      if (args.has("drop-cache")) {
        rmSync(cfg.out.cache, { recursive: true, force: true });
        rmSync(cfg.out.segments, { recursive: true, force: true });
      }
    }
  } finally {
    unlock();
  }

  const scanLine = scan ? [`scan         ${secs(scanMs).toFixed(1)} s  (${scan.checked.samples} frames compared with the cache; changed shots: ${scan.shots.join(", ") || "none"})`] : [];
  if (!done) {
    const text = [...scanLine, "nothing differs from the cache; nothing was rendered or encoded"].join("\n");
    return { data: { out: null, kind: "none", scan: scan && { samples: scan.checked.samples, shots: scan.shots, unstable: scan.checked.unstable }, seconds: { scan: secs(scanMs), total: secs(Date.now() - t0) } }, text };
  }

  const { ranges, checks, shot, restarts } = done;
  const full = sizeOf(ranges) === total;
  const differing = checks.flatMap((c) => c.differing);
  const unstable = checks.flatMap((c) => c.unstable);
  const seconds = { scan: secs(scanMs), screenshots: secs(done.ms.screenshots), check: secs(done.ms.check), encode: secs(encodeMs), total: secs(Date.now() - t0) };
  const asSeconds = (rs: Range[]) => rs.map(([a, b]) => ({ from: round3(a / p.fps), to: round3(b / p.fps) }));
  const data = {
    out,
    excerpt,
    kind: full ? "full" : "partial",
    asked: asSeconds(asked),
    scan: scan && { samples: scan.checked.samples, shots: scan.shots, differing: scan.checked.differing, unstable: scan.checked.unstable },
    rendered: asSeconds(ranges),
    frames: { total, shot },
    restarts,
    fullBecause: full ? done.fullBecause : null,
    check: { rounds: checks.length, samples: checks.map((c) => c.samples), differing, unstable },
    segments,
    cacheDropped: !!out && args.has("drop-cache"),
    seconds,
  };
  const checkLine = !checks.length
    ? (full ? "not needed for a full render" : "skipped (--no-verify)")
    : differing.length
      ? `${differing.length} frames outside the asked ranges differed from the cache; widened to ${full ? "the whole video" : spans(p, ranges)}`
      : `${checks[0].samples} frames outside the range re-shot, all match the cache${unstable.length ? `; ${unstable.length} of them only after arriving another way` : ""}`;
  const encodeLine = !out
    ? "encode       skipped (--no-encode)"
    : `encode       ${seconds.encode.toFixed(1)} s  (${excerpt ? `only the excerpt, ${sizeOf(ranges)} frames` : segments ? `${segments.encoded} of ${segments.segments} segments encoded, all joined with the audio` : `${total} frames in one pass`})`;
  const text = [
    ...(out ? [out] : []),
    full ? `full render: ${total} frames${!args.has("full") && (asked.length || findChanged) && done.fullBecause ? ` (${done.fullBecause})` : ""}` : `partial render: ${spans(p, ranges)}, ${shot} of ${total} frames shot`,
    ...scanLine,
    `screenshots  ${seconds.screenshots.toFixed(1)} s  (${shot} frames, ${(shot / Math.max(seconds.screenshots, 0.001)).toFixed(1)} frames/s, ${cfg.render.workers} workers${restarts ? `, started over ${restarts}x after the page changed` : ""})`,
    `check        ${seconds.check.toFixed(1)} s  (${checkLine})`,
    encodeLine,
    ...(data.cacheDropped ? [`the frame cache was deleted (--drop-cache): ${cfg.out.cache}`] : []),
    `total        ${seconds.total.toFixed(1)} s`,
  ].join("\n");
  return { data, text };
}
