#!/usr/bin/env bash
# Weekly cron wrapper for the live temporal ML pipeline.
#
# Schedule (server time, Africa/Nairobi):
#   Sunday    03:00 — live-collector.ts  (sweep top categories, capture snapshots)
#   Wednesday 03:00 — live-revisit.ts    (re-scrape items seen in last 14d, append snapshots)
#
# Install via crontab -e:
#   0 3 * * 0 /home/z/my-project/work/jiji-deal-hunter/scripts/cron-weekly.sh collector
#   0 3 * * 3 /home/z/my-project/work/jiji-deal-hunter/scripts/cron-weekly.sh revisit
#
# Logs go to logs/cron-{collector,revisit}-YYYY-MM-DD.log
# Exit codes:
#   0  success (snapshots captured)
#   2  partial (some blocked — WAF kicked in, retry next week)
#   3  fatal   (DB unreachable, missing deps, etc.)

set -euo pipefail

MODE="${1:-collector}"   # collector | revisit
REPO_DIR="/home/z/my-project/work/jiji-deal-hunter"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/cron-${MODE}-${DATE}.log"

# Rotate logs older than 30 days
find "$LOG_DIR" -name "cron-*.log" -mtime +30 -delete 2>/dev/null || true

cd "$REPO_DIR"

# Load env (DATABASE_URL etc.)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Ensure deps are present
if [ ! -d node_modules ]; then
  echo "[$(date -Iseconds)] [cron-$MODE] FATAL: node_modules missing — run bun install" >> "$LOG_FILE"
  exit 3
fi

echo "[$(date -Iseconds)] [cron-$MODE] starting" >> "$LOG_FILE"

case "$MODE" in
  collector)
    # Top categories per market. Pacing 1 req/3s, ~5min per category.
    # Total runtime: ~30 min for 5 markets × 4 categories × 1 page.
    SCRIPT="scripts/live-collector.ts"
    ARGS="--max-pages=1"
    ;;
  revisit)
    # Only revisit items captured in the last 14 days.
    SCRIPT="scripts/live-revisit.ts"
    ARGS="--days=14 --limit=500"
    ;;
  *)
    echo "[$(date -Iseconds)] [cron-$MODE] FATAL: unknown mode '$MODE' (use collector|revisit)" >> "$LOG_FILE"
    exit 3
    ;;
esac

# Run with a 60-minute timeout (3600s). If WAF blocks, the script exits
# gracefully with non-zero — we capture that and exit 2 (partial).
timeout 3600 bun "$SCRIPT" $ARGS >> "$LOG_FILE" 2>&1 || {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    echo "[$(date -Iseconds)] [cron-$MODE] TIMEOUT after 60min — partial capture, will continue next week" >> "$LOG_FILE"
    exit 2
  fi
  # Check if "All requests blocked" appears in the log
  if grep -q "All requests blocked\|FATAL" "$LOG_FILE"; then
    echo "[$(date -Iseconds)] [cron-$MODE] BLOCKED by WAF — check proxy pool / Crawl4AI fallback" >> "$LOG_FILE"
    exit 2
  fi
  echo "[$(date -Iseconds)] [cron-$MODE] FAILED exit=$EXIT_CODE" >> "$LOG_FILE"
  exit 2
}

# After collector finishes, kick off a temporal-targets recomputation so
# CanonicalItem.motivatedSeller / staleListing / flipOpportunity are fresh.
# (only on collector runs — revisit doesn't change targets, just adds snapshots)
if [ "$MODE" = "collector" ]; then
  echo "[$(date -Iseconds)] [cron-$MODE] recomputing temporal targets..." >> "$LOG_FILE"
  timeout 600 bun scripts/compute-temporal-targets.ts >> "$LOG_FILE" 2>&1 || true
fi

echo "[$(date -Iseconds)] [cron-$MODE] DONE" >> "$LOG_FILE"
exit 0
