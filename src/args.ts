import { CliError, parseTime } from "./time";

/** Flags that never take a value; everything else written as --name takes the next token. */
const SWITCHES = new Set([
  "json", "help", "next", "prev", "half", "beats", "full", "no-verify", "no-encode", "no-widen",
  "update-allow", "excerpt", "lowest", "highest", "all", "notes",
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

  /**
   * Fails on an option the command does not have (a typo would otherwise silently change what runs)
   * and on a single-valued option given twice. --json, --project and --help belong to every command.
   */
  allow(options: string[], repeatable: string[] = []) {
    for (const [name, values] of this.flags) {
      if (!["json", "project", "help", ...options, ...repeatable].includes(name)) throw new CliError(`unknown option --${name} (this command takes: ${[...options, ...repeatable].map((o) => `--${o}`).join(" ") || "no options"})`);
      if (values.length > 1 && !repeatable.includes(name)) throw new CliError(`--${name} was given ${values.length} times; it takes one value`);
    }
  }

  /** Fails when positional arguments are left that the command would ignore. */
  noMore() {
    if (this.rest.length) throw new CliError(`unexpected argument "${this.rest[0]}"`);
  }
}
