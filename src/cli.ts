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
  beatclip render [--from t --to t] [--shot id] [--notes] [--changed] [--excerpt]   full or partial render via the frame cache
  beatclip notes add|list|set|proof|report  the ledger of change notes
  beatclip diff <a.mp4> <b.mp4>             time ranges where two drafts differ, and which no note explains
  beatclip check [--update-allow]           lyric-word sync check and probe rules
  beatclip probe <name> [times..]           the box of a data-probe element over time

  beatclip doctor                           check this machine and this project, and say how to fix what is missing
  beatclip init [--url <page>]              write a starter beatclip.config.json here
  beatclip docs                             the full manual

Times are written 1:07, 1:07.5 or 67.5. Every command takes --json, --project <folder with beatclip.config.json>
and --profile <name> (a set of overrides under "profiles" in the config, with its own frame cache).`;

async function main(argv: string[]): Promise<Result> {
  const args = new Args(argv);
  const command = args.rest.shift();
  if (!command || command === "help" || args.has("help")) return { data: { help: HELP }, text: HELP };
  const cwd = process.cwd();
  const explicit = args.str("project") ?? process.env.BEATCLIP_PROJECT;
  const config = (): Config => loadConfig(findConfig(explicit, cwd), args.str("profile") ?? process.env.BEATCLIP_PROFILE);
  const project = () => loadProject(config());

  switch (command) {
    case "doctor":
      return (await import("./commands/setup")).doctor(args, cwd, explicit);
    case "init":
      return (await import("./commands/setup")).init(args, cwd);
    case "docs":
      return (await import("./commands/setup")).docs();
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
    case "render":
      return (await import("./commands/render")).render(await project(), args, cwd);
    case "notes":
      return (await import("./commands/notes")).notes(await project(), args, cwd);
    case "diff":
      return (await import("./commands/diff")).diff(await project(), args, cwd);
    case "check":
      return (await import("./commands/check")).check(await project(), args);
    case "probe":
      return (await import("./commands/check")).probe(await project(), args);
    default:
      throw new CliError(`unknown command "${command}"\n\n${HELP}`);
  }
}

const json = process.argv.includes("--json");
try {
  const result = await main(process.argv.slice(2));
  console.log(json ? JSON.stringify(result.data, null, 1) : result.text);
  process.exitCode = result.exit ?? 0;
} catch (e) {
  const known = e instanceof CliError;
  const message = known ? e.message : ((e as Error).stack ?? String(e));
  if (json) console.log(JSON.stringify({ error: (e as Error).message }));
  console.error(`beatclip: ${message}`);
  process.exit(known ? 1 : 2);
}
