#!/usr/bin/env bash
set -euo pipefail
cp -n .env.example .env || true
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate   # includes RLS, roles and grants (packages/db/drizzle/0001_rls_roles_grants.sql)
echo "Listo. Ejecuta: pnpm dev"
