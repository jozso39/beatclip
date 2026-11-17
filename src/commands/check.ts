import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import type { Args } from "../args";
import { withSession } from "../browser";
import type { Config, ProbeRule } from "../config";
import { frameCount, nearestBeat, type Project, type Word } from "../project";
import { CliError, fmtDelta, fmtTime, parseTime, round3 } from "../time";
import type { Result } from "./lookup";

/** One element at one time: how visible it is (0..1, opacity through all ancestors) and its box in page pixels. */
interface Box {
  shown: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** For every (selector, time) pair: the boxes of all elements matching the selector at that time. */
async function measure(page: Page, cfg: Config, asks: { selector: string; t: number }[]): Promise<Box[][]> {
  const out: Box[][] = [];
  for (let i = 0; i < asks.length; i += 300) {
    const part = await page.evaluate(
      async ([seekName, batch]) => {
        const result: Box[][] = [];
        for (const ask of batch) {
          await (window as any)[seekName](ask.t);
          result.push(
            [...document.querySelectorAll<HTMLElement>(ask.selector)].map((el) => {
              let shown = 1;
              for (let n: HTMLElement | null = el; n; n = n.parentElement) {
                const cs = getComputedStyle(n);
                if (cs.display === "none" || cs.visibility === "hidden") shown = 0;
                shown *= Number(cs.opacity);
              }
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) shown = 0;
              return { shown, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            }),
          );
        }
        return result;
      },
      [cfg.page.seek, asks.slice(i, i + 300)] as const,
    );
    out.push(...part);
  }
  return out;
}

const VISIBLE = 0.05;
/** The box around every visible instance, or null when none is visible. */
function union(boxes: Box[]): Box | null {
  const seen = boxes.filter((b) => b.shown > VISIBLE);
  if (!seen.length) return null;
  return {
    shown: Math.max(...seen.map((b) => b.shown)),
    left: Math.min(...seen.map((b) => b.left)),
    top: Math.min(...seen.map((b) => b.top)),
    right: Math.max(...seen.map((b) => b.right)),
    bottom: Math.max(...seen.map((b) => b.bottom)),
  };
}

const probeSelector = (name: string) => `[data-probe="${name}"]`;
const frameTimes = (p: Project, from: number, to: number) => {
  const out: number[] = [];
  for (let f = Math.max(0, Math.ceil(from * p.fps - 1e-6)); f / p.fps <= to + 1e-6 && f < frameCount(p); f++) out.push(round3(f / p.fps));
  return out;
};

interface Extreme {
  t: number;
  /** Lowest or highest pixel row of the box at that time. */
  y: number;
}

/**
 * Turning points of a box over time: where its bottom edge is lowest on screen ("lowest"),
 * or its top edge highest ("highest"). A flat stretch counts once, at its middle. The ends of the series do not count.
 */
export function extremes(series: { t: number; box: Box | null }[], which: "lowest" | "highest"): Extreme[] {
  const pts = series.filter((s) => s.box).map((s) => ({ t: s.t, y: which === "lowest" ? s.box!.bottom : -s.box!.top }));
  const out: Extreme[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (!(pts[i].y > pts[i - 1].y + 1e-3)) continue;
    let j = i;
    while (j + 1 < pts.length && Math.abs(pts[j + 1].y - pts[i].y) <= 1e-3) j++;
    if (j + 1 < pts.length && pts[j + 1].y < pts[i].y - 1e-3) out.push({ t: round3((pts[i].t + pts[j].t) / 2), y: round3(which === "lowest" ? pts[i].y : -pts[i].y) });
    i = j;
  }
  return out;
}

const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The CSS selector of a lyric word's element, from the config's template. */
const wordSelector = (cfg: Config, w: Word) => cfg.check.selector.replaceAll("{line}", w.line).replaceAll("{word}", String(w.index));

export interface Problem {
  /**
   * What exactly is wrong, precise enough that a different failure gets a different key: a lyric word "<line>.<n>",
   * or for a probe rule the probe, the rule, and the time or the other element ("probe:ball lowest-on-beat 3.70").
   */
  key: string;
  /** missing | late | outside | early | off-beat | overlap | no-extreme */
  kind: string;
  t: number;
  message: string;
}

/** Every lyric word must be hidden shortly before its first sound, visible at it, and inside the frame. */
async function checkWords(page: Page, p: Project): Promise<{ words: number; problems: Problem[] }> {
  const c = p.cfg.check;
  const words = p.lines.filter((l) => l.kind === "line" || c.shouts).flatMap((l) => l.words);
  // A word that starts within `before` seconds of time 0 has no "shortly before" to look at.
  const early = (w: Word) => (w.s - c.before >= 0 ? w.s - c.before : null);
  const boxes = await measure(page, p.cfg, words.flatMap((w) => [{ selector: wordSelector(p.cfg, w), t: w.s + c.after }, { selector: wordSelector(p.cfg, w), t: early(w) ?? w.s + c.after }]));
  const best = (list: Box[]) => list.reduce<Box | null>((top, b) => (!top || b.shown > top.shown ? b : top), null);
  const problems: Problem[] = [];
  words.forEach((w, i) => {
    const say = (kind: string, message: string) => problems.push({ key: w.key, kind, t: w.s, message: `${fmtTime(w.s)}  ${w.key.padEnd(8)} ${`"${w.w}"`.padEnd(16)} ${message}` });
    const at = best(boxes[2 * i]);
    const before = early(w) === null ? null : best(boxes[2 * i + 1]);
    if (!at) return say("missing", "never drawn (no element for this word)");
    if (at.shown < c.visible) say("late", `not visible at its first sound (shown ${at.shown.toFixed(2)})`);
    else if (at.left < c.frame.left || at.right > c.frame.right || at.top < c.frame.top || at.bottom > c.frame.bottom)
      say("outside", `outside the frame: x ${at.left.toFixed(0)}–${at.right.toFixed(0)}, y ${at.top.toFixed(0)}–${at.bottom.toFixed(0)}`);
    if (before && before.shown > c.hidden) say("early", `already visible ${c.before} s before its first sound`);
  });
  return { words: words.length, problems };
}

async function checkRule(page: Page, p: Project, rule: ProbeRule): Promise<Problem[]> {
  const rule_ = `probe:${rule.probe} ${rule.assert}`;
  const say = (kind: string, t: number, detail: string, what: string): Problem => ({ key: detail ? `${rule_} ${detail}` : rule_, kind, t, message: `${fmtTime(t)}  probe:${rule.probe}  ${what}` });
  const times = frameTimes(p, rule.from, rule.to);
  const own = (await measure(page, p.cfg, times.map((t) => ({ selector: probeSelector(rule.probe), t })))).map(union);
  if (own.every((b) => !b)) return [say("missing", rule.from, "", `never visible between ${fmtTime(rule.from)} and ${fmtTime(rule.to)}`)];

  if (rule.assert === "lowest-on-beat" || rule.assert === "highest-on-beat") {
    const which = rule.assert === "lowest-on-beat" ? "lowest" : "highest";
    const tolerance = rule.tolerance ?? 0.05;
    const found = extremes(times.map((t, i) => ({ t, box: own[i] })), which);
    if (!found.length) return [say("no-extreme", rule.from, "", `has no ${which} point between ${fmtTime(rule.from)} and ${fmtTime(rule.to)}`)];
    return found
      .map((x) => ({ x, beat: nearestBeat(p.grid, x.t, rule.half) }))
      .filter(({ beat }) => Math.abs(beat.delta) > tolerance)
      .map(({ x, beat }) => say("off-beat", x.t, x.t.toFixed(2), `${which} point is ${fmtDelta(beat.delta)} from beat ${beat.n} (${fmtTime(beat.t)})`));
  }

  if (rule.assert === "no-overlap") {
    const others = rule.with === "words" || !rule.with
      ? p.words.filter((w) => w.e > rule.from && w.s < rule.to).map((w) => ({ id: `word ${w.key}`, name: `word ${w.key} "${w.w}"`, selector: wordSelector(p.cfg, w) }))
      : [{ id: `probe ${rule.with}`, name: `probe ${rule.with}`, selector: probeSelector(rule.with) }];
    const problems: Problem[] = [];
    for (const other of others) {
      const theirs = (await measure(page, p.cfg, times.map((t) => ({ selector: other.selector, t })))).map(union);
      const hit = times.filter((_, i) => own[i] && theirs[i] && intersects(own[i]!, theirs[i]!));
      if (hit.length) problems.push(say("overlap", hit[0], other.id, `overlaps ${other.name} from ${fmtTime(hit[0])} to ${fmtTime(hit.at(-1)!)} (${hit.length} frames)`));
    }
    return problems;
  }
  throw new CliError(`unknown probe rule "${rule.assert}" (lowest-on-beat, highest-on-beat, no-overlap)`);
}

interface Allowed {
  key: string;
  kind: string;
  why?: string;
}

/**
 * The lyric-word sync check plus the probe rules of the config. Problems listed in the allowlist are known
 * exceptions; the exit code is 1 only when there are new ones. --update-allow accepts the current problems.
 */
export async function check(p: Project, args: Args): Promise<Result> {
  args.allow(["update-allow", "all"]);
  args.noMore();
  if (args.has("all") && args.has("update-allow")) throw new CliError("--all and --update-allow cannot be combined");
  const cfg = p.cfg;
  const allowed: Allowed[] = existsSync(cfg.check.allow) ? JSON.parse(readFileSync(cfg.check.allow, "utf8")).allow : [];
  const { words, problems } = await withSession(cfg, async (s) => {
    const page = await s.open();
    const lyric = p.lines.length ? await checkWords(page, p) : { words: 0, problems: [] };
    for (const rule of cfg.check.probes) lyric.problems.push(...(await checkRule(page, p, rule)));
    return lyric;
  });
  problems.sort((a, b) => a.t - b.t);
  const isAllowed = (pr: Problem) => allowed.some((a) => a.key === pr.key && a.kind === pr.kind);
  const fresh = problems.filter((pr) => !isAllowed(pr));
  const known = problems.filter(isAllowed);
  const fixed = allowed.filter((a) => !problems.some((pr) => pr.key === a.key && pr.kind === a.kind));

  if (args.has("update-allow")) {
    const allow = problems.map((pr) => ({ key: pr.key, kind: pr.kind, why: allowed.find((a) => a.key === pr.key && a.kind === pr.kind)?.why ?? "" }));
    writeFileSync(cfg.check.allow, JSON.stringify({ allow }, null, 1) + "\n");
    return { data: { allow, file: cfg.check.allow }, text: `${allow.length} problems are now the known exceptions in ${cfg.check.allow}` };
  }
  const summary = `${words} words and ${cfg.check.probes.length} probe rules checked: ${fresh.length} new problems, ${known.length} known exceptions${fixed.length ? `, ${fixed.length} exceptions no longer needed` : ""}`;
  const text = [
    ...fresh.map((pr) => `NEW    ${pr.message}`),
    ...(args.has("all") ? known.map((pr) => `known  ${pr.message}`) : []),
    ...fixed.map((a) => `fixed  ${a.key} ${a.kind}: no longer a problem, remove it from the allowlist (or run --update-allow)`),
    summary,
  ].join("\n");
  return { data: { words, rules: cfg.check.probes.length, new: fresh, known, fixed }, text, exit: fresh.length ? 1 : 0 };
}

/**
 * `probe <name> [times..] [--from --to]`: the box of the element(s) marked data-probe="<name>" (or matching --selector)
 * at the given times; with --lowest / --highest, its turning points in a range and how far each is from a beat.
 */
export async function probe(p: Project, args: Args): Promise<Result> {
  args.allow(["selector", "from", "to", "lowest", "highest", "half"]);
  const selector = args.str("selector") ?? probeSelector(args.take("a probe name (or --selector <css>)"));
  const range = args.has("from") || args.has("to");
  if (range && args.rest.length) throw new CliError(`give times or --from/--to, not both (unexpected "${args.rest[0]}")`);
  if (args.has("half") && !args.has("lowest") && !args.has("highest")) throw new CliError("--half only applies with --lowest or --highest");
  if (!range && (args.has("lowest") || args.has("highest"))) throw new CliError("--lowest and --highest need a range (--from/--to)");
  const times = range ? frameTimes(p, args.time("from") ?? 0, args.time("to") ?? p.duration) : args.rest.map(parseTime);
  if (!times.length) throw new CliError("which times? give times, or --from/--to");
  const boxes = await withSession(p.cfg, async (s) => (await measure(await s.open(), p.cfg, times.map((t) => ({ selector, t })))).map(union));
  const series = times.map((t, i) => ({ t, box: boxes[i] }));
  const row = (s: (typeof series)[number]) => {
    const b = s.box;
    return `${fmtTime(s.t)}  ${b ? `x ${b.left.toFixed(0)}–${b.right.toFixed(0)}  y ${b.top.toFixed(0)}–${b.bottom.toFixed(0)}  shown ${b.shown.toFixed(2)}` : "not visible"}`;
  };
  const which = args.has("lowest") ? "lowest" : args.has("highest") ? "highest" : null;
  if (which) {
    const found = extremes(series, which).map((x) => ({ ...x, beat: nearestBeat(p.grid, x.t, args.has("half")) }));
    const text = found.length
      ? found.map((x) => `${fmtTime(x.t)}  ${which} point y ${x.y.toFixed(0)}  ${fmtDelta(x.beat.delta)} from beat ${x.beat.n} (${fmtTime(x.beat.t)})`).join("\n")
      : `no ${which} point between ${fmtTime(times[0])} and ${fmtTime(times.at(-1)!)}`;
    return { data: { selector, extremes: found }, text };
  }
  const shown = range && series.length > 40 ? series.filter((_, i) => i % Math.ceil(series.length / 40) === 0) : series;
  return { data: { selector, boxes: series }, text: shown.map(row).join("\n") + (shown.length < series.length ? `\n(${series.length} frames measured, every ${Math.ceil(series.length / 40)}th shown; --json has all)` : "") };
}
