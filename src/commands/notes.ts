import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Args } from "../args";
import { shootPicture, withSession } from "../browser";
import type { Config } from "../config";
import { difference, grabFrame, probeVideo } from "../ffmpeg";
import { describe, shotAt, type Project } from "../project";
import { uniquePath } from "../sheet";
import { CliError, fmtTime, parseTime, round3, stamp } from "../time";
import type { Result } from "./lookup";

export const STATUSES = ["open", "done", "verified", "rejected"] as const;
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
  before?: Proof;
  after?: Proof;
  /** How different the before and after pictures are (0 = identical, 255 = most; below the config's `differs` they look the same). */
  diff?: number;
  created: string;
  updated: string;
}

export function loadNotes(cfg: Config): Note[] {
  if (!existsSync(cfg.notes)) return [];
  return JSON.parse(readFileSync(cfg.notes, "utf8")).notes;
}

function saveNotes(cfg: Config, notes: Note[]) {
  writeFileSync(cfg.notes, JSON.stringify({ notes }, null, 1) + "\n");
}

function noteById(notes: Note[], id: string): Note {
  const note = notes.find((n) => n.id === Number(id));
  if (!note) throw new CliError(`no note ${id} (notes: ${notes.map((n) => n.id).join(", ") || "none yet"})`);
  return note;
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

/** Notes still waiting to be seen in a render: everything not verified or rejected. */
export const pendingNotes = (notes: Note[]) => notes.filter((n) => n.status === "open" || n.status === "done");

const when = (n: Note) => (n.to !== undefined ? `${fmtTime(n.t)}–${fmtTime(n.to)}` : fmtTime(n.t));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function listText(p: Project, notes: Note[]): string {
  if (!notes.length) return "no notes";
  return notes.map((n) => `#${String(n.id).padEnd(3)} ${n.status.padEnd(8)} ${when(n).padEnd(17)} ${(shotAt(p, n.t)?.id ?? "–").padEnd(10)} ${n.text}${n.shows ? `\n     shows: ${n.shows}` : ""}`).join("\n");
}

/** The Markdown table: one row per note with its time in the video and what the frame shows. */
export function reportMarkdown(p: Project, notes: Note[], linkBase: string): string {
  const link = (label: string, proof?: Proof) => (proof ? `[${label}](${relative(linkBase, resolve(p.cfg.root, proof.file))})` : "");
  const rows = notes.map((n) => {
    const proof = [link("before", n.before), link("after", n.after)].filter(Boolean).join(" · ");
    const alike = n.diff === undefined ? "" : n.diff < p.cfg.differs ? ` (LOOKS UNCHANGED: diff ${n.diff.toFixed(1)})` : ` (diff ${n.diff.toFixed(1)})`;
    return `| ${n.id} | ${cell(n.text)} | ${when(n)} | ${shotAt(p, n.t)?.id ?? "–"} | ${n.status} | ${cell(n.shows ?? "")} | ${proof}${proof ? alike : ""} |`;
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

/** Saves the frame at a note's time from the live page or a rendered file as that note's before/after proof. */
async function takeProof(p: Project, note: Note, side: "before" | "after", video: string | undefined, t: number): Promise<Proof> {
  mkdirSync(p.cfg.out.proofs, { recursive: true });
  const file = uniquePath(p.cfg.out.proofs, `note-${note.id}-${side}-${stamp()}`, "jpg");
  const width = Math.min(960, p.cfg.page.width);
  if (video) await grabFrame(video, await probeVideo(video), t, width, file);
  else await withSession(p.cfg, async (s) => shootPicture(await s.open(p.cfg.render.scale), p.cfg, t, width, file));
  return { file: relative(p.cfg.root, file), source: video ? relative(p.cfg.root, video) : "live page", t };
}

/** `notes add|list|set|proof|remove|report`: the ledger tying each note to its time, status and proof frames. */
export async function notes(p: Project, args: Args, cwd: string): Promise<Result> {
  const cfg = p.cfg;
  const all = loadNotes(cfg);
  const action = args.rest.shift() ?? "list";
  const now = new Date().toISOString();

  if (action === "add") {
    const t = parseTime(args.take("the note's time (beatclip notes add 1:07 \"the ball should land on the beat\")"));
    const text = args.rest.join(" ").trim();
    if (!text) throw new CliError("missing the note's text");
    const to = args.time("to");
    if (to !== undefined && to <= t) throw new CliError("--to must be after the note's time");
    const note: Note = { id: Math.max(0, ...all.map((n) => n.id)) + 1, t, ...(to === undefined ? {} : { to }), text, status: "open", created: now, updated: now };
    saveNotes(cfg, [...all, note]);
    const m = describe(p, t);
    return { data: { note, moment: m }, text: `note #${note.id} at ${when(note)}: shot ${m.shot?.id ?? "–"}${m.word ? `, word ${m.word.key} "${m.word.w}"` : ""}` };
  }

  if (action === "list") {
    const status = args.str("status");
    const shown = status ? all.filter((n) => n.status === asStatus(status)) : all;
    return { data: shown, text: listText(p, shown) };
  }

  if (action === "set") {
    const note = noteById(all, args.take("a note id"));
    if (args.rest[0]) note.status = asStatus(args.rest[0]);
    if (args.has("shows")) note.shows = args.str("shows");
    if (args.has("text")) note.text = args.str("text")!;
    if (args.has("to")) note.to = args.time("to");
    note.updated = now;
    saveNotes(cfg, all);
    return { data: note, text: listText(p, [note]) };
  }

  if (action === "proof") {
    const note = noteById(all, args.take("a note id"));
    const side = args.take("before or after");
    if (side !== "before" && side !== "after") throw new CliError(`proof is "before" or "after", not "${side}"`);
    const video = args.str("video") && resolve(cwd, args.str("video")!);
    note[side] = await takeProof(p, note, side, video, args.time("at") ?? note.t);
    if (note.before && note.after) note.diff = round3(await difference(resolve(cfg.root, note.before.file), resolve(cfg.root, note.after.file), cfg.page.width / cfg.page.height));
    note.updated = now;
    saveNotes(cfg, all);
    const alike = note.diff === undefined ? "" : `\nbefore and after: diff ${note.diff.toFixed(1)}${note.diff < cfg.differs ? "  (they look unchanged: the change does not read in the frame)" : ""}`;
    return { data: note, text: `${resolve(cfg.root, note[side]!.file)}\nnote #${note.id} ${side} proof at ${fmtTime(note[side]!.t)} from ${note[side]!.source}${alike}` };
  }

  if (action === "remove") {
    const note = noteById(all, args.take("a note id"));
    saveNotes(cfg, all.filter((n) => n !== note));
    return { data: note, text: `removed note #${note.id}` };
  }

  if (action === "report") {
    const out = args.str("out") && resolve(cwd, args.str("out")!);
    const md = reportMarkdown(p, all, out ? dirname(out) : cfg.root);
    if (out) writeFileSync(out, md + "\n");
    return { data: { file: out ?? null, notes: all, markdown: md }, text: out ? `${md}\n\nwrote ${out}` : md };
  }

  throw new CliError(`unknown notes action "${action}" (add, list, set, proof, remove, report)`);
}
