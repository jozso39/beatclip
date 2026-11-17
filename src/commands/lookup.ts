import type { Args } from "../args";
import { describe, nearestBeat, type Moment, type Project } from "../project";
import { CliError, fmtBoth, fmtDelta, fmtTime, parseTime, round3 } from "../time";

export interface Result {
  data: unknown;
  text: string;
}

const span = (s: number, e: number) => `${fmtTime(s)}–${fmtTime(e)}`;

/** The readable lines for a moment (shared by `at` and `beat`). */
export function momentLines(m: Moment): string[] {
  const out: string[] = [];
  if (m.shot) out.push(`shot   ${m.shot.id}  ${span(m.shot.s, m.shot.e)}  (${m.shot.into.toFixed(2)} s in)${m.shot.file ? `  ${m.shot.file}` : ""}`);
  else out.push("shot   none");
  if (m.line) out.push(`line   ${m.line.id}  "${m.line.text}"  ${span(m.line.s, m.line.e)}`);
  if (m.word) out.push(`word   ${m.word.key}  "${m.word.w}"  ${span(m.word.s, m.word.e)}  (being sung)`);
  else {
    const prev = m.prevWord ? `last ${m.prevWord.key} "${m.prevWord.w}" ended ${m.prevWord.ago.toFixed(2)} s ago` : "no word before";
    const next = m.nextWord ? `next ${m.nextWord.key} "${m.nextWord.w}" at ${fmtTime(m.nextWord.s)} (in ${m.nextWord.in.toFixed(2)} s)` : "no word after";
    out.push(`word   none sung; ${prev}; ${next}`);
  }
  if (m.cue) out.push(`cue    "${m.cue.name}" at ${fmtTime(m.cue.t)} (${fmtDelta(m.cue.delta)} from it)`);
  const bar = m.beat.bar ? `  bar ${m.beat.bar}, beat ${m.beat.inBar}` : "";
  out.push(`beat   ${m.beat.index} + ${m.beat.phase.toFixed(2)}${bar}  (nearest: beat ${m.beat.nearest.n} at ${fmtTime(m.beat.nearest.t)}, ${fmtDelta(m.beat.nearest.delta)} from it)`);
  return out;
}

export function at(p: Project, args: Args): Result {
  const t = parseTime(args.take("a time (beatclip at 1:07)"));
  const m = describe(p, t);
  const warn = t > p.duration ? [`note   ${fmtTime(t)} is past the end of the video (${fmtTime(p.duration)})`] : [];
  return { data: m, text: [`${fmtBoth(t)}  frame ${m.frame}`, ...momentLines(m), ...warn].join("\n") };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();

interface Hit {
  kind: "shot" | "cue" | "line" | "word";
  id: string;
  t: number;
  e?: number;
  text: string;
}

/** Times of the shots, cues, lyric lines and lyric words (or runs of words) matching a text. */
export function find(p: Project, args: Args): Result {
  const query = norm(args.rest.join(" "));
  if (!query) throw new CliError("missing the text to look for (beatclip find <text>)");
  const tokens = query.split(/\s+/);
  const hits: Hit[] = [];
  for (const s of p.shots) if (s.id.toLowerCase().includes(query)) hits.push({ kind: "shot", id: s.id, t: s.s, e: s.e, text: s.file ?? "" });
  for (const c of p.cues) if (norm(c.name).includes(query)) hits.push({ kind: "cue", id: c.name, t: c.t, text: "" });
  for (const l of p.lines) {
    if (l.id.toLowerCase() === query || (tokens.length > 1 && norm(l.text).includes(query))) hits.push({ kind: "line", id: l.id, t: l.s, e: l.e, text: l.text });
    const words = l.words.map((w) => norm(w.w));
    for (let i = 0; i + tokens.length <= words.length; i++) {
      const run = tokens.every((tok, k) => (k === tokens.length - 1 ? words[i + k].startsWith(tok) : words[i + k] === tok));
      if (run) hits.push({ kind: "word", id: l.words[i].key, t: l.words[i].s, e: l.words[i + tokens.length - 1].e, text: l.words.slice(i, i + tokens.length).map((w) => w.w).join(" ") });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  const rows = hits.map((h) => `${fmtTime(h.t).padStart(8)}  ${h.t.toFixed(2).padStart(7)} s  ${h.kind.padEnd(5)} ${h.id.padEnd(12)} ${h.text}${h.e !== undefined ? `  (to ${fmtTime(h.e)})` : ""}`);
  return { data: hits, text: hits.length ? rows.join("\n") : `nothing matches "${args.rest.join(" ")}"` };
}

/**
 * The time of a beat: the one nearest to a time (default), the next or previous one,
 * on the half-beat grid with --half, moved by +N / -N beats, or beat number --n.
 */
export function beat(p: Project, args: Args): Result {
  const step = args.has("half") ? 0.5 : 1;
  const offsets = args.rest.filter((a) => /^[+-]\d+(\.\d+)?$/.test(a));
  const rest = args.rest.filter((a) => !offsets.includes(a));
  let n: number;
  let from: number | undefined;
  if (args.has("n")) n = args.num("n")!;
  else {
    if (!rest.length) throw new CliError("missing a time (beatclip beat 1:07 [--next|--prev] [--half] [+N|-N]) or --n <beat number>");
    from = parseTime(rest[0]);
    const pos = p.grid.pos(from) / step;
    if (args.has("next")) n = (Math.floor(pos + 1e-6) + 1) * step;
    else if (args.has("prev")) n = (Math.ceil(pos - 1e-6) - 1) * step;
    else n = nearestBeat(p.grid, from, args.has("half")).n;
  }
  n += offsets.reduce((sum, o) => sum + Number(o), 0);
  const t = round3(p.grid.time(n));
  const m = describe(p, t);
  const head = `beat ${n} at ${fmtBoth(t)}  frame ${m.frame}${from === undefined ? "" : `  (${fmtDelta(t - from)} from ${fmtTime(from)})`}`;
  return { data: { n, t, time: fmtTime(t), from, moment: m }, text: [head, ...momentLines(m).slice(0, -1)].join("\n") };
}
