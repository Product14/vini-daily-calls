#!/bin/sh
# ROI daily digest — hourly cron wrapper. Sends each LIVE rooftop's "yesterday" digest
# at its local 7 AM (idempotent: one send/rooftop/day). Scoped to the enabled rooftops.
cd "/Users/subhavmalhotra/Desktop/vini-product/pods/vini-roi-daily-report/local-cron"
set -a
. ./.env.cron
set +a
export DRY_RUN=false
export ONLY_TEAMS=e4047018-c,3d3deabc98,7607d0e6f5,b4df3297f5,9c9e3d1259,9923577d07,bf524480-3
"/usr/local/bin/node" runner.cjs >> /tmp/roi-cron.log 2>&1
