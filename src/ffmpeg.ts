import { existsSync, statSync } from "node:fs";
import { CliError } from "./time";

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program to the end and returns what it printed. A missing program is a CliError. */
export async function run(cmd: string[]): Promise<Ran> {
  let proc;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new CliError(`cannot run "${cmd[0]}": is it installed and on PATH?`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** Like `run`, but a non-zero exit is an error carrying the program's last lines. */
export async function must(cmd: string[], what: string): Promise<Ran> {
  const r = await run(cmd);
  if (r.code !== 0) throw new CliError(`${what} failed (${cmd[0]} exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frames: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  if (!existsSync(file)) throw new CliError(`no such video: ${file}`);
  const r = await must(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", file],
    `reading ${file}`,
  );
  const j = JSON.parse(r.stdout);
  const st = j.streams?.[0];
  if (!st) throw new CliError(`${file} has no video stream`);
  const [num, den] = String(st.r_frame_rate).split("/").map(Number);
  const fps = num / (den || 1);
  const duration = Number(j.format.duration);
  return { width: st.width, height: st.height, fps, duration, frames: Number(st.nb_frames) || Math.round(duration * fps) };
}

/** Writes the frame shown at time `t` of a video as a JPEG scaled to `width`. */
export async function grabFrame(video: string, info: VideoInfo, t: number, width: number, out: string): Promise<void> {
  const frame = Math.round(t * info.fps);
  if (frame < 0 || frame >= info.frames) throw new CliError(`${video} has no frame at ${t.toFixed(2)} s (it is ${info.duration.toFixed(2)} s long)`);
  // Seeking a hair before the frame's timestamp makes ffmpeg return exactly that frame.
  const at = Math.max(0, frame / info.fps - 0.25 / info.fps);
  await must(["ffmpeg", "-y", "-loglevel", "error", "-ss", at.toFixed(5), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out], `reading a frame of ${video}`);
  if (!existsSync(out) || statSync(out).size === 0) throw new CliError(`ffmpeg wrote no frame for ${t.toFixed(2)} s of ${video}`);
}

/** Writes a picture scaled to `width` as a JPEG (the same scaler video frames go through, so the two stay comparable). */
export async function scalePicture(src: string, width: number, out: string): Promise<void> {
  await must(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", `scale=${width}:-2`, "-q:v", "3", out], `scaling ${src}`);
}

/**
 * The filter that measures how different two inputs are, frame by frame: both are scaled to 480 px wide,
 * subtracted in RGB, averaged over 8x8 blocks, and the largest block average is printed (0 = identical, 255 = black against white).
 * Unlike a whole-frame score it stays sensitive to a small element that changed, and it ignores compression noise (below about 4).
 */
function differenceFilter(aspect: number): string {
  const size = `scale=480:${Math.round(480 / aspect / 8) * 8}`;
  return `[0:v]${size},format=gbrp[a];[1:v]${size},format=gbrp[b];[a][b]blend=all_mode=difference:shortest=1,format=gray,scale=iw/8:ih/8:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`;
}

/** Difference of every frame of two videos, up to the end of the shorter one (or of two pictures: one value). `aspect` is width / height. */
export async function differences(a: string, b: string, aspect: number): Promise<number[]> {
  const r = await must(["ffmpeg", "-loglevel", "error", "-i", a, "-i", b, "-lavfi", differenceFilter(aspect), "-f", "null", "-"], `comparing ${a} with ${b}`);
  const values = [...r.stdout.matchAll(/YMAX=([\d.]+)/g)].map((m) => Number(m[1]));
  if (!values.length) throw new CliError(`ffmpeg compared no frames of ${a} and ${b}`);
  return values;
}

/** Difference of two pictures, 0 (identical) to 255. */
export const difference = async (a: string, b: string, aspect: number) => (await differences(a, b, aspect))[0];

/** Runs `fn` over `items` with at most `limit` running at once, keeping order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
