import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { Args } from "../args";
import { openSession, seek, type Session } from "../browser";
import type { Config } from "../config";
import { difference, must, pool } from "../ffmpeg";
import { newestSource, shotAt, shotById, type Project } from "../project";
import { CliError, fmtTime, parseTime, round3 } from "../time";
import type { Result } from "./lookup";
import { loadNotes, noteRange, pendingNotes } from "./notes";

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
  /** True once every frame has been shot with these params. */
  complete: boolean;
  /** Ranges whose re-shoot was started but not finished and checked. */
  dirty: Range[];
  updated: string;
}

function readManifest(cfg: Config): Manifest | null {
  return existsSync(manifestPath(cfg)) ? JSON.parse(readFileSync(manifestPath(cfg), "utf8")) : null;
}
function writeManifest(cfg: Config, m: Omit<Manifest, "updated">) {
  mkdirSync(cfg.out.cache, { recursive: true });
  writeFileSync(manifestPath(cfg), JSON.stringify({ ...m, updated: new Date().toISOString() }));
}

/** Why a partial render cannot use the cache, or null when it can. */
function cacheProblem(cfg: Config, m: Manifest | null, params: Manifest["params"]): string | null {
  if (!m) return "there is no frame cache yet";
  if (!m.complete) return "the frame cache is incomplete (the last full render did not finish)";
  const changed = (Object.keys(params) as (keyof Manifest["params"])[]).find((k) => m.params[k] !== params[k]);
  if (changed) return `the frame cache was shot with another ${changed} (${m.params[changed]}, now ${params[changed]})`;
  const have = readdirSync(cfg.out.cache).filter((f) => f.endsWith(".jpg")).length;
  return have === params.frames ? null : `the frame cache holds ${have} frames, the video has ${params.frames}`;
}

const RELOAD = /Execution context was destroyed|navigat|has been closed|frame was detached|Target closed/i;

/**
 * Shoots the given frames with a pool of pages. Returns null when all were shot from one unchanged page,
 * or the reason why the shots cannot be trusted (the page reloaded, a source file changed).
 */
async function shootOnce(session: Session, p: Project, frames: number[], sink: (frame: number, jpeg: Buffer) => Promise<unknown>, tick: () => void): Promise<string | null> {
  const cfg = p.cfg;
  const started = Date.now();
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
          await seek(page, cfg, frame / p.fps);
          const jpeg = await page.screenshot({ type: "jpeg", quality: cfg.render.quality });
          if (stop) break;
          await sink(frame, jpeg);
          tick();
        }
      } catch (e) {
        if (!stop && !RELOAD.test((e as Error).message)) throw e;
        stop ??= "the page reloaded";
      } finally {
        await page?.context().close().catch(() => {});
      }
    }),
  );
  if (!stop && cfg.sources.length) {
    const newest = newestSource(cfg);
    if (newest.mtime > started) stop = `${relative(cfg.root, newest.file)} changed during the shoot`;
  }
  return stop;
}

/** Waits until no source file has changed for `settleMs`, so the dev server has finished reloading. */
async function settle(cfg: Config) {
  if (!cfg.sources.length) return;
  for (;;) {
    const age = Date.now() - newestSource(cfg).mtime;
    if (age >= cfg.render.settleMs) return;
    await Bun.sleep(cfg.render.settleMs - age + 50);
  }
}

