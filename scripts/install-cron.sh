#!/usr/bin/env bash
# Install weekly crontab entries for the temporal ML pipeline.
#
# Run this ONCE on the deployment server:
#   bash scripts/install-cron.sh
#
# It will merge these entries into the current user's crontab (preserving
# any existing entries):
#
#   0 3 * * 0 cd /app && bash scripts/cron-weekly.sh collector
#   0 3 * * 3 cd /app && bash scripts/cron-weekly.sh revisit
#
# Schedule is in SERVER TIME. Adjust the hour if your server is in a
# different timezone. The defaults (03:00 Sun and 03:00 Wed) are picked
# to minimize impact on users (low-traffic window) and to give 3 days
# between collector and revisit so newly-listed items get a fresh price
# point mid-week.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Try to use the system crontab binary
if ! command -v crontab >/dev/null 2>&1; then
  echo "ERROR: 'crontab' command not found." >&2
  echo "On Debian/Ubuntu: sudo apt-get install -y cron" >&2
  echo "On Alpine: apk add --no-cache busybox-suid" >&2
  echo "" >&2
  echo "Alternatively, copy these lines into /etc/cron.d/jiji-deal-hunter:" >&2
  echo "  0 3 * * 0 $(whoami) cd $REPO_DIR && bash scripts/cron-weekly.sh collector" >&2
  echo "  0 3 * * 3 $(whoami) cd $REPO_DIR && bash scripts/cron-weekly.sh revisit" >&2
  exit 1
fi

# Compose the new entries
NEW_COLLECTOR="0 3 * * 0 cd $REPO_DIR && bash scripts/cron-weekly.sh collector"
NEW_REVISIT="0 3 * * 3 cd $REPO_DIR && bash scripts/cron-weekly.sh revisit"

# Merge with existing crontab, removing any old jiji entries to avoid dupes
( crontab -l 2>/dev/null | grep -v "cron-weekly.sh" || true
  echo "$NEW_COLLECTOR"
  echo "$NEW_REVISIT"
) | crontab -

echo "✓ Installed weekly crontab entries:"
crontab -l | grep "cron-weekly.sh"
echo ""
echo "Collector runs Sunday 03:00, Revisit runs Wednesday 03:00."
echo "Logs: $REPO_DIR/logs/cron-{collector,revisit}-YYYY-MM-DD.log"
