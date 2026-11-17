import { describe as group, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Args } from "../src/args";
import { beat, find } from "../src/commands/lookup";
import type { Config } from "../src/config";
import { constantGrid, describe, listGrid, loadLines, nearestBeat, type Project } from "../src/project";
import { fmtTime, parseTime } from "../src/time";

/** The demo project without its page: lyrics from the file, shots and beat grid as scene.js defines them. */
export function demoProject(): Project {
  const lines = loadLines(resolve(import.meta.dir, "../demo/lyrics.json"));
  const starts = [["intro", 0], ["bounce", 3], ["grow", 6], ["finale", 9]] as const;
  return {
    cfg: {} as Config,
    fps: 30,
    duration: 12,
    lines,
    words: lines.flatMap((l) => l.words),
    shots: starts.map(([id, s], i) => ({ id, s, e: starts[i + 1]?.[1] ?? 12 })),
    cues: [{ name: "ball first lands", t: 3.5 }, { name: "bar full", t: 8.5 }],
    grid: { ...constantGrid(0.5, 0.5), perBar: 4 },
  };
}

group("times", () => {
  test("every accepted spelling", () => {
    expect(parseTime("1:07")).toBe(67);
    expect(parseTime("1:07.5")).toBe(67.5);
    expect(parseTime("67.5")).toBe(67.5);
    expect(parseTime("1:02:03.25")).toBe(3723.25);
  });
  test("rejects what is not a time", () => {
    for (const bad of ["", "abc", "1:75", "-3", "1:", "1:07s"]) expect(() => parseTime(bad)).toThrow();
  });
  test("formats minutes and carries rounding", () => {
    expect(fmtTime(67.5)).toBe("1:07.50");
    expect(fmtTime(59.999)).toBe("1:00.00");
    expect(fmtTime(5, 0)).toBe("0:05");
  });
});

group("arguments", () => {
  test("values, switches, repeats and beat offsets", () => {
    const a = new Args(["beat", "1:07", "--half", "-2", "--from", "1", "--from", "2"]);
    expect(a.rest).toEqual(["beat", "1:07", "-2"]);
    expect(a.has("half")).toBe(true);
    expect(a.all("from")).toEqual(["1", "2"]);
    expect(a.time("from")).toBe(2);
  });
  test("a flag without its value is an error", () => {
    expect(() => new Args(["--from"])).toThrow();
    expect(() => new Args(["--every", "x"]).num("every")).toThrow();
  });
});

group("beat grids", () => {
  test("constant grid", () => {
    const g = constantGrid(0.25, 0.5);
    expect(g.time(134)).toBe(67.25);
    expect(g.pos(67.25)).toBe(134);
    expect(nearestBeat(g, 67.1)).toEqual({ n: 134, t: 67.25, delta: -0.15 });
    expect(nearestBeat(g, 67.05, true).n).toBe(133.5);
  });
  test("measured beats interpolate and continue past both ends", () => {
    const g = listGrid([1, 2, 4, 5]);
    expect(g.pos(3)).toBe(1.5);
    expect(g.time(1.5)).toBe(3);
    expect(g.time(4)).toBe(6);
    expect(g.pos(0)).toBe(-1);
    expect(g.time(g.pos(4.3))).toBeCloseTo(4.3);
  });
});

group("lookups on the demo project", () => {
  const p = demoProject();
  test("at a time inside a word", () => {
    const m = describe(p, 4.2);
    expect(m.shot?.id).toBe("bounce");
    expect(m.shot?.into).toBe(1.2);
    expect(m.word?.key).toBe("a2.1");
    expect(m.word?.w).toBe("ball");
    expect(m.line?.id).toBe("a2");
    expect(m.cue).toEqual({ name: "ball first lands", t: 3.5, delta: 0.7 });
    expect(m.beat).toEqual({ index: 7, phase: 0.4, bar: 2, inBar: 4, nearest: { n: 7, t: 4, delta: 0.2 } });
    expect(m.frame).toBe(126);
  });
  test("between two lines it names the last and the next word", () => {
    const m = describe(p, 3);
    expect(m.word).toBeNull();
    expect(m.prevWord?.key).toBe("a1.3");
    expect(m.prevWord?.ago).toBe(0.5);
    expect(m.nextWord?.key).toBe("a2.0");
    expect(m.nextWord?.in).toBe(0.5);
  });
  test("find words, runs of words, cues and shots", () => {
    const hits = (q: string) => (find(p, new Args(q.split(" "))).data as { kind: string; id: string; t: number }[]).map((h) => `${h.kind}:${h.id}@${h.t}`);
    expect(hits("ball")).toEqual(["cue:ball first lands@3.5", "word:a2.1@4"]);
    expect(hits("grows wide")).toEqual(["line:a3@6.5", "word:a3.2@7.5"]);
    expect(hits("finale")).toEqual(["shot:finale@9"]);
    expect(hits("a4")).toEqual(["line:a4@9.5"]);
    expect(hits("zebra")).toEqual([]);
  });
  test("beat: nearest, next, previous, half beats and offsets", () => {
    const at = (...argv: string[]) => (beat(p, new Args(argv)).data as { n: number; t: number });
    expect(at("4.2")).toMatchObject({ n: 7, t: 4 });
    expect(at("4.2", "--next")).toMatchObject({ n: 8, t: 4.5 });
    expect(at("4.2", "--prev")).toMatchObject({ n: 7, t: 4 });
    expect(at("4", "--next")).toMatchObject({ n: 8, t: 4.5 });
    expect(at("4", "--prev")).toMatchObject({ n: 6, t: 3.5 });
    expect(at("4.2", "--next", "--half")).toMatchObject({ n: 7.5, t: 4.25 });
    expect(at("4.2", "+4")).toMatchObject({ n: 11, t: 6 });
    expect(at("4.2", "--prev", "-2")).toMatchObject({ n: 5, t: 3 });
    expect(at("--n", "8")).toMatchObject({ n: 8, t: 4.5 });
  });
});
