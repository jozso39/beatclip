import { CliError, parseTime } from "./time";

/** Flags that never take a value; everything else written as --name takes the next token. */
const SWITCHES = new Set([
  "json", "help", "next", "prev", "half", "beats", "full", "no-verify", "no-encode", "no-widen",
  "update-allow", "excerpt", "lowest", "highest", "all",
]);

export class Args {
  readonly rest: string[] = [];
  private flags = new Map<string, string[]>();

  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith("--")) {
        this.rest.push(a);
        continue;
      }
      const name = a.slice(2);
      const values = this.flags.get(name) ?? [];
      if (SWITCHES.has(name)) values.push("true");
      else if (i + 1 >= argv.length) throw new CliError(`--${name} needs a value`);
      else values.push(argv[++i]);
      this.flags.set(name, values);
    }
  }

  has = (name: string) => this.flags.has(name);
  /** Every value given for a repeatable flag. */
  all = (name: string) => this.flags.get(name) ?? [];
  str = (name: string) => this.flags.get(name)?.at(-1);

  num(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (v.trim() === "" || !Number.isFinite(Number(v))) throw new CliError(`--${name} must be a number, got "${v}"`);
    return Number(v);
  }

  time(name: string): number | undefined {
    const v = this.str(name);
    return v === undefined ? undefined : parseTime(v);
  }

  /** Takes the next positional argument, or fails with what was expected. */
  take(what: string): string {
    const v = this.rest.shift();
    if (v === undefined) throw new CliError(`missing ${what}`);
    return v;
  }
}
