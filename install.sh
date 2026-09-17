#!/bin/sh
# Pantograph: install the figma-transpose and figma-review-page skills into a coding harness.
#
#   ./install.sh [--harness claude|codex|cursor|grok|project|all] [--copy] [--target DIR] [--uninstall]
#
# Default harness is claude. Default mode is symlink, so pulling this repo updates
# the installed skills in place. --copy writes independent copies instead.
set -eu

REPO=$(cd "$(dirname "$0")" && pwd)
SKILLS="figma-transpose figma-review-page"

harness=claude
mode=symlink
target=""
action=install

usage() {
  cat <<'USAGE'
Pantograph installer.

usage: install.sh [--harness claude|codex|cursor|grok|project|all] [--copy] [--target DIR] [--uninstall]

  --harness claude    ~/.claude/skills/<skill>              (default)
  --harness codex     ~/.agents/skills/<skill>
  --harness cursor    ~/.cursor/skills/<skill>
  --harness grok      ~/.grok/skills/<skill>
  --harness project   <--target DIR or $PWD>/.claude/skills/<skill>
  --harness all       claude and codex, plus project when --target is given.
                      Cursor and Grok Build also read those two folders, so
                      "all" does not link the skills a second time for them.
  --copy              copy the skill directories instead of symlinking
  --target DIR        project root for --harness project
  --uninstall         remove symlinks this script created (copies are left alone)

Skills live in skills/ and keep their own names: figma-transpose, figma-review-page.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --harness) harness="${2:-}"; [ -n "$harness" ] || { usage; exit 2; }; shift 2 ;;
    --harness=*) harness="${1#*=}"; shift ;;
    --copy) mode=copy; shift ;;
    --target) target="${2:-}"; [ -n "$target" ] || { usage; exit 2; }; shift 2 ;;
    --target=*) target="${1#*=}"; shift ;;
    --uninstall) action=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

case "$harness" in
  claude|codex|cursor|grok|project|all) ;;
  *) echo "unknown harness: $harness" >&2; usage; exit 2 ;;
esac

# Print the skills root for one harness, or nothing when it does not apply.
root_for() {
  case "$1" in
    claude) printf '%s/.claude/skills\n' "$HOME" ;;
    codex)  printf '%s/.agents/skills\n' "$HOME" ;;
    cursor) printf '%s/.cursor/skills\n' "$HOME" ;;
    grok)   printf '%s/.grok/skills\n' "$HOME" ;;
    project)
      base="${target:-$PWD}"
      base=$(cd "$base" 2>/dev/null && pwd) || { echo "no such directory: ${target:-$PWD}" >&2; exit 1; }
      if [ -z "$target" ] && [ "$base" = "$REPO" ]; then
        echo "skipping project harness: \$PWD is the Pantograph repo; pass --target DIR" >&2
        return 0
      fi
      printf '%s/.claude/skills\n' "$base" ;;
  esac
}

harnesses="$harness"
[ "$harness" = all ] && harnesses="claude codex project"

install_one() {
  root="$1"; skill="$2"
  src="$REPO/skills/$skill"
  dest="$root/$skill"
  mkdir -p "$root"
  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      echo "  ok      $dest -> already linked to Pantograph"
      return 0
    fi
    echo "  replace $dest (symlink elsewhere)"
    rm "$dest"
  elif [ -e "$dest" ]; then
    backup="$dest.bak-$(date +%s)"
    mv "$dest" "$backup"
    echo "  backup  $dest -> $backup"
  fi
  if [ "$mode" = copy ]; then
    cp -R "$src" "$dest"
    echo "  copied  $dest"
  else
    ln -s "$src" "$dest"
    echo "  linked  $dest -> $src"
  fi
}

uninstall_one() {
  root="$1"; skill="$2"
  src="$REPO/skills/$skill"
  dest="$root/$skill"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    rm "$dest"
    echo "  removed $dest"
  elif [ -e "$dest" ]; then
    echo "  kept    $dest (not a symlink into Pantograph)"
  else
    echo "  absent  $dest"
  fi
}

for h in $harnesses; do
  root=$(root_for "$h") || exit 1
  [ -n "$root" ] || continue
  echo "pantograph -> $h: $root"
  for skill in $SKILLS; do
    if [ "$action" = uninstall ]; then
      uninstall_one "$root" "$skill"
    else
      install_one "$root" "$skill"
    fi
  done
done