/** Shoots frames, starting over (all of them) whenever the page changed underneath. Returns how many times it had to start over. */
async function shoot(session: Session, p: Project, frames: number[], sink: (frame: number, jpeg: Buffer) => Promise<unknown>, label: string): Promise<number> {
  if (!frames.length) return 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await settle(p.cfg);
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
    if (!reason) return attempt - 1;
    console.error(`${label}: ${reason}; waiting for it to settle and shooting these ${frames.length} frames again (attempt ${attempt + 1})`);
  }
  throw new CliError(`${label}: the page kept changing during 4 attempts; render again when the edits are done`);
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
      await seek(page, p.cfg, Math.max(0, f) / p.fps);
      const jpeg = await page.screenshot({ type: "jpeg", quality: p.cfg.render.quality });
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
function requestedRanges(p: Project, args: Args, total: number): Range[] {
  const seconds: [number, number][] = [];
  const froms = args.all("from").map(parseTime), tos = args.all("to").map(parseTime);
  for (let i = 0; i < Math.max(froms.length, tos.length); i++) seconds.push([froms[i] ?? 0, tos[i] ?? p.duration]);
  for (const id of args.all("shot")) seconds.push([shotById(p, id).s, shotById(p, id).e]);
  const notes = loadNotes(p.cfg);
  for (const id of args.all("note")) {
    const note = notes.find((n) => n.id === Number(id));
    if (!note) throw new CliError(`no note ${id}`);
    seconds.push(noteRange(p, note));
  }
  if (args.has("notes")) {
    const pending = pendingNotes(notes);
    if (!pending.length) throw new CliError("--notes: no open or done notes in the ledger; nothing to render");
    seconds.push(...pending.map((n) => noteRange(p, n)));
  }
  for (const [a, b] of seconds) if (!(b > a)) throw new CliError(`the range ${fmtTime(a)}–${fmtTime(b)} is empty`);
  return mergeRanges(seconds.map(([a, b]) => [Math.max(0, Math.floor(a * p.fps)), Math.min(total, Math.ceil(b * p.fps))]));
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

/**
 * Full render, or a partial one that re-shoots only some ranges into the persistent frame cache
 * and encodes the whole video from the cache. After a partial shoot, frames outside the ranges
 * are sampled and compared with the cache; where they differ the ranges are widened by whole shots,
 * and if that is not enough everything is shot again.
 */
export async function render(p: Project, args: Args, cwd: string): Promise<Result> {
  const cfg = p.cfg;
  const total = Math.floor(p.duration * p.fps);
  const params = { url: cfg.page.url, fps: p.fps, width: cfg.page.width, height: cfg.page.height, scale: cfg.render.scale, quality: cfg.render.quality, frames: total };
  const everything: Range[] = [[0, total]];
  const asked = requestedRanges(p, args, total);
  const before = readManifest(cfg);
  let fullBecause: string | null = args.has("full") || !asked.length ? "a full render was asked for" : cacheProblem(cfg, before, params);
  if (fullBecause && asked.length && !args.has("full")) console.error(`render: ${fullBecause}; doing a full render instead of the partial one`);

  let ranges = fullBecause ? everything : mergeRanges([...asked, ...(before?.dirty ?? [])]);
  const spans = (rs: Range[]) => rs.map(([a, b]) => `${fmtTime(a / p.fps)}–${fmtTime(b / p.fps)}`).join(", ");
  const store = (f: number, jpeg: Buffer) => Bun.write(framePath(cfg, f), jpeg);
  const timings = { screenshots: 0, check: 0, encode: 0 };
  const checks: Checked[] = [];
  let shot = 0, restarts = 0;
  const t0 = Date.now();

  mkdirSync(cfg.out.cache, { recursive: true });
  writeManifest(cfg, fullBecause ? { params, complete: false, dirty: [] } : { params, complete: true, dirty: ranges });
  const session = await openSession(cfg);
  try {
    let todo = framesOf(ranges);
    for (let round = 0; ; round++) {
      const started = Date.now();
      restarts += await shoot(session, p, todo, store, "render");
      shot += todo.length;
      timings.screenshots += Date.now() - started;
      if (sizeOf(ranges) === total || args.has("no-verify")) break;

      const checkStarted = Date.now();
      const result = await verify(session, p, ranges, total);
      timings.check += Date.now() - checkStarted;
      checks.push(result);
      if (result.unstable.length)
        console.error(`check: ${result.unstable.length} sampled frames paint differently depending on what was drawn before (not a stale cache): ${result.unstable.map((d) => `${d.time} (${d.shot ?? "no shot"}, diff ${d.diff.toFixed(1)})`).join(", ")}`);
      if (!result.differing.length) break;
      const where = result.differing.map((d) => `${d.time} (${d.shot ?? "no shot"}, diff ${d.diff.toFixed(1)})`).join(", ");
      console.error(`check: ${result.differing.length} of ${result.samples} frames outside ${spans(ranges)} no longer match the cache: ${where}`);
      if (args.has("no-widen")) throw new CliError(`frames outside the rendered range changed too (${where}); render those ranges as well, or drop --no-widen`);

      const widened = mergeRanges([...ranges, ...result.differing.map((d): Range => {
        const s = shotAt(p, d.t);
        return s ? [Math.floor(s.s * p.fps), Math.min(total, Math.ceil(s.e * p.fps))] : [0, total];
      })]);
      const next = round >= 2 || sizeOf(widened) > 0.6 * total ? everything : widened;
      if (next === everything) fullBecause = `frames outside the ranges kept differing from the cache (${where})`;
      console.error(next === everything ? "check: falling back to a full render" : `check: widening to ${spans(next)}`);
      todo = framesOf(next).filter((f) => !inRanges(ranges, f));
      ranges = next;
      writeManifest(cfg, { params, complete: true, dirty: ranges });
    }
    writeManifest(cfg, { params, complete: true, dirty: [] });
  } finally {
    await session.close();
  }

  // --excerpt encodes only the rendered stretch (a quick look) instead of the whole video.
  const excerpt = args.has("excerpt") && ranges.length === 1 && sizeOf(ranges) < total;
  if (args.has("excerpt") && !excerpt) console.error("render: --excerpt needs one partial range; encoding the whole video");
  let out: string | null = null;
  if (!args.has("no-encode")) {
    const started = Date.now();
    const [a, b] = excerpt ? ranges[0] : [0, total];
    const pattern = args.str("out") ? resolve(cwd, args.str("out")!) : cfg.out.video;
    out = videoPath(excerpt ? resolve(dirname(pattern), `excerpt-${(a / p.fps).toFixed(2)}-${(b / p.fps).toFixed(2)}-{n}.mp4`) : pattern);
    await encode(p, out, a, b - a);
    timings.encode = Date.now() - started;
  }

  const full = sizeOf(ranges) === total;
  const differing = checks.flatMap((c) => c.differing);
  const unstable = checks.flatMap((c) => c.unstable);
  const data = {
    out,
    excerpt,
    kind: full ? "full" : "partial",
    asked: asked.map(([a, b]) => ({ from: round3(a / p.fps), to: round3(b / p.fps) })),
    rendered: ranges.map(([a, b]) => ({ from: round3(a / p.fps), to: round3(b / p.fps) })),
    frames: { total, shot },
    restarts,
    fullBecause: full ? fullBecause : null,
    check: { rounds: checks.length, samples: checks.map((c) => c.samples), differing, unstable },
    seconds: { screenshots: secs(timings.screenshots), check: secs(timings.check), encode: secs(timings.encode), total: secs(Date.now() - t0) },
  };
  const s = data.seconds;
  const checkLine = !checks.length
    ? (full ? "not needed for a full render" : "skipped (--no-verify)")
    : differing.length
      ? `${differing.length} frames outside the asked ranges differed from the cache; widened to ${full ? "the whole video" : spans(ranges)}`
      : `${checks[0].samples} frames outside the range re-shot, all match the cache${unstable.length ? `; ${unstable.length} of them only after arriving another way` : ""}`;
  const text = [
    ...(out ? [out] : []),
    full ? `full render: ${total} frames${asked.length && fullBecause ? ` (${fullBecause})` : ""}` : `partial render: ${spans(ranges)}, ${shot} of ${total} frames shot`,
    `screenshots  ${s.screenshots.toFixed(1)} s  (${shot} frames, ${(shot / Math.max(s.screenshots, 0.001)).toFixed(1)} frames/s, ${cfg.render.workers} workers${restarts ? `, started over ${restarts}x after the page changed` : ""})`,
    `check        ${s.check.toFixed(1)} s  (${checkLine})`,
    out ? `encode       ${s.encode.toFixed(1)} s  (${excerpt ? `only the excerpt, ${sizeOf(ranges)}` : total} frames from the cache)` : "encode       skipped (--no-encode)",
    `total        ${s.total.toFixed(1)} s`,
  ].join("\n");
  return { data, text };
}
