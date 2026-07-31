#!/bin/sh
set -e

# Apply any pending Prisma migrations before the API accepts traffic.
# `migrate deploy` is non-interactive and safe to run on every boot.
echo "[entrypoint] Running prisma migrate deploy..."
npx prisma migrate deploy

echo "[entrypoint] Starting: $*"
exec "$@"
