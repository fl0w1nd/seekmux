#!/usr/bin/env bash
# Prints the release notes for a version: the image pull commands and the
# commits since the previous tag, grouped by type. Without a previous tag
# (the first release) every commit is listed.
# usage: release-notes.sh <version> [previous-tag] [ref]
set -euo pipefail

version="${1:?usage: release-notes.sh <version> [previous-tag] [ref]}"
previous="${2:-}"
ref="${3:-HEAD}"
image="ghcr.io/fl0w1nd/seekmux"

cat <<NOTES
Docker images for \`linux/amd64\` and \`linux/arm64\`:

\`\`\`bash
docker pull $image:$version
\`\`\`
NOTES

range="$ref"
[[ -z "$previous" ]] || range="$previous..$ref"

# Conventional Commit subjects, grouped; ci, build, chore, docs, test, style
# and merges stay out.
git log --no-merges --reverse --format='%h%x09%s' "$range" | awk -F'\t' '
  function add(group, text) { items[group] = items[group] "- " text "\n" }
  {
    subject = $2
    if (match(subject, /^[a-z]+(\([^)]*\))?!?: /)) {
      head = substr(subject, 1, RLENGTH - 2)
      type = head; sub(/[(!:].*/, "", type)
      text = substr(subject, RLENGTH + 1) " (" $1 ")"
      if (type == "feat") add("feat", text)
      else if (type == "fix") add("fix", text)
      else if (type == "perf") add("perf", text)
      else if (type == "refactor") add("refactor", text)
      else if (type !~ /^(ci|build|chore|docs|test|style|release)$/) add("other", subject " (" $1 ")")
    } else add("other", subject " (" $1 ")")
  }
  END {
    n = split("feat:Features|fix:Fixes|perf:Performance|refactor:Refactoring|other:Other changes", groups, "|")
    for (i = 1; i <= n; i++) {
      split(groups[i], g, ":")
      if (items[g[1]] != "") printf "\n### %s\n\n%s", g[2], items[g[1]]
    }
  }'
