import { basename, relative, resolve } from "node:path";
import type { Args } from "../args";
import { differences, probeVideo } from "../ffmpeg";
import type { Project } from "../project";
import { CliError, fmtSpan, fmtTime, round3 } from "../time";
import type { Result } from "./lookup";
import { loadNotes, noteRange, type Note } from "./notes";

/** How close to a note's time (seconds) a difference must be for the note to count as visible in the new draft. */
const NEAR = 1;

export interface DiffRange {
  from: number;
  to: number;
  /** Largest difference in the range (0..255) and where it is. */
  peak: number;
  peakAt: number;
}

/** Runs of frames whose difference reaches the threshold; runs closer than `gap` frames are joined. */
export function differingRanges(diffs: number[], fps: number, threshold: number, gap: number): DiffRange[] {
  const out: (DiffRange & { last: number })[] = [];
  diffs.forEach((v, f) => {
    if (v < threshold) return;
    const run = out.at(-1);
    if (run && f - run.last <= gap) {
      run.last = f;
      run.to = round3((f + 1) / fps);
      if (v > run.peak) [run.peak, run.peakAt] = [round3(v), round3(f / fps)];
    } else out.push({ from: round3(f / fps), to: round3((f + 1) / fps), peak: round3(v), peakAt: round3(f / fps), last: f });
  });
  return out.map(({ last, ...r }) => r);
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/**
 * Time ranges where two drafts differ, and with the notes ledger: which ranges no note accounts for,
 * and which notes that should have changed something show no difference at all.
 */
export async function diff(p: Project, args: Args, cwd: string): Promise<Result> {
  args.allow(["threshold", "gap"]);
  const a = resolve(cwd, args.take("the first video (beatclip diff <a.mp4> <b.mp4>)"));
  const b = resolve(cwd, args.take("the second video"));
  args.noMore();
  const [ia, ib] = [await probeVideo(a), await probeVideo(b)];
  if (Math.abs(ia.fps - ib.fps) > 0.01) throw new CliError(`the two videos have different frame rates (${ia.fps} and ${ib.fps})`);
  const threshold = args.num("threshold") ?? p.cfg.differs;
  const diffs = await differences(a, b, ia.width / ia.height);
  const ranges = differingRanges(diffs, ia.fps, threshold, Math.round((args.num("gap") ?? 0.5) * ia.fps));

  // Which notes this comparison can say something about: not the ones given up (rejected, superseded),
  // and not the ones whose change went into another draft than the second file.
  const ledger = loadNotes(p.cfg).filter((n) => n.status !== "rejected" && n.status !== "superseded");
  const notes = ledger.filter((n) => n.doneIn === undefined || resolve(p.cfg.root, n.doneIn) === b);
  const elsewhere = ledger.length - notes.length;
  const explained = ranges.map((range) => ({
    ...range,
    shots: p.shots.filter((s) => overlaps([s.s, s.e], [range.from, range.to])).map((s) => s.id),
    notes: notes.filter((n) => overlaps(noteRange(p, n), [range.from, range.to])).map((n) => n.id),
  }));
  // A note accounts for a range anywhere in its shot, but it only "shows" when something differs right where it points.
  const near = (n: Note): [number, number] => (n.to !== undefined ? [n.t, n.to] : [n.t - NEAR, n.t + NEAR]);
  // Only notes inside the compared stretch can be judged (the drafts may differ in length).
  const compared: [number, number] = [0, diffs.length / ia.fps];
  // Judged: notes done in the second file, and notes marked done with no draft on record. A verified note
  // without a draft was confirmed by the user in some earlier draft and is not expected to change again.
  const judged = (n: Note) => (n.doneIn !== undefined ? n.status !== "open" : n.status === "done");
  const silent = notes.filter((n) => judged(n) && overlaps(near(n), compared) && !ranges.some((range) => overlaps(near(n), [range.from, range.to])));
  const lengthNote = ia.frames === ib.frames ? null : `${basename(a)} has ${ia.frames} frames, ${basename(b)} has ${ib.frames}; only the first ${diffs.length} could be compared`;

  const rows = explained.map((x) => {
    const who = notes.length ? (x.notes.length ? `notes ${x.notes.map((id) => `#${id}`).join(" ")}` : "NO NOTE") : "";
    return `  ${fmtSpan(x.from, x.to).padEnd(19)} ${(x.to - x.from).toFixed(2).padStart(6)} s   peak diff ${x.peak.toFixed(1).padStart(5)} at ${fmtTime(x.peakAt)}   ${x.shots.join(",").padEnd(12)} ${who}`;
  });
  const unexplained = explained.filter((x) => !x.notes.length).length;
  const longest = ranges.reduce<DiffRange | null>((top, r) => (!top || r.to - r.from > top.to - top.from ? r : top), null);
  const text = [
    `${ranges.length} ranges differ between ${basename(a)} and ${basename(b)}  (${diffs.length} frames compared; a frame differs when diff >= ${threshold} of 255)`,
    ...rows,
    ...(notes.length ? [`${unexplained} of ${ranges.length} ranges have no note`] : ["no notes in the ledger to match the ranges against"]),
    ...silent.map((n) => `note #${n.id} (${n.status}${n.doneIn ? "" : ", no draft recorded for it"}) at ${fmtTime(n.t)} "${n.text}": NO DIFFERENCE between the two drafts ${n.to !== undefined ? "in its range" : `within ${NEAR} s of it`}`),
    ...(elsewhere ? [`${elsewhere} notes were done in other drafts than ${basename(b)} and were left out`] : []),
    ...(lengthNote ? [lengthNote] : []),
    ...(longest ? [`look at one:  beatclip frames --from ${longest.from} --to ${longest.to} --video ${relative(cwd, a)} --compare ${relative(cwd, b)}`] : []),
  ].join("\n");
  return {
    data: { a, b, frames: diffs.length, threshold, ranges: explained, unexplained, notesWithoutDifference: silent.map((n) => n.id), notesDoneElsewhere: elsewhere, lengthNote },
    text,
  };
}
