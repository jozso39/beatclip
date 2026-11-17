#!/usr/bin/env bun
import { Args } from "./args";
import { findConfig, loadConfig, type Config } from "./config";
import { loadProject } from "./project";
import { CliError } from "./time";
import type { Result } from "./commands/lookup";

const HELP = `beatclip: edit code-rendered music videos from timestamped notes

  beatclip at <time>                        what is on at a time: shot, lyric line and word, cue, beat
  beatclip find <text>                      times of lyric words, lines, cues and shots matching a text
  beatclip beat <time> [--next|--prev] [--half] [+N|-N]      the time of a beat (or: beat --n <number>)
  beatclip analyze beats <audio>            write a beat-times file with librosa (optional, needs Python)
  beatclip frames [times..] [--from --to --every] [--shot id] [--word line.n --window s] [--beats]
                    [--video a.mp4] [--compare b.mp4]          labelled contact sheets, live page or rendered file

Times are written 1:07, 1:07.5 or 67.5. Every command takes --json and --project <folder with beatclip.config.json>.`;

async function main(argv: string[]): Promise<Result> {
  const args = new Args(argv);
  const command = args.rest.shift();
  if (!command || command === "help" || args.has("help")) return { data: { help: HELP }, text: HELP };
  const cwd = process.cwd();
  const explicit = args.str("project") ?? process.env.BEATCLIP_PROJECT;
  const config = (): Config => loadConfig(findConfig(explicit, cwd));
  const project = () => loadProject(config());

  switch (command) {
    case "at":
      return (await import("./commands/lookup")).at(await project(), args);
    case "find":
      return (await import("./commands/lookup")).find(await project(), args);
    case "beat":
      return (await import("./commands/lookup")).beat(await project(), args);
    case "analyze": {
      let cfg: Config | null = null;
      try {
        cfg = config();
      } catch (e) {
        if (explicit) throw e;
      }
      return (await import("./commands/analyze")).analyze(cfg, args, cwd);
    }
    case "frames":
      return (await import("./commands/frames")).frames(await project(), args, cwd);
    default:
      throw new CliError(`unknown command "${command}"\n\n${HELP}`);
  }
}

const json = process.argv.includes("--json");
try {
  const result = await main(process.argv.slice(2));
  console.log(json ? JSON.stringify(result.data, null, 1) : result.text);
} catch (e) {
  const known = e instanceof CliError;
  const message = known ? e.message : ((e as Error).stack ?? String(e));
  if (json) console.log(JSON.stringify({ error: (e as Error).message }));
  console.error(`beatclip: ${message}`);
  process.exit(known ? 1 : 2);
}
