import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { Args } from "../args";
import { openSession, shootJpeg, type Session } from "../browser";
import type { Config } from "../config";
import { difference, must, pool } from "../ffmpeg";
import { atExit, identify, recordAlive, type ProcessId } from "../exit";
import { changedSource, frameCount, lastSourceChange, shotAt, shotById, snapshotSources, type Project } from "../project";
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

const framePath = (cfg: Config, f: number) => resolve(cfg.out.cache, `${String(f).padStart(6, "0")}.jpg`);
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

/** Errors a page throws when it reloaded under us. A server that stopped answering (net::ERR_...) is not one of them. */
const RELOAD = /Execution context was destroyed|because of a navigation|frame was detached|Target closed|has been closed/i;
const isReload = (e: unknown) => RELOAD.test((e as Error).message) && !/net::ERR_/.test((e as Error).message);

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

/**
 * Waits until the sources have been quiet for `settleMs`, so the dev server has finished reloading.
 * Quiet is judged by watching them, not by their dates: a file dated in the future must not hold a render up.
 */
async function settle(cfg: Config) {
  if (!cfg.sources.length || Date.now() - lastSourceChange(cfg) >= cfg.render.settleMs) return;
  console.error("render: a source file has just changed; waiting for the page to settle");
  let seen = sourceStamp(cfg);
  for (let quietSince = Date.now(); Date.now() - quietSince < cfg.render.settleMs; ) {
    await Bun.sleep(100);
    const now = sourceStamp(cfg);
    if (now !== seen) [seen, quietSince] = [now, Date.now()];
  }
}

/** A value that changes whenever a source file is added, removed or modified in any way. */
const sourceStamp = (cfg: Config) => JSON.stringify([...snapshotSources(cfg)]);

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

