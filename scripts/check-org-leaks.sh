#!/usr/bin/env bash
# Organization-identifier leak check for this PUBLIC repo.
#
# Deploying organizations keep their identifier patterns (internal hostnames,
# team domains, project codenames, ...) OUT of the repo — committing the
# denylist would itself leak them. CI supplies patterns via the
# LEAK_DENYLIST_PATTERNS secret (newline-separated, case-insensitive extended
# regexes); locally you can export the same variable or point
# LEAK_DENYLIST_FILE at a private file outside the repo.
#
# Exits 1 if any tracked file matches any pattern. Skips cleanly when no
# patterns are configured (e.g. forks without the secret).
set -euo pipefail

patterns="${LEAK_DENYLIST_PATTERNS:-}"
if [ -z "$patterns" ] && [ -n "${LEAK_DENYLIST_FILE:-}" ] && [ -f "$LEAK_DENYLIST_FILE" ]; then
  patterns="$(cat "$LEAK_DENYLIST_FILE")"
fi

if [ -z "$patterns" ]; then
  echo "check-org-leaks: no denylist configured (LEAK_DENYLIST_PATTERNS unset) — skipping."
  exit 0
fi

status=0
while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  # Search tracked files only; never echo the pattern itself into public logs.
  if git grep -I -i -E -l -e "$pattern" -- . >/dev/null 2>&1; then
    echo "check-org-leaks: FAIL — a denylisted organization identifier appears in:"
    git grep -I -i -E -l -e "$pattern" -- . | sed 's/^/  - /'
    status=1
  fi
done <<< "$patterns"

if [ "$status" -eq 0 ]; then
  echo "check-org-leaks: clean."
fi
exit "$status"
