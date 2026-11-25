#!/usr/bin/env bash
# Fork-only: prints the release notes for fork release X.Y.Z-r.N as Markdown.
# Usage: scripts/fork-release-notes.sh <X.Y.Z-r.N> [target-ref] [owner/repo]
# Needs full history and the fork's release tags; fetches upstream base tags itself.
set -euo pipefail

version=$1
target=${2:-HEAD}
repo=${3:-cosmtrek/t3code}
upstream_url=https://github.com/pingdotgg/t3code
base=${version%-r.*}

ensure_upstream_tag() {
  git rev-parse -q --verify "refs/tags/v$1" >/dev/null ||
    git fetch -q --no-tags "$upstream_url.git" "refs/tags/v$1:refs/tags/v$1"
}

ensure_upstream_tag "$base"

previous=$(
  { git tag -l 'v*-r.*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+-r\.[0-9]+$' || true; } |
    grep -vx "$version" | { cat; echo "$version"; } | sort -V |
    grep -B1 -x "$version" | grep -vx "$version" || true
)

# Fork-internal docs and CI are not changes to the shipped build.
log_patches() {
  git log --no-merges --format='- %s (%h)' "$@" | { grep -vE '^- [a-z]+\(fork\)!?:' || true; }
}

if [[ -n $previous ]]; then
  previous_base=${previous%-r.*}
  ensure_upstream_tag "$previous_base"
  # Rebased patches that did not change drop out by patch-id; upstream history is excluded.
  changes=$(log_patches --cherry-pick --right-only "v$previous...$target" "^v$base" "^v$previous_base")
  echo "## Fork changes since $previous"
else
  previous_base=""
  changes=$(log_patches "v$base..$target")
  echo "## Fork patches"
fi
echo
echo "${changes:-No fork changes.}"
echo
echo "## Upstream"
echo
if [[ -n $previous_base && $previous_base != "$base" ]]; then
  echo "Rebased from upstream $previous_base onto [$base]($upstream_url/releases/tag/v$base)" \
    "([changes]($upstream_url/compare/v$previous_base...v$base))."
else
  echo "Based on upstream [$base]($upstream_url/releases/tag/v$base)."
fi
echo
echo "## Install"
echo
echo '```bash'
echo "T3CODE_RELEASE_BASE_URL=https://github.com/$repo/releases/download t3 update $version"
echo '```'
