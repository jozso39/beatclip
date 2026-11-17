import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type { Browser } from "playwright-core";
import type { Args } from "../args";
import { launchBrowser, shootPicture, withSession, type Session } from "../browser";
import { difference, grabFrame, pool, probeVideo, type Crop } from "../ffmpeg";
import { describe, frameAt, nearestBeat, shotById, wordByKey, type Project } from "../project";
import { composeSheets, uniquePath, type Tile } from "../sheet";
import { CliError, fmtSpan, fmtTime, parseTime, round3, stamp } from "../time";
import type { Result } from "./lookup";

const MAX_TILES = 96;

/** Times from a to b: every `every` seconds, or `count` evenly spread. */
function spread(a: number, b: number, every: number | undefined, count: number): number[] {
  if (b <= a) throw new CliError(`the range ${fmtSpan(a, b)} is empty`);
  const step = every ?? (b - a) / count;
  if (step <= 0) throw new CliError("--every must be above 0");
  const out: number[] = [];
  for (let i = 0; a + i * step < b - 1e-9; i++) out.push(a + i * step);
  return out;
}

/** The times the arguments ask for, snapped to video frames, in order, without repeats. */
export function pickTimes(p: Project, args: Args): { times: number[]; slug: string } {
  if (args.has("half") && !args.has("beats")) throw new CliError("--half only applies with --beats");
  if (args.has("window") && !args.has("word")) throw new CliError("--window only applies with --word");
  if (args.has("count") && args.has("every")) throw new CliError("give --count or --every, not both");
  if (args.has("beats") && (args.has("count") || args.has("every"))) throw new CliError("--beats picks the frames itself; --count and --every do not apply");
  if (args.has("word") && args.has("count")) throw new CliError("--count does not apply with --word (use --window and --every)");
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
    if (!(window > 0) || !(step > 0)) throw new CliError("--window and --every must be above 0");
    for (let i = -Math.round(window / step); i <= Math.round(window / step); i++) times.push(word.s + i * step);
    slug = `word-${word.key}`;
  } else if (args.has("beats")) {
    const [a, b] = range ?? [0, p.duration];
    const step = args.has("half") ? 0.5 : 1;
    for (let n = Math.ceil(p.grid.pos(a) / step - 1e-6) * step; p.grid.time(n) < b; n += step) times.push(p.grid.time(n));
    slug = `${slug || "all"}-beats`;
  } else if (range) times.push(...spread(range[0], range[1], every, count));
  if (!times.length) throw new CliError("which frames? give times, --from/--to, --shot <id>, --word <line>.<n> or --beats");

  // A window or a range may reach past either end of the video; only the part inside it is shown.
  const inside = times.filter((t) => t >= 0 && t < p.duration);
  if (!inside.length) throw new CliError(`none of the asked times lie inside the video (0:00.00 to ${fmtTime(p.duration)})`);
  // The exact time of each frame, not a rounded one: a third of a millisecond is visible on a fast-moving element.
  const snapped = [...new Set(inside.map((t) => frameAt(p, t)))].sort((a, b) => a - b).map((f) => f / p.fps);
  if (snapped.length > MAX_TILES && !args.has("all")) throw new CliError(`${snapped.length} frames is a lot for contact sheets; narrow the range, raise --every, or pass --all`);
  return { times: snapped, slug };
}

/** Shoots the live page at each time into `work`, returning the files in order. */
async function shootLive(session: Session, p: Project, times: number[], width: number, work: string, tag: string, crop?: Crop): Promise<string[]> {
  const page = await session.open(p.cfg.render.scale);
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    files.push(resolve(work, `${tag}-${i}.jpg`));
    await shootPicture(page, p.cfg, t, width, files[i], crop);
  }
  await page.context().close();
  return files;
}

