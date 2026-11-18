import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Args } from "../args";
import { shootPicture, withSession } from "../browser";
import type { Config } from "../config";
import { difference, grabFrame, pool, probeVideo } from "../ffmpeg";
import { writeAtomic } from "../files";
import { describe, frameAt, shotAt, type Project } from "../project";
import { uniquePath } from "../sheet";
import { CliError, fmtSpan, fmtTime, parseTime, round3, stamp } from "../time";
import type { Result } from "./lookup";

export const STATUSES = ["open", "done", "verified", "rejected", "superseded"] as const;
export type Status = (typeof STATUSES)[number];

interface Proof {
  /** Picture file, relative to the project root. */
  file: string;
  /** "live page" or the video file it was taken from. */
  source: string;
  t: number;
}

export interface Note {
  id: number;
  /** Time in the video the note is about; `to` makes it a range. */
  t: number;
  to?: number;
  /** The user's own wording. */
  text: string;
  status: Status;
  /** What the frame shows now, written when the change is checked. */
  shows?: string;
  /** Frames from before and after the change; several when the note is about a movement. */
  before?: Proof[];
  after?: Proof[];
  /** How different the before and after pictures are at most (0 = identical, 255 = most; below the config's `differs` they look the same). */
  diff?: number;
  /** The draft the change was done in (the video its "after" proof came from), relative to the project root. */
  doneIn?: string;
  /** For a superseded note: the note that replaced it. */
  supersededBy?: number;
  created: string;
  updated: string;
}

export function loadNotes(cfg: Config): Note[] {
  if (!existsSync(cfg.notes)) return [];
  const notes = JSON.parse(readFileSync(cfg.notes, "utf8")).notes as Note[];
  // Ledgers written before a note could hold several proof frames have one frame per side, not a list.
  for (const n of notes) for (const side of ["before", "after"] as const) if (n[side] && !Array.isArray(n[side])) n[side] = [n[side] as unknown as Proof];
  return notes;
}

const saveNotes = (cfg: Config, notes: Note[]) => writeAtomic(cfg.notes, JSON.stringify({ notes }, null, 1) + "\n");

export function noteById(notes: Note[], id: string | number): Note {
  const note = notes.find((n) => n.id === Number(id));
  if (!note) throw new CliError(`no note ${id} (notes: ${notes.map((n) => n.id).join(", ") || "none yet"})`);
  return note;
}

/**
 * The notes named by "3", "1,4", "2-6" or a mix of those, in ledger order; a range takes the notes there are in it.
 * "all" is `everyone`: the notes of the round in hand, never the settled ones of earlier rounds.
 */
export function notesByIds(notes: Note[], spec: string, everyone: Note[]): Note[] {
  if (spec === "all") return everyone;
  const ids = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new CliError(`"${spec}" does not name notes (write 3, 1,4, 2-6 or all)`);
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (b < a) throw new CliError(`the range ${part} runs backwards`);
    const found = notes.filter((n) => n.id >= a && n.id <= b);
    if (!found.length) throw new CliError(`no note${a === b ? ` ${a}` : `s in ${part}`} (notes: ${notes.map((n) => n.id).join(", ") || "none yet"})`);
    for (const n of found) ids.add(n.id);
  }
  return notes.filter((n) => ids.has(n.id));
}

/** Changes notes in the ledger as it is on disk right now (another command may have written it meanwhile) and saves it. */
function updateNotes(cfg: Config, ids: number[], change: (note: Note) => void): Note[] {
  const all = loadNotes(cfg);
  const changed = ids.map((id) => noteById(all, id));
  for (const note of changed) {
    change(note);
    note.updated = new Date().toISOString();
  }
  saveNotes(cfg, all);
  return changed;
}

function asStatus(s: string): Status {
  if (!STATUSES.includes(s as Status)) throw new CliError(`unknown status "${s}" (one of: ${STATUSES.join(", ")})`);
  return s as Status;
}

/** The stretch of video a note covers: its own range, else the whole shot around its time. */
export function noteRange(p: Project, note: Note): [number, number] {
  if (note.to !== undefined) return [note.t, note.to];
  const shot = shotAt(p, note.t);
  return shot ? [shot.s, shot.e] : [note.t, Math.min(p.duration, note.t + 1)];
}

