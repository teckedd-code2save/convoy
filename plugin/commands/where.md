---
description: Orient yourself. Prints where Convoy is installed, where state lives, what plans + runs exist, and whether the web viewer is up. Run this first if you're lost.
argument-hint:
---

Convoy orientation — the "doctor" call. Use this when:
- You don't know where Convoy is installed on this machine.
- You want to confirm `CONVOY_HOME` resolves, `.convoy/state.db` exists, and the web viewer is reachable.
- You were about to `find` or `ls` to rediscover paths — stop, run this instead.

## Do NOT explore the filesystem

Everything below comes from known paths. Do not supplement the output with `find` or `ls` runs on unrelated directories. If the output says a path doesn't exist, tell the user and ask how to proceed.

## Print the orientation

Run this as a single Bash tool call:

```bash
CONVOY_HOME="${CONVOY_HOME:-$HOME/convoy}"
echo "CONVOY_HOME: $CONVOY_HOME"
[ -d "$CONVOY_HOME" ] && echo "  ✓ installed" || { echo "  ✗ NOT found"; echo "  Ask the user for the path to their Convoy checkout and export CONVOY_HOME before continuing."; exit 0; }
[ -f "$CONVOY_HOME/package.json" ] && echo "  ✓ package.json present"
echo
echo "STATE:"
STATE="$CONVOY_HOME/.convoy"
if [ -d "$STATE" ]; then
  echo "  state dir: $STATE"
  [ -f "$STATE/state.db" ] && echo "  state.db: $(du -h "$STATE/state.db" | cut -f1) ($(stat -f "%Sm" "$STATE/state.db" 2>/dev/null || stat -c "%y" "$STATE/state.db" 2>/dev/null))"
  PLAN_COUNT=$(ls -1 "$STATE/plans"/*.json 2>/dev/null | wc -l | tr -d ' ')
  echo "  plans: $PLAN_COUNT saved"
  CLONE_COUNT=$(find "$STATE/clones" -maxdepth 3 -mindepth 3 -type d 2>/dev/null | wc -l | tr -d ' ')
  echo "  cloned targets: $CLONE_COUNT"
else
  echo "  (no .convoy dir yet — no plans or runs)"
fi
echo
echo "WEB VIEWER:"
if curl -sfS -o /dev/null -m 2 http://localhost:3737; then
  echo "  ✓ http://localhost:3737 (responding)"
else
  echo "  ✗ http://localhost:3737 (not responding — will auto-spawn on next plan/apply)"
fi
echo
echo "RECENT PLANS (up to 5):"
if [ -d "$STATE/plans" ]; then
  ls -1t "$STATE/plans"/*.json 2>/dev/null | head -5 | while read f; do
    NAME=$(basename "$f" .json | cut -c1-8)
    TARGET=$(grep -m1 '"name"' "$f" | sed 's/.*"name": "\(.*\)",/\1/' | head -1)
    PLATFORM=$(grep -m1 '"chosen"' "$f" | sed 's/.*"chosen": "\(.*\)",/\1/' | head -1)
    echo "  $NAME  $TARGET → $PLATFORM"
  done
else
  echo "  (no plans)"
fi
echo
echo "RECENT RUN:"
cd "$CONVOY_HOME" 2>/dev/null && npm run convoy --silent -- status 2>/dev/null | head -5 || echo "  (no runs)"
```

## Interpret the output for the user

Structure your response as a quick summary followed by "next steps":

- If `CONVOY_HOME` resolved and state exists: tell them the Convoy version, plan count, last run status. Suggest either `/convoy:ship <target>` (new deploy) or `/convoy:ship-status <id>` (check an existing run).
- If `CONVOY_HOME` didn't resolve: ask the user for the path. Do NOT go hunting.
- If the web viewer is down: note that the next `/convoy:ship` or `/convoy:ship-status` will auto-spawn it. No manual start needed.

Keep the response compact — ~10 lines. The orientation is for the *agent*'s context, not a user-facing report.
