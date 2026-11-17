#!/bin/sh
# Installs or updates beatclip: the command-line tool and its Claude Code skill.
#
#   curl -fsSL https://raw.githubusercontent.com/jozso39/beatclip/main/install.sh | sh
#
# Run from a clone (sh install.sh) it installs that clone instead of downloading one.
# BEATCLIP_HOME chooses where a download goes (default ~/.beatclip).
set -e

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "beatclip: $1 is missing. $2" >&2; exit 1; }
}
need git "Install git first."
need bun "Install Bun first: curl -fsSL https://bun.sh/install | bash"
need ffmpeg "Install ffmpeg first (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg)."
need ffprobe "It comes with ffmpeg; install ffmpeg first."

here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/src/cli.ts" ] && [ -d "$here/skills/beatclip" ]; then
  dir=$here
else
  dir=${BEATCLIP_HOME:-$HOME/.beatclip}
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --ff-only --quiet
  else
    git clone --quiet https://github.com/jozso39/beatclip.git "$dir"
  fi
fi

(cd "$dir" && bun install --silent && bun link >/dev/null)

# The skill is linked, not copied, so updating the clone updates the skill.
mkdir -p "$HOME/.claude/skills"
ln -sfn "$dir/skills/beatclip" "$HOME/.claude/skills/beatclip"

echo "beatclip installed from $dir"
echo "skill linked at $HOME/.claude/skills/beatclip"
if ! command -v beatclip >/dev/null 2>&1; then
  echo "beatclip is not on your PATH yet: add Bun's bin folder, e.g.  export PATH=\"\$HOME/.bun/bin:\$PATH\"" >&2
  exit 1
fi
echo "next: run 'beatclip doctor' in your video project (or 'beatclip init' to start a config)"