/** Notes still waiting to be seen in a render: open ones and those done but not yet confirmed. */
export const pendingNotes = (notes: Note[]) => notes.filter((n) => n.status === "open" || n.status === "done");

const when = (n: Note) => (n.to !== undefined ? fmtSpan(n.t, n.to) : fmtTime(n.t));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const statusText = (n: Note) => `${n.status}${n.supersededBy ? ` by #${n.supersededBy}` : ""}${n.doneIn && n.status !== "superseded" ? ` in ${basename(n.doneIn)}` : ""}`;

function listText(p: Project, notes: Note[]): string {
  if (!notes.length) return "no notes";
  return notes
    .map((n) => {
      const extra = [n.supersededBy ? `superseded by #${n.supersededBy}` : "", n.doneIn ? `in ${basename(n.doneIn)}` : ""].filter(Boolean).join(", ");
      return `#${String(n.id).padEnd(3)} ${n.status.padEnd(10)} ${when(n).padEnd(17)} ${(shotAt(p, n.t)?.id ?? "–").padEnd(10)} ${n.text}${extra ? `  [${extra}]` : ""}${n.shows ? `\n     shows: ${n.shows}` : ""}`;
    })
    .join("\n");
}

/** The Markdown table: one row per note with its time in the video and what the frame shows. */
export function reportMarkdown(p: Project, notes: Note[], linkBase: string): string {
  const side = (label: string, proofs?: Proof[]) => (proofs?.length ? `${label} ${proofs.map((pr) => `[${fmtTime(pr.t)}](${relative(linkBase, resolve(p.cfg.root, pr.file))})`).join(" ")}` : "");
  const rows = notes.map((n) => {
    const proof = [side("before", n.before), side("after", n.after)].filter(Boolean).join(" · ");
    const alike = n.diff === undefined ? "" : n.diff < p.cfg.differs ? ` (LOOKS UNCHANGED: diff ${n.diff.toFixed(1)})` : ` (diff ${n.diff.toFixed(1)})`;
    return `| ${n.id} | ${cell(n.text)} | ${when(n)} | ${shotAt(p, n.t)?.id ?? "–"} | ${statusText(n)} | ${cell(n.shows ?? "")} | ${proof}${proof ? alike : ""} |`;
  });
  const count = (s: Status) => notes.filter((n) => n.status === s).length;
  return [
    `${notes.length} notes: ${STATUSES.map((s) => `${count(s)} ${s}`).join(", ")}`,
    "",
    "| # | Change | Time in the video | Shot | Status | What the frame shows | Proof |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Saves one frame per (note, time) from the live page or a rendered file, and returns the proofs in the same order. */
async function takeProofs(p: Project, jobs: { note: Note; t: number }[], side: "before" | "after", video: string | undefined): Promise<Proof[]> {
  const cfg = p.cfg;
  mkdirSync(cfg.out.proofs, { recursive: true });
  const width = Math.min(960, cfg.page.width);
  const source = video ? relative(cfg.root, video) : "live page";
  const mark = stamp();
  const files = jobs.map((j, i) => uniquePath(cfg.out.proofs, `note-${j.note.id}-${side}-${mark}-${i + 1}`, "jpg"));
  if (video) {
    const info = await probeVideo(video);
    await pool(jobs, 6, (j, i) => grabFrame(video, info, j.t, width, files[i]));
  } else
    await withSession(cfg, async (s) => {
      const page = await s.open(cfg.render.scale);
      // The page is shot at the time of the video frame that shows this moment, so it can be compared with a frame of a draft.
      for (const [i, j] of jobs.entries()) await shootPicture(page, cfg, frameAt(p, j.t) / p.fps, width, files[i]);
    });
  return jobs.map((j, i) => ({ file: relative(cfg.root, files[i]), source, t: j.t }));
}

/** The largest difference between the before and after frames that show the same moment (or stand at the same place). */
async function proofDiff(cfg: Config, before: Proof[], after: Proof[]): Promise<number | undefined> {
  const pairs = after.flatMap((a, i) => {
    const b = before.find((x) => x.t === a.t) ?? (before.length === after.length ? before[i] : undefined);
    return b ? [[b, a] as const] : [];
  });
  if (!pairs.length) return undefined;
  const aspect = cfg.page.width / cfg.page.height;
  const files = pairs.map((pair) => pair.map((pr) => resolve(cfg.root, pr.file)));
  // A proof picture that was deleted since cannot be compared; the note then simply has no difference on record.
  if (!files.flat().every((f) => existsSync(f))) return undefined;
  const diffs = await pool(files, 6, ([b, a]) => difference(b, a, aspect));
  return round3(Math.max(...diffs));
}

/** A note's end time from --to: after its start, inside the video; "none" removes it. */
function endTime(p: Project, args: Args, start: number): number | undefined {
  if (args.str("to") === "none") return undefined;
  const to = args.time("to")!;
  if (to <= start) throw new CliError("--to must be after the note's time");
  if (to > p.duration) throw new CliError(`--to is past the end of the video (${fmtTime(p.duration)})`);
  return to;
}

/** The draft named by --video, as an absolute path that exists. */
function videoArg(args: Args, cwd: string): string | undefined {
  if (!args.has("video")) return undefined;
  const video = resolve(cwd, args.str("video")!);
  if (!existsSync(video)) throw new CliError(`no such video: ${video}`);
  return video;
}

function add(p: Project, args: Args): Result {
  const cfg = p.cfg;
  const t = parseTime(args.take('the note\'s time (beatclip notes add 1:07 "the ball should land on the beat")'));
  if (t >= p.duration) throw new CliError(`${fmtTime(t)} is past the end of the video (${fmtTime(p.duration)})`);
  const text = args.rest.join(" ").trim();
  if (!text) throw new CliError("missing the note's text");
  const to = args.has("to") ? endTime(p, args, t) : undefined;
  const now = new Date().toISOString();
  const all = loadNotes(cfg);
  const note: Note = { id: Math.max(0, ...all.map((n) => n.id)) + 1, t, ...(to === undefined ? {} : { to }), text, status: "open", created: now, updated: now };
  saveNotes(cfg, [...all, note]);
  const m = describe(p, t);
  return { data: { note, moment: m }, text: `note #${note.id} at ${when(note)}: shot ${m.shot?.id ?? "–"}${m.word ? `, word ${m.word.key} "${m.word.w}"` : ""}` };
}

/** `notes set <ids> [status]`: status and the draft it was done in for any number of notes; wording for one. */
function set(p: Project, args: Args, cwd: string): Result {
  const cfg = p.cfg;
  const ledger = loadNotes(cfg);
  const chosen = notesByIds(ledger, args.take("note ids (3, 1,4, 2-6 or all)"), pendingNotes(ledger));
  const status = args.rest.length ? asStatus(args.rest.shift()!) : undefined;
  args.noMore();
  if (!chosen.length) throw new CliError("all means the open and done notes, and there are none; name the notes by id");
  const single = ["shows", "text", "to"].find((o) => args.has(o));
  if (single && chosen.length > 1) throw new CliError(`--${single} applies to one note; ${chosen.length} were named`);
  if (args.has("by") !== (status === "superseded")) throw new CliError("a superseded note names its replacement: notes set <id> superseded --by <id of the new note>");
  const by = args.has("by") ? noteById(loadNotes(cfg), args.str("by")!).id : undefined;
  if (by !== undefined && chosen.some((n) => n.id === by)) throw new CliError("a note cannot be superseded by itself");
  const video = videoArg(args, cwd);
  const changed = updateNotes(cfg, chosen.map((n) => n.id), (n) => {
    if (status) n.status = status;
    if (by !== undefined) n.supersededBy = by;
    else if (status) delete n.supersededBy;
    if (video) n.doneIn = relative(cfg.root, video);
    // A note sent back to open is not done in any draft any more.
    else if (status === "open") delete n.doneIn;
    if (args.has("shows")) n.shows = args.str("shows");
    if (args.has("text")) n.text = args.str("text")!;
    if (args.has("to")) {
      const to = endTime(p, args, n.t);
      if (to === undefined) delete n.to;
      else n.to = to;
    }
  });
  return { data: changed.length === 1 ? changed[0] : changed, text: listText(p, changed) };
}

/** `notes proof <ids> before|after`: frames at each note's time (or at every --at for one note). */
async function proof(p: Project, args: Args, cwd: string): Promise<Result> {
  const cfg = p.cfg;
  const spec = args.take("note ids (3, 1,4, 2-6 or all)");
  const side = args.take("before or after");
  args.noMore();
  if (side !== "before" && side !== "after") throw new CliError(`proof is "before" or "after", not "${side}"`);
  // "all" never reaches back into earlier rounds: a before frame is for a change not made yet (open notes),
  // an after frame for one not confirmed yet (open and done notes).
  const ledger = loadNotes(cfg);
  const chosen = notesByIds(ledger, spec, side === "before" ? ledger.filter((n) => n.status === "open") : pendingNotes(ledger));
  if (!chosen.length) throw new CliError(`all means the ${side === "before" ? "open" : "open and done"} notes, and there are none; name the notes by id`);
  const at = args.all("at").map(parseTime);
  if (at.length && chosen.length > 1) throw new CliError("--at gives the moments of one note; name one note with it");
  const video = videoArg(args, cwd);
  const jobs = chosen.flatMap((note) => (at.length ? at : [note.t]).map((t) => ({ note, t })));
  const proofs = await takeProofs(p, jobs, side, video);
  const of = (id: number) => proofs.filter((_, i) => jobs[i].note.id === id);
  const diffs = new Map<number, number | undefined>();
  for (const n of chosen) diffs.set(n.id, await proofDiff(cfg, side === "before" ? of(n.id) : (n.before ?? []), side === "after" ? of(n.id) : (n.after ?? [])));
  // The captures took a while: apply the result to the ledger as it is now.
  const changed = updateNotes(cfg, chosen.map((n) => n.id), (n) => {
    n[side] = of(n.id);
    const diff = diffs.get(n.id);
    if (diff === undefined) delete n.diff;
    else n.diff = diff;
    // The after frame says where the change is: in that draft, or (taken from the live page) in none yet.
    if (side === "after" && video) n.doneIn = relative(cfg.root, video);
    else if (side === "after") delete n.doneIn;
  });
  const lines = changed.flatMap((n) => {
    const alike = n.diff === undefined ? "" : `; before and after: diff ${n.diff.toFixed(1)}${n.diff < cfg.differs ? "  (they look unchanged: the change does not read in the frame)" : ""}`;
    return [...n[side]!.map((pr) => resolve(cfg.root, pr.file)), `note #${n.id} ${side} proof at ${n[side]!.map((pr) => fmtTime(pr.t)).join(", ")} from ${n[side]![0].source}${alike}`];
  });
  return { data: changed.length === 1 ? changed[0] : changed, text: lines.join("\n") };
}

function remove(p: Project, args: Args): Result {
  const all = loadNotes(p.cfg);
  const note = noteById(all, args.take("a note id"));
  args.noMore();
  saveNotes(p.cfg, all.filter((n) => n !== note));
  return { data: note, text: `removed note #${note.id}` };
}

function report(p: Project, args: Args, cwd: string): Result {
  args.noMore();
  const all = loadNotes(p.cfg);
  const out = args.str("out") && resolve(cwd, args.str("out")!);
  const md = reportMarkdown(p, all, out ? dirname(out) : p.cfg.root);
  if (out) writeFileSync(out, md + "\n");
  return { data: { file: out ?? null, notes: all, markdown: md }, text: out ? `${md}\n\nwrote ${out}` : md };
}

function list(p: Project, args: Args): Result {
  args.noMore();
  const status = args.str("status");
  const shown = loadNotes(p.cfg).filter((n) => !status || n.status === asStatus(status));
  return { data: shown, text: listText(p, shown) };
}

/** `notes add|list|set|proof|remove|report`: the ledger tying each note to its time, status, draft and proof frames. */
export async function notes(p: Project, args: Args, cwd: string): Promise<Result> {
  const action = args.rest.shift() ?? "list";
  const actions: Record<string, { options: string[]; repeatable?: string[]; run: () => Result | Promise<Result> }> = {
    add: { options: ["to"], run: () => add(p, args) },
    list: { options: ["status"], run: () => list(p, args) },
    set: { options: ["shows", "text", "to", "video", "by"], run: () => set(p, args, cwd) },
    proof: { options: ["video"], repeatable: ["at"], run: () => proof(p, args, cwd) },
    remove: { options: [], run: () => remove(p, args) },
    report: { options: ["out"], run: () => report(p, args, cwd) },
  };
  const chosen = actions[action];
  if (!chosen) throw new CliError(`unknown notes action "${action}" (${Object.keys(actions).join(", ")})`);
  args.allow(chosen.options, chosen.repeatable);
  return chosen.run();
}
