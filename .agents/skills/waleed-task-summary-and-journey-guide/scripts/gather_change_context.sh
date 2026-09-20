#!/usr/bin/env bash
# Collect the evidence needed to explain a code change to a non-technical reader.
#
#   gather_change_context.sh              # what recently landed on the main branch
#   gather_change_context.sh 69           # pull request #69
#   gather_change_context.sh abc123..def456   # an explicit commit range
#   gather_change_context.sh feat/my-branch   # a branch, compared against the main branch
#
# Prints a structured evidence pack. Everything degrades gracefully: no `gh`, no remote, or a
# detached repo still yields whatever git alone can answer. Nothing here writes or pushes.

set -uo pipefail

SUBJECT="${1:-}"
LIMIT="${GATHER_LIMIT:-15}"

section() { printf '\n========== %s ==========\n' "$1"; }
note()    { printf '  (%s)\n' "$1"; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a git repository. Explain from the working tree and the conversation instead."
  exit 0
fi

# The main branch is not always called main.
MAIN_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
if [ -z "$MAIN_BRANCH" ]; then
  for candidate in main master trunk; do
    if git show-ref --verify --quiet "refs/remotes/origin/$candidate"; then MAIN_BRANCH="$candidate"; break; fi
  done
fi
MAIN_BRANCH="${MAIN_BRANCH:-main}"

HAS_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then HAS_GH=1; fi

section "SUBJECT"
if [ -z "$SUBJECT" ]; then
  echo "Recent merges into $MAIN_BRANCH"
elif printf '%s' "$SUBJECT" | grep -Eq '^[0-9]+$'; then
  echo "Pull request #$SUBJECT"
elif printf '%s' "$SUBJECT" | grep -q '\.\.'; then
  echo "Commit range $SUBJECT"
else
  echo "Branch $SUBJECT (compared against $MAIN_BRANCH)"
fi
echo "Main branch: $MAIN_BRANCH"
echo "gh available: $([ "$HAS_GH" -eq 1 ] && echo yes || echo 'no — PR metadata and review threads will be missing')"

# ---------------------------------------------------------------- resolve a diff range
RANGE=""
if [ -z "$SUBJECT" ]; then
  section "RECENT MERGES INTO $MAIN_BRANCH"
  git log --oneline --merges -n "$LIMIT" "origin/$MAIN_BRANCH" 2>/dev/null \
    || git log --oneline --merges -n "$LIMIT" 2>/dev/null \
    || note "no merge commits found"
  section "RECENT COMMITS"
  git log --oneline -n "$LIMIT" "origin/$MAIN_BRANCH" 2>/dev/null || git log --oneline -n "$LIMIT"
  LAST_MERGE="$(git log --merges -n 1 --format=%H "origin/$MAIN_BRANCH" 2>/dev/null)"
  [ -n "$LAST_MERGE" ] && RANGE="$LAST_MERGE^1..$LAST_MERGE"

elif printf '%s' "$SUBJECT" | grep -Eq '^[0-9]+$'; then
  if [ "$HAS_GH" -eq 1 ]; then
    section "PULL REQUEST #$SUBJECT"
    gh pr view "$SUBJECT" --json number,title,state,mergedAt,mergeCommit,headRefName,baseRefName,additions,deletions,changedFiles \
      --template '{{.number}} · {{.title}}
state: {{.state}}   merged: {{.mergedAt}}
head: {{.headRefName}} → base: {{.baseRefName}}
{{.changedFiles}} files, +{{.additions}} / -{{.deletions}}
' 2>/dev/null || note "could not read PR metadata"

    section "PR DESCRIPTION (states intent — trust the file list over this)"
    gh pr view "$SUBJECT" --json body --jq '.body' 2>/dev/null | head -60 || note "no body"

    section "REVIEW THREADS (fixed / declined / deferred)"
    gh api "repos/{owner}/{repo}/pulls/$SUBJECT/comments" \
      --jq '.[] | "--- \(.user.login) @ \(.path):\(.line // .original_line)\n\(.body)\n"' 2>/dev/null \
      | head -120 || note "no inline review comments"

    MERGE_SHA="$(gh pr view "$SUBJECT" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null)"
    BASE_REF="$(gh pr view "$SUBJECT" --json baseRefName --jq '.baseRefName' 2>/dev/null)"
    if [ -n "$MERGE_SHA" ] && [ "$MERGE_SHA" != "null" ]; then
      git cat-file -e "$MERGE_SHA" 2>/dev/null && RANGE="$MERGE_SHA^1..$MERGE_SHA"
    fi
    [ -z "$RANGE" ] && [ -n "$BASE_REF" ] && RANGE="origin/$BASE_REF...$(gh pr view "$SUBJECT" --json headRefName --jq '.headRefName' 2>/dev/null)"
  else
    note "gh unavailable — cannot resolve PR #$SUBJECT; pass a commit range instead"
  fi

elif printf '%s' "$SUBJECT" | grep -q '\.\.'; then
  RANGE="$SUBJECT"
else
  RANGE="origin/$MAIN_BRANCH...$SUBJECT"
fi

# ---------------------------------------------------------------- the diff itself
if [ -n "$RANGE" ]; then
  section "CHANGED FILES  [range: $RANGE]"
  echo "Read this BEFORE the PR description. Descriptions state intent; this states fact."
  echo
  git diff --stat "$RANGE" 2>/dev/null || note "could not diff $RANGE"

  section "CHANGED FILES BY STATUS  (A=added M=modified D=deleted R=renamed)"
  git diff --name-status "$RANGE" 2>/dev/null || true

  section "LIKELY USER-VISIBLE FILES"
  echo "Pages, screens, routes and components — these are where a journey can start."
  git diff --name-only "$RANGE" 2>/dev/null \
    | grep -Ei '(pages|views|screens|routes|components)/' \
    | grep -Ev '(__tests__|\.test\.|\.spec\.)' \
    || note "none — this change is probably behavioural or internal, so do not invent clicks"

  section "TEST AND INTERNAL FILES  (changed, but invisible to the reader)"
  git diff --name-only "$RANGE" 2>/dev/null \
    | grep -Ei '(__tests__|\.test\.|\.spec\.|\.d\.ts$|^docs/|\.md$|lock)' \
    || note "none"

  section "CHANGED USER-FACING STRINGS  (button labels, headings, messages)"
  echo "Take control names for the journey from here — never from memory."
  echo "Test files are excluded: their titles and fixtures are not labels any user sees."
  echo
  UI_FILES="$(git diff --name-only "$RANGE" 2>/dev/null \
    | grep -Ei '\.(tsx|jsx|vue|svelte|html)$' \
    | grep -Ev '(__tests__|\.test\.|\.spec\.)')"
  if [ -n "$UI_FILES" ]; then
    # shellcheck disable=SC2086
    # Three shapes, because JSX puts label text in three places: a quoted prop or
    # message, text between tags on one line, and — for a multi-line element — text
    # alone on its own line. Missing the third shape loses exactly the primary action
    # buttons, which are the ones a journey most needs to name.
    # shellcheck disable=SC2086
    ADDED="$(git diff "$RANGE" -- $UI_FILES 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+')"
    {
      printf '%s\n' "$ADDED" | grep -oE '"[A-Z][^"]{3,60}"'
      printf '%s\n' "$ADDED" | grep -oE '>[A-Z][a-z][^<>{}]{3,60}<' | sed 's/^>//; s/<$//'
      printf '%s\n' "$ADDED" | sed 's/^+[[:space:]]*//' \
        | grep -E "^[A-Z][A-Za-z0-9 ,'’&?.-]{3,60}$" \
        | grep -vE '[,;]$' \
        | grep -vE '^[A-Za-z]+[A-Z][A-Za-z]*$'   # drops CamelCase import identifiers
    } | sort -u | head -30 || note "no new strings in the UI files"
  else
    note "no non-test UI files changed — there are probably no new labels to name"
  fi
fi

# ---------------------------------------------------------------- project context
section "ROUTES / ROUTER FILE"
echo "Trace each user-visible component to the URL that renders it."
for f in src/App.tsx src/App.jsx src/main.tsx src/routes.tsx src/router.tsx app/routes.ts; do
  [ -f "$f" ] && echo "  found: $f"
done
ls src/pages src/views src/screens app/routes 2>/dev/null | head -5 || true

section "LIVE URL (best effort)"
{
  grep -rhoE 'https://[a-zA-Z0-9.-]+\.(com|cloud|app|io|dev|net)' \
    README.md CLAUDE.md AGENTS.md .env.example 2>/dev/null | sort | uniq -c | sort -rn | head -5
} || note "not found — ask the user for the URL rather than guessing"

section "DEPLOYMENT MODEL"
echo "Merged is not deployed. Confirm which, and say so in the report."
ls docs/runbooks/*deploy* docs/*DEPLOY* .github/workflows/*deploy* 2>/dev/null | head -5 \
  || note "no deploy runbook found — check CI config or ask"

section "PROJECT RULES (cite by name in any next-task prompt)"
ls ARCHITECTURE.md CLAUDE.md AGENTS.md CONTRIBUTING.md 2>/dev/null || note "none found"

section "REMINDERS"
cat <<'EOF'
  - A changed file is not a user-visible change. Most diffs are mostly tests.
  - Tests passing means tests passed. It does not mean deployed, and it does not mean "works".
  - If nothing user-visible changed, say so plainly instead of inventing a journey.
  - Take button labels from the changed strings above, not from memory.
EOF
