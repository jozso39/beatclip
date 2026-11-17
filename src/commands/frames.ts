import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type { Browser } from "playwright-core";
import type { Args } from "../args";
import { launchBrowser, openSession, seek, type Session } from "../browser";
import { grabFrame, pool, probeVideo, ssim } from "../ffmpeg";
import { describe, nearestBeat, shotById, wordByKey, type Project } from "../project";
import { composeSheets, uniquePath, type Tile } from "../sheet";
import { CliError, fmtTime, parseTime, round3, stamp } from "../time";
import type { Result } from "./lookup";

const MAX_TILES = 96;

/** Times from a to b: every `every` seconds, or `count` evenly spread. */
function spread(a: number, b: number, every: number | undefined, count: number): number[] {
  if (b <= a) throw new CliError(`the range ${fmtTime(a)}–${fmtTime(b)} is empty`);
  const step = every ?? (b - a) / count;
  if (step <= 0) throw new CliError("--every must be above 0");
  const out: number[] = [];
  for (let i = 0; a + i * step < b - 1e-9; i++) out.push(a + i * step);
  return out;
}

/** The times the arguments ask for, snapped to video frames, in order, without repeats. */
export function pickTimes(p: Project, args: Args): { times: number[]; slug: string } {
  const every = args.num("every");
  const count = args.num("count") ?? 12;
  const times: number[] = args.rest.map(parseTime);
  const beyond = times.find((t) => t >= p.duration);
  if (beyond !== undefined) throw new CliError(`${fmtTime(beyond)} is past the end of the video (${fmtTime(p.duration)})`);
  let slug = times.length ? "times" : "";
  let range: [number, number] | null = null;
  if (args.has("shot")) {
    const shot = shotById(p, args.str("shot")!);
    range = [shot.s, shot.e];
    slug = `shot-${shot.id}`;
  }
  if (args.has("from") || args.has("to")) {
    range = [args.time("from") ?? range?.[0] ?? 0, args.time("to") ?? range?.[1] ?? p.duration];
    slug ||= `range-${range[0].toFixed(2)}-${range[1].toFixed(2)}`;
  }
  if (args.has("word")) {
    const word = wordByKey(p, args.str("word")!);
    const window = args.num("window") ?? 0.3;
    const step = every ?? window / 2;
    for (let i = -Math.round(window / step); i <= Math.round(window / step); i++) times.push(word.s + i * step);
    slug = `word-${word.key}`;
  } else if (args.has("beats")) {
    const [a, b] = range ?? [0, p.duration];
    const step = args.has("half") ? 0.5 : 1;
    for (let n = Math.ceil(p.grid.pos(a) / step - 1e-6) * step; p.grid.time(n) < b; n += step) times.push(p.grid.time(n));
    slug = `${slug || "all"}-beats`;
  } else if (range) times.push(...spread(range[0], range[1], every, count));
  if (!times.length) throw new CliError("which frames? give times, --from/--to, --shot <id>, --word <line>.<n> or --beats");

  // Times made from a window or a range may reach past either end; those are pulled back onto the video.
  const last = Math.floor(p.duration * p.fps) - 1;
  const frames = new Set(times.map((t) => Math.min(Math.max(Math.round(t * p.fps), 0), last)));
  const snapped = [...frames].sort((a, b) => a - b).map((f) => round3(f / p.fps));
  if (snapped.length > MAX_TILES && !args.has("all")) throw new CliError(`${snapped.length} frames is a lot for contact sheets; narrow the range, raise --every, or pass --all`);
  return { times: snapped, slug };
}

