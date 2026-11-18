import { renameSync, writeFileSync } from "node:fs";

/** Writes a file through a temporary one next to it, so an interrupted write cannot leave half a file. */
export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