/** Re-shoots sample frames outside the ranges and sorts those that do not match the cache into stale and unstable. */
async function verify(session: Session, p: Project, ranges: Range[], total: number): Promise<Checked> {
  const cfg = p.cfg;
  const samples = pickSamples(p, ranges, total, cfg.render.samples);
  const fresh = new Map<number, Buffer>();
  await shoot(session, p, samples, async (f, jpeg) => fresh.set(f, jpeg), "check");
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
    return checked;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The output file: "{n}" in the pattern becomes the first number not taken yet. */
export function videoPath(pattern: string): string {
  if (!pattern.includes("{n}")) return pattern;
  for (let n = 1; ; n++) {
    const file = pattern.replaceAll("{n}", String(n));
    if (!existsSync(file)) return file;
  }
}

/** Encodes `count` cached frames from frame `first` with the matching stretch of audio. The file appears only when ffmpeg succeeded. */
async function encode(p: Project, out: string, first: number, count: number) {
  const cfg = p.cfg;
  const r = cfg.render;
  mkdirSync(dirname(out), { recursive: true });
  const partial = out.replace(/(\.\w+)$/, ".partial$1");
  const audio = cfg.audio ? ["-ss", String(first / p.fps), "-t", String(count / p.fps), "-i", cfg.audio] : [];
  if (cfg.audio && !existsSync(cfg.audio)) throw new CliError(`no audio file at ${cfg.audio}`);
  await must(
    [
      "ffmpeg", "-y", "-loglevel", "error",
      "-framerate", String(p.fps), "-start_number", String(first), "-i", resolve(cfg.out.cache, "%06d.jpg"),
      ...audio,
      "-frames:v", String(count), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-crf", String(r.crf), "-preset", r.preset, "-pix_fmt", "yuv420p",
      ...(cfg.audio ? ["-c:a", "aac", "-b:a", "256k"] : []),
      "-movflags", "+faststart", partial,
    ],
    "encoding",
  );
  renameSync(partial, out);
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
  if (p.cfg.audio && !existsSync(p.cfg.audio)) throw new CliError(`no audio file at ${p.cfg.audio}`);
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
  const store = (f: number, jpeg: Buffer) => Bun.write(framePath(cfg, f), jpeg);
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
      result = await verify(session, p, out.ranges, total);
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
    if (result.unstable.length) console.error(`check: ${result.unstable.length} sampled frames paint differently depending on what was drawn before (not a stale cache): ${listed(result.unstable)}`);
    if (!result.differing.length) break;
    console.error(`check: ${result.differing.length} of ${result.samples} frames outside ${spans(p, out.ranges)} no longer match the cache: ${listed(result.differing)}`);
    if (!opts.widen) throw new CliError(`frames outside the rendered range changed too (${listed(result.differing)}); render those ranges as well, or drop --no-widen`);

    const widened = mergeRanges([...out.ranges, ...result.differing.map((d): Range => {
      const s = shotAt(p, d.t);
      return s ? [Math.floor(s.s * p.fps), Math.min(total, Math.ceil(s.e * p.fps))] : [0, total];
    })]);
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

/**
 * Full render, or a partial one that re-shoots only some ranges into the persistent frame cache
 * and encodes the whole video (or with --excerpt only that stretch) from the cache.
 */
export async function render(p: Project, args: Args, cwd: string): Promise<Result> {
  args.allow(["notes", "full", "out", "no-encode", "no-verify", "no-widen", "excerpt"], ["from", "to", "shot", "note"]);
  args.noMore();
  if (args.has("excerpt") && args.has("no-encode")) throw new CliError("--excerpt and --no-encode cannot be combined");
  if (args.has("out") && (args.has("no-encode") || args.has("excerpt"))) throw new CliError("--out cannot be combined with --no-encode or --excerpt (an excerpt gets its own name next to the videos)");
  const cfg = p.cfg;
  const total = frameCount(p);
  const asked = requestedRanges(p, args);
  const pattern = outputPattern(p, args, cwd);
  const t0 = Date.now();
  const unlock = lockCache(cfg);
  let done: Shooting;
  let out: string | null = null;
  let encodeMs = 0;
  let excerpt = false;
  try {
    const before = readManifest(cfg);
    const params = { url: cfg.page.url, fps: p.fps, width: cfg.page.width, height: cfg.page.height, scale: cfg.render.scale, quality: cfg.render.quality, frames: total };
    const fullBecause = args.has("full") || !asked.length ? "a full render was asked for" : cacheProblem(cfg, before, params);
    if (fullBecause && asked.length && !args.has("full")) console.error(`render: ${fullBecause}; doing a full render instead of the partial one`);
    const session = await openSession(cfg);
    try {
      const start: Range[] = fullBecause ? [[0, total]] : mergeRanges([...asked, ...(before?.dirty ?? [])]);
      done = await shootChecked(session, p, start, fullBecause, { verify: !args.has("no-verify"), widen: !args.has("no-widen") });
    } finally {
      await session.close();
    }
    // --excerpt encodes only the rendered stretch (a quick look) instead of the whole video.
    excerpt = args.has("excerpt") && done.ranges.length === 1 && sizeOf(done.ranges) < total;
    if (args.has("excerpt") && !excerpt) console.error("render: --excerpt needs one partial range; encoding the whole video");
    if (pattern) {
      const started = Date.now();
      const [a, b] = excerpt ? done.ranges[0] : [0, total];
      out = videoPath(excerpt ? resolve(dirname(pattern), `excerpt-${(a / p.fps).toFixed(2)}-${(b / p.fps).toFixed(2)}-{n}.mp4`) : pattern);
      await encode(p, out, a, b - a);
      encodeMs = Date.now() - started;
    }
  } finally {
    unlock();
  }

  const { ranges, checks, shot, restarts } = done;
  const full = sizeOf(ranges) === total;
  const differing = checks.flatMap((c) => c.differing);
  const unstable = checks.flatMap((c) => c.unstable);
  const seconds = { screenshots: secs(done.ms.screenshots), check: secs(done.ms.check), encode: secs(encodeMs), total: secs(Date.now() - t0) };
  const asSeconds = (rs: Range[]) => rs.map(([a, b]) => ({ from: round3(a / p.fps), to: round3(b / p.fps) }));
  const data = {
    out,
    excerpt,
    kind: full ? "full" : "partial",
    asked: asSeconds(asked),
    rendered: asSeconds(ranges),
    frames: { total, shot },
    restarts,
    fullBecause: full ? done.fullBecause : null,
    check: { rounds: checks.length, samples: checks.map((c) => c.samples), differing, unstable },
    seconds,
  };
  const checkLine = !checks.length
    ? (full ? "not needed for a full render" : "skipped (--no-verify)")
    : differing.length
      ? `${differing.length} frames outside the asked ranges differed from the cache; widened to ${full ? "the whole video" : spans(p, ranges)}`
      : `${checks[0].samples} frames outside the range re-shot, all match the cache${unstable.length ? `; ${unstable.length} of them only after arriving another way` : ""}`;
  const text = [
    ...(out ? [out] : []),
    full ? `full render: ${total} frames${asked.length && done.fullBecause ? ` (${done.fullBecause})` : ""}` : `partial render: ${spans(p, ranges)}, ${shot} of ${total} frames shot`,
    `screenshots  ${seconds.screenshots.toFixed(1)} s  (${shot} frames, ${(shot / Math.max(seconds.screenshots, 0.001)).toFixed(1)} frames/s, ${cfg.render.workers} workers${restarts ? `, started over ${restarts}x after the page changed` : ""})`,
    `check        ${seconds.check.toFixed(1)} s  (${checkLine})`,
    out ? `encode       ${seconds.encode.toFixed(1)} s  (${excerpt ? `only the excerpt, ${sizeOf(ranges)}` : total} frames from the cache)` : "encode       skipped (--no-encode)",
    `total        ${seconds.total.toFixed(1)} s`,
  ].join("\n");
  return { data, text };
}