async function shootVideo(p: Project, video: string, times: number[], width: number, work: string, tag: string, crop?: Crop): Promise<string[]> {
  const info = await probeVideo(video);
  return pool(times, 6, async (t, i) => {
    const file = resolve(work, `${tag}-${i}.jpg`);
    await grabFrame(video, info, t, width, file, crop, p.cfg.page.width);
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

/** --crop x,y,w,h in page pixels: a rectangle inside the page. */
function parseCrop(p: Project, text: string | undefined): Crop | undefined {
  if (text === undefined) return undefined;
  const [x, y, w, h] = text.split(",").map(Number);
  const page = p.cfg.page;
  if (![x, y, w, h].every(Number.isFinite) || text.split(",").length !== 4 || w < 8 || h < 8 || x < 0 || y < 0 || x + w > page.width || y + h > page.height)
    throw new CliError(`--crop is x,y,w,h in page pixels inside the ${page.width}x${page.height} page (for example --crop 600,300,400,300), got "${text}"`);
  return { x, y, w, h };
}

/**
 * A layout that keeps the sheet no wider than `maxWidth`, so it stays readable when it is looked at scaled down:
 * fewer columns first, then narrower pictures. `changed` says what was adjusted, if anything.
 */
export function fitSheet(cols: number, width: number, pairs: number, maxWidth: number): { cols: number; width: number; changed: string | null } {
  const sheet = (c: number, w: number) => c * (w * pairs + 2 * (pairs - 1) + 8) + 8;
  if (sheet(cols, width) <= maxWidth) return { cols, width, changed: null };
  let c = cols;
  while (c > 1 && sheet(c, width) > maxWidth) c--;
  const w = sheet(c, width) <= maxWidth ? width : Math.floor((maxWidth - 16 - 2 * (pairs - 1)) / pairs);
  return { cols: c, width: w, changed: `kept the sheet within ${maxWidth} px: ${c} column${c > 1 ? "s" : ""} of ${w} px pictures instead of ${cols} of ${width} px (--max-width changes the limit)` };
}

/**
 * Labelled contact sheets of the live page or of a rendered file; --compare puts a second draft beside it.
 * Any failed capture ends the command with an error and writes no sheet.
 */
export async function frames(p: Project, args: Args, cwd: string): Promise<Result> {
  args.allow(["every", "count", "shot", "from", "to", "word", "window", "beats", "half", "video", "compare", "width", "cols", "rows", "max-width", "crop", "out", "all"]);
  const { times, slug } = pickTimes(p, args);
  const video = args.str("video") && resolve(cwd, args.str("video")!);
  const other = args.str("compare") && resolve(cwd, args.str("compare")!);
  const crop = parseCrop(p, args.str("crop"));
  const rows = args.num("rows") ?? 6;
  const pairs = other ? 2 : 1;
  const asked = { cols: args.num("cols") ?? (other ? 2 : 4), width: args.num("width") ?? 480 };
  if (!(asked.cols >= 1) || !(rows >= 1) || !(asked.width >= 16)) throw new CliError("--cols and --rows must be at least 1, --width at least 16");
  const { cols, width, changed } = fitSheet(asked.cols, asked.width, pairs, args.num("max-width") ?? 2000);
  const name = (f: string) => basename(f, extname(f));
  const sourceA = video ? basename(video) : "live page";

  // Shoots, compares and composes; with the live page it is run again from the start if the page reloads under it.
  const produce = async (browser: Browser, session: Session | null): Promise<Result> => {
    const work = mkdtempSync(resolve(tmpdir(), "beatclip-"));
    try {
      const a = video ? await shootVideo(p, video, times, width, work, "a", crop) : await shootLive(session!, p, times, width, work, "a", crop);
      const b = other ? await shootVideo(p, other, times, width, work, "b", crop) : null;
      // When comparing, each label carries how different the two pictures are (0 = identical, see `differences`).
      const aspect = crop ? crop.w / crop.h : p.cfg.page.width / p.cfg.page.height;
      const diffs = b ? await pool(times, 6, (_, i) => difference(a[i], b[i], aspect, crop ? Math.min(480, Math.round(crop.w)) : 480)) : null;
      const beatStep = args.has("beats") ? (args.has("half") ? 0.5 : 1) : null;
      const tiles: Tile[] = times.map((t, i) => ({
        images: b ? [a[i], b[i]] : [a[i]],
        label: tileLabel(p, t, beatStep) + (diffs ? `  diff ${diffs[i].toFixed(1)}${diffs[i] >= p.cfg.differs ? " ≠" : ""}` : ""),
      }));
      const cut = crop ? `  ·  crop ${crop.x},${crop.y} ${crop.w}x${crop.h}` : "";
      const title = `${slug}  ·  ${other ? `left: ${sourceA}  ·  right: ${basename(other)}` : sourceA}${cut}  ·  ${times.length} frames  ·  ${new Date().toLocaleString()}`;

      const explicit = args.str("out") && resolve(cwd, args.str("out")!);
      const base = `${stamp()}-${slug}${video ? `-${name(video)}` : ""}${other ? `-vs-${name(other)}` : ""}`;
      const dest = (n: number, pages: number) => {
        const suffix = pages > 1 ? `-${n + 1}of${pages}` : "";
        return explicit ? resolve(dirname(explicit), `${name(explicit)}${suffix}.png`) : uniquePath(p.cfg.out.sheets, `${base}${suffix}`, "png");
      };
      const sheets = await composeSheets(browser, { title, tiles, cols, width, perSheet: cols * rows }, work, dest);
      const data = {
        sheets,
        source: sourceA,
        compare: other ? basename(other) : null,
        crop: crop ?? null,
        layout: { cols, width, adjusted: changed },
        tiles: times.map((t, i) => ({ t: round3(t), time: fmtTime(t), label: tiles[i].label, ...(diffs ? { diff: round3(diffs[i]), differs: diffs[i] >= p.cfg.differs } : {}) })),
      };
      const differing = diffs ? `; ${diffs.filter((d) => d >= p.cfg.differs).length} of ${times.length} differ (diff >= ${p.cfg.differs})` : "";
      const summary = `${times.length} frames from ${sourceA}${other ? ` beside ${basename(other)}` : ""}: ${fmtTime(times[0])} to ${fmtTime(times.at(-1)!)}${differing}`;
      return { data, text: [...sheets, summary, ...(changed ? [changed] : [])].join("\n") };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  if (!video) return withSession(p.cfg, (session) => produce(session.browser, session));
  const browser = await launchBrowser(p.cfg);
  try {
    return await produce(browser, null);
  } finally {
    await browser.close();
  }
}