/** Screenshots the live page at each time into `work`, returning the files in order. */
async function shootLive(session: Session, p: Project, times: number[], width: number, work: string, tag: string): Promise<string[]> {
  const page = await session.open(width / p.cfg.page.width);
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    await seek(page, p.cfg, t);
    const file = resolve(work, `${tag}-${i}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 88 });
    files.push(file);
  }
  await page.context().close();
  return files;
}

async function shootVideo(video: string, times: number[], width: number, work: string, tag: string): Promise<string[]> {
  const info = await probeVideo(video);
  return pool(times, 6, async (t, i) => {
    const file = resolve(work, `${tag}-${i}.jpg`);
    await grabFrame(video, info, t, width, file);
    return file;
  });
}

/** Label of one tile; `beatStep` (1 or 0.5) adds the number of the beat the frame sits on. */
function tileLabel(p: Project, t: number, beatStep: number | null): string {
  const m = describe(p, t);
  const word = m.word ? `${m.word.key} “${m.word.w}”` : "–";
  const beat = beatStep ? `  beat ${nearestBeat(p.grid, t, beatStep === 0.5).n}` : "";
  return `${fmtTime(t)}  ${t.toFixed(2)} s${beat}  ${m.shot?.id ?? "–"}  ${word}`;
}

/**
 * Labelled contact sheets of the live page or of a rendered file; --compare puts a second draft beside it.
 * Any failed capture ends the command with an error and writes no sheet.
 */
export async function frames(p: Project, args: Args, cwd: string): Promise<Result> {
  const { times, slug } = pickTimes(p, args);
  const video = args.str("video") && resolve(cwd, args.str("video")!);
  const other = args.str("compare") && resolve(cwd, args.str("compare")!);
  const width = args.num("width") ?? 480;
  const cols = args.num("cols") ?? (other ? 2 : 4);
  const name = (f: string) => basename(f, extname(f));
  const sourceA = video ? basename(video) : "live page";
  const work = mkdtempSync(resolve(tmpdir(), "beatclip-"));
  let session: Session | null = null;
  let browser: Browser | null = null;
  try {
    if (!video) session = await openSession(p.cfg);
    browser = session?.browser ?? (await launchBrowser(p.cfg));
    const a = video ? await shootVideo(video, times, width, work, "a") : await shootLive(session!, p, times, width, work, "a");
    const b = other ? await shootVideo(other, times, width, work, "b") : null;
    // When comparing, each label carries how alike the two pictures are (SSIM, 1.000 = identical).
    const alike = b ? await pool(times, 6, (_, i) => ssim(a[i], b[i])) : null;
    const beatStep = args.has("beats") ? (args.has("half") ? 0.5 : 1) : null;
    const tiles: Tile[] = times.map((t, i) => ({
      images: b ? [a[i], b[i]] : [a[i]],
      label: tileLabel(p, t, beatStep) + (alike ? `  same ${alike[i].toFixed(3)}` : ""),
    }));
    const title = `${slug}  ·  ${other ? `left: ${sourceA}  ·  right: ${basename(other)}` : sourceA}  ·  ${times.length} frames  ·  ${new Date().toLocaleString()}`;

    const explicit = args.str("out") && resolve(cwd, args.str("out")!);
    const base = `${stamp()}-${slug}${video ? `-${name(video)}` : ""}${other ? `-vs-${name(other)}` : ""}`;
    const dest = (n: number, pages: number) => {
      const suffix = pages > 1 ? `-${n + 1}of${pages}` : "";
      return explicit ? resolve(dirname(explicit), `${name(explicit)}${suffix}.png`) : uniquePath(p.cfg.out.sheets, `${base}${suffix}`, "png");
    };
    const sheets = await composeSheets(browser, { title, tiles, cols, width, perSheet: cols * (args.num("rows") ?? 6) }, work, dest);
    const data = { sheets, source: sourceA, compare: other ? basename(other) : null, tiles: times.map((t, i) => ({ t, time: fmtTime(t), label: tiles[i].label, ...(alike ? { same: round3(alike[i]) } : {}) })) };
    return { data, text: [...sheets, `${times.length} frames from ${sourceA}${other ? ` beside ${basename(other)}` : ""}: ${fmtTime(times[0])} to ${fmtTime(times.at(-1)!)}`].join("\n") };
  } finally {
    await (session ? session.close() : browser?.close());
    rmSync(work, { recursive: true, force: true });
  }
}
