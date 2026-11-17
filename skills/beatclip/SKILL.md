---
name: beatclip
description: >-
  Edit a code-rendered music video (a web page that draws every frame from the song time, screenshotted
  frame by frame) from timestamped notes, using the `beatclip` command-line tool. Use it whenever the
  user gives notes with times ("at 1:07 the ball should land on the beat", "the word comes too early at
  0:42"), asks what is on screen at a time or on which beat something falls, wants stills, contact
  sheets or a before/after comparison with the previous draft, asks to render or re-render the video or
  one shot, asks what changed between two drafts, wants a report of the changes made, or asks whether
  the lyrics are in sync. Also for setting beatclip up in a new video project. Covers installing the
  tool, the config file, the page hooks, every command, and the working routine for a round of notes.
---

# beatclip

`beatclip` is a command-line tool for videos that a web page draws frame by frame from the song time `t`.
It turns "1:07" into a shot, a source file, a lyric word and a beat; shows frames from the live page or
from a rendered file, alone or beside another draft; re-renders only what changed; keeps a ledger of the
user's notes with proof frames; and tells which parts of two drafts differ.

## 1. Make sure it is installed

```bash
command -v beatclip || curl -fsSL https://raw.githubusercontent.com/jozso39/beatclip/main/install.sh | sh
```

The installer needs `git`, [Bun](https://bun.sh) and `ffmpeg` and tells you which one is missing. It clones
to `~/.beatclip`, puts `beatclip` on the PATH and links this skill into `~/.claude/skills/beatclip`.
Running it again updates both. Google Chrome must be installed (the tool drives it headless).

Then, in the video project:

```bash
beatclip doctor
```

`doctor` checks the machine (Bun, ffmpeg, Chrome) and the project (config, audio, lyrics, beat grid, the
page and each hook) and prints one line per check with what to do about a failure. Do not go on while it
prints `FAIL`. Run every beatclip command from the project folder (it finds `beatclip.config.json` there
or in a parent folder) or pass `--project <folder>`.

## 2. Setting up a project that has no config yet

Skip this when `beatclip doctor` already says `ready`.

1. `beatclip init --url <the page's render URL>` writes a starter `beatclip.config.json`.
2. The page must expose four things on `window` (names can be changed in the config):

   | Hook | Meaning |
   | --- | --- |
   | `__seek(t)` | draw the frame of time `t` in seconds; may return a promise; the picture must depend on `t` only |
   | `__duration` | length of the video in seconds |
   | `__ready` | `true` once fonts, images and the hooks are in place |
   | `__shots` | `[{ id, s }]`, every shot with its start time; a shot ends where the next starts |

3. Fill in the config. Paths are relative to the config file.

   | Key | Meaning |
   | --- | --- |
   | `page.url`, `page.width`, `page.height` | the page and its frame size |
   | `page.shots` | name of the shot hook; or list `"shots": [{ "id", "s" }]` in the config instead |
   | `page.start` | optional command that starts the page's server when the URL does not answer; must stay in the foreground |
   | `fps` | frames per second (default 60) |
   | `audio` | the song (muxed into renders) |
   | `lyrics` | JSON: `lines: [{ id, text, s, e, words: [{ w, s, e }] }]`, optional `shouts: [{ id, s, e, letters: [{ c, s, e }] }]` |
   | `sources` | globs of every file the picture depends on. Important: this is how a render notices that the code changed under it |
   | `cues` | named moments `[{ "name", "t" }]` |
   | `beats` | `{ "first", "interval", "perBar" }` for a constant tempo, or `{ "file" }` from `beatclip analyze beats` |
   | `out.video` | name of renders; `{n}` becomes the first free number, e.g. `out/draft-{n}.mp4` |
   | `check.selector` | CSS selector of a lyric word's element with `{line}` and `{word}` placeholders |
   | `differs` | from which difference (0..255) two frames count as different (default 10) |

4. For the lyric sync check each word needs an element the selector can find (for example
   `<span class="lw" data-word="v1:3">`). For probes mark an element with `data-probe="<name>"`.
5. Add `out/` and `.beatclip/` to `.gitignore`, then run `beatclip doctor` again.

`beatclip docs` prints the full manual with an example of every command.

## 3. Ground rules

- **Never convert times, beats or shots by hand.** Ask `at`, `find` or `beat`.
- **Times** are written `1:07`, `1:07.5` or `67.5` everywhere. A lyric word is `<line id>.<index from 0>`
  (`v2.3`). Beats count from 0; `7.5` is the half beat after beat 7.
- **Add `--json`** when you will read the output with code. Errors exit 1 and say what to change; an
  unknown option or a leftover argument is an error, never silently ignored.
- **A printed path is a fresh file.** Sheets, proofs and videos get a new name every time. If a command
  fails, nothing was written: fix the cause, do not fall back to an older picture.
- **Look at what you produce.** Open the sheet or proof (Read the image) before saying what it shows.
- **"Done" needs a picture.** A note is done when its after-frame shows the change and `diff` shows a
  difference at that time. `LOOKS UNCHANGED` or `NO DIFFERENCE` means the change does not read: not done.
- **Do not edit source files while a render is running** unless you mean to: the render notices and
  shoots the affected ranges again, which costs time.

## 4. The routine for a round of notes

```bash
# 1. Record every note first, in the user's own words (add --to <time> when it covers a stretch)
beatclip notes add 1:07 "the ball should land on the beat"

# 2. Find out what each note is about: shot, source file and line, lyric word, beat
beatclip at 1:07

# 3. Keep the frame as it is now, from the last draft
beatclip notes proof 1 before --video out/draft-3.mp4

# 4. Edit the scene. Then check the change reads, live page beside the last draft
beatclip frames --shot bounce --compare out/draft-3.mp4
beatclip render --shot bounce --excerpt          # a few seconds: only that shot, as a clip with sound

# 5. When all notes are in, render what they cover and encode the whole video
beatclip render --notes

# 6. Prove each note on the new draft and say what the frame shows
beatclip notes proof 1 after --video out/draft-4.mp4
beatclip notes set 1 done --shows "the ball touches the floor line exactly on beat 134"

# 7. Did anything change that no note covers? Is any done note invisible?
beatclip diff out/draft-3.mp4 out/draft-4.mp4

# 8. Lyrics still in sync? Must read "0 new problems"
beatclip check

# 9. The table to give the user: change, time in the video, what the frame shows, proof
beatclip notes report
```

Statuses are `open`, `done`, `verified` (the user confirmed it) and `rejected` (deliberately not done).

## 5. Commands

### Where am I

| Command | Gives |
| --- | --- |
| `beatclip at <time>` | shot (id, start–end, `file:line` of its definition), lyric line and word, nearest cue, beat number and phase |
| `beatclip find <text>` | times of lyric words or runs of words, lines, cues and shots matching the text |
| `beatclip beat <time>` | the nearest beat; `--next` / `--prev`; `--half` for the half-beat grid; `+N` / `-N` to move by beats; `beatclip beat --n 134` for the time of a beat number |
| `beatclip analyze beats [audio]` | for a song without constant tempo: a beat-times file via librosa (`--python <path>`, `--out <file>`); also prints the best constant grid and its worst error |

### Frames

`beatclip frames` writes labelled contact sheets to `out/sheets/` and prints their paths. Each tile shows
its time, shot and the lyric word being sung.

| Which frames | Example |
| --- | --- |
| explicit times | `beatclip frames 1:07 1:07.5 1:08` |
| a range | `beatclip frames --from 1:05 --to 1:09 --every 0.25` (or `--count 12`) |
| a shot | `beatclip frames --shot bounce` |
| around a lyric word | `beatclip frames --word v2.3 --window 0.3` |
| on beats | `beatclip frames --shot bounce --beats` (add `--half`) |

| Source | Option |
| --- | --- |
| the live page (default) | none |
| a rendered file | `--video out/draft-4.mp4` |
| two side by side | add `--compare out/draft-3.mp4`; every label ends with `diff <n>`, marked `≠` when the two differ |

Other options: `--cols`, `--rows` (per sheet), `--width` (tile width, default 480), `--out <file.png>`.

### Render

| Command | Does |
| --- | --- |
| `beatclip render` | full render into the frame cache (`out/cache/frames`), then encodes |
| `beatclip render --from 1:05 --to 1:09` | re-shoots that range, encodes the whole video from the cache (repeatable) |
| `beatclip render --shot <id>` | the range of a shot (repeatable) |
| `beatclip render --note <id>` / `--notes` | the range of one note / of all open and done notes |
| `... --excerpt` | encodes only the re-shot stretch as its own clip: the fast way to look at one shot |
| `... --no-encode` | only updates the cache |

After a partial shoot it re-shoots sample frames outside the range and compares them with the cache. If
they differ it names the times, widens by whole shots, and shoots everything if that is not enough: read
those lines, they tell you the change reached further than you asked. It prints how long screenshots,
check and encode took. Only one render per project can run at a time. Do not delete `out/cache/frames`:
partial renders need it. `--full` forces a full render; `--no-verify` and `--no-widen` change the check.

### Notes ledger

| Command | Does |
| --- | --- |
| `beatclip notes add <time> "<text>" [--to <time>]` | adds a note, prints its id and where it lands |
| `beatclip notes list [--status open]` | the ledger |
| `beatclip notes proof <id> before\|after [--video <file>] [--at <time>]` | saves a frame at the note's time (live page without `--video`); with both sides present it prints their difference |
| `beatclip notes set <id> [status] [--shows "<what the frame shows>"] [--text ..] [--to <time>\|none]` | updates a note |
| `beatclip notes remove <id>` | deletes a note |
| `beatclip notes report [--out report.md]` | the Markdown table of all notes |

### Comparing drafts

`beatclip diff <a.mp4> <b.mp4>` lists the time ranges where the drafts differ, each with its shots and
the notes that account for it, or `NO NOTE`. It also names notes marked done where nothing differs.
`--threshold` and `--gap` tune it. To look at a range, use the `frames --compare` line it prints.

### Checks

| Command | Does |
| --- | --- |
| `beatclip check` | every lyric word must be hidden 0.15 s before its first sound, visible at it and inside the frame; plus the probe rules of the config. Exit 1 only for problems not in the allowlist |
| `beatclip check --all` | also prints the known exceptions |
| `beatclip check --update-allow` | accepts the current problems as known exceptions. Only after the user agreed they are fine |
| `beatclip probe <name> <times..>` | the box of the `data-probe` element (or `--selector <css>`) at those times |
| `beatclip probe <name> --from <t> --to <t> --lowest` | its lowest points (or `--highest`) and how far each is from a beat (`--half`) |

Probe rules go in the config under `check.probes`, for example
`{ "probe": "ball", "assert": "lowest-on-beat", "from": 3, "to": 6 }`. Asserts: `lowest-on-beat`,
`highest-on-beat` (optional `half`, `tolerance`), `no-overlap` (`"with": "words"` or another probe).

## 6. When something goes wrong

| What you see | What to do |
| --- | --- |
| `the page does not answer at ...` | start the project's dev server, or set `page.start` in the config |
| `window.__ready did not become true` | open the page in a browser; a script error is stopping it |
| `render: ... changed during the shoot` / `a source file changed while rendering` | someone edited a source; the render is shooting again by itself. Wait |
| `another beatclip render is using this frame cache` | a render is already running for this project; wait for it |
| `doing a full render instead of the partial one` | the cache was missing, incomplete or made with other settings; the reason is printed |
| `frames outside ... no longer match the cache` | the change reaches beyond the range you asked for; the render widens by itself |
| `paint differently depending on what was drawn before` | the page is not a pure function of time at those frames; mention it to the user, it is a defect of the scene |
| `already exists; choose another --out` | renders never overwrite; use a name with `{n}` or omit `--out` |
| a `diff` value just under 10 where you expected a change | a small element moved slightly; look with `frames --compare`, lower `--threshold` if needed |
