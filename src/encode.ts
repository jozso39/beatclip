import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config } from "./config";
import { writeAtomic } from "./files";
import { must, pool } from "./ffmpeg";
import { frameCount, type Project } from "./project";
import { CliError } from "./time";

export const framePath = (cfg: Config, f: number) => resolve(cfg.out.cache, `${String(f).padStart(6, "0")}.jpg`);

/**
 * The cached frames are full-range JPEG (BT.601 matrix). Players expect limited-range BT.709 from an H.264 file and
 * guess when it is not tagged, which shifts the colours; so the frames are converted and the stream is tagged as such.
 */
const COLOUR =
  "scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p," +
  "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
/** The same tags as encoder options, for ffmpeg versions that do not take them from the filtered frames. */
const TAGS = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** ffmpeg arguments that read `count` cached frames from frame `first`. */
const framesIn = (p: Project, first: number) => ["-framerate", String(p.fps), "-start_number", String(first), "-i", resolve(p.cfg.out.cache, "%06d.jpg")];
/** ffmpeg arguments that encode the picture. */
const pictureOut = (cfg: Config, count: number) => ["-frames:v", String(count), "-vf", COLOUR, "-c:v", "libx264", "-crf", String(cfg.render.crf), "-preset", cfg.render.preset, ...TAGS];
/** ffmpeg arguments for the song from `first` on, for `count` frames (nothing when the project has no audio). */
const audioIn = (p: Project, first: number, count: number) => (p.cfg.audio ? ["-ss", String(first / p.fps), "-t", String(count / p.fps), "-i", p.cfg.audio] : []);
const audioOut = (cfg: Config) => (cfg.audio ? ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", cfg.render.audioBitrate] : []);

/** Runs ffmpeg writing to a temporary name next to `out`; the file appears only when ffmpeg succeeded. */
async function writeVideo(args: string[], out: string, what: string) {
  mkdirSync(dirname(out), { recursive: true });
  const partial = out.replace(/(\.\w+)$/, ".partial$1");
  await must(["ffmpeg", "-y", "-loglevel", "error", ...args, "-movflags", "+faststart", partial], what);
  renameSync(partial, out);
}

/** Encodes `count` cached frames from frame `first` in one pass, with the matching stretch of audio. */
export async function encodeRange(p: Project, out: string, first: number, count: number) {
  await writeVideo([...framesIn(p, first), ...audioIn(p, first, count), ...pictureOut(p.cfg, count), ...audioOut(p.cfg)], out, "encoding");
}

interface Segment {
  first: number;
  count: number;
  file: string;
  /** Changes when any of its frames or the encode settings change. */
  signature: string;
}

/** The pieces the video is encoded in, each with the signature of the frames it is made from. */
function planSegments(p: Project): Segment[] {
  const cfg = p.cfg;
  const total = frameCount(p);
  const size = Math.max(1, Math.round(cfg.render.segment * p.fps));
  const settings = `${cfg.render.crf}|${cfg.render.preset}|${p.fps}|${COLOUR}`;
  const out: Segment[] = [];
  for (let first = 0; first < total; first += size) {
    const count = Math.min(size, total - first);
    const frames = Array.from({ length: count }, (_, i) => {
      const st = statSync(framePath(cfg, first + i));
      return `${st.mtimeMs}:${st.size}`;
    });
    out.push({ first, count, file: `seg-${String(first).padStart(6, "0")}-${count}.mp4`, signature: Bun.hash(`${settings}|${frames.join(",")}`).toString(36) });
  }
  return out;
}

/**
 * Encodes the whole video from the cache in segments and joins them without re-encoding, with the audio.
 * A segment is encoded again only when one of its frames changed, so a small fix costs a small encode.
 * Every segment starts on a key frame and is encoded with the same settings, which is what makes the join exact.
 * Returns how many segments there are and how many had to be encoded.
 */
export async function encodeSegments(p: Project, out: string): Promise<{ segments: number; encoded: number }> {
  const cfg = p.cfg;
  const dir = cfg.out.segments;
  mkdirSync(dir, { recursive: true });
  const index = resolve(dir, "segments.json");
  // An index that cannot be read (a write cut short) is no index: every segment is encoded again.
  let known: Record<string, string> = {};
  try {
    if (existsSync(index)) known = JSON.parse(readFileSync(index, "utf8"));
  } catch {
    console.error(`encode: ${index} cannot be read; encoding every segment again`);
  }
  const plan = planSegments(p);
  const stale = plan.filter((s) => known[s.file] !== s.signature || !existsSync(resolve(dir, s.file)));
  // Three encoders side by side: each already uses several cores, more would only fight over them.
  await pool(stale, 3, async (s) => {
    await writeVideo([...framesIn(p, s.first), ...pictureOut(cfg, s.count), "-an"], resolve(dir, s.file), `encoding frames ${s.first}–${s.first + s.count - 1}`);
    known[s.file] = s.signature;
    writeAtomic(index, JSON.stringify(known));
  });
  // Segments of an earlier plan (another length, another segment size) are of no use any more.
  const wanted = new Set(plan.map((s) => s.file));
  for (const f of readdirSync(dir)) if (/^seg-.*\.mp4$/.test(f) && !wanted.has(f)) rmSync(resolve(dir, f));
  writeAtomic(index, JSON.stringify(Object.fromEntries(plan.map((s) => [s.file, known[s.file]]))));

  const list = resolve(dir, "join.txt");
  writeFileSync(list, plan.map((s) => `file '${resolve(dir, s.file).replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  const total = frameCount(p);
  await writeVideo(["-f", "concat", "-safe", "0", "-i", list, ...audioIn(p, 0, total), "-c:v", "copy", ...audioOut(cfg)], out, "joining the segments");
  return { segments: plan.length, encoded: stale.length };
}

/** Fails early when the audio the encode needs is not there. */
export function requireAudio(cfg: Config) {
  if (cfg.audio && !existsSync(cfg.audio)) throw new CliError(`no audio file at ${cfg.audio}`);
}
