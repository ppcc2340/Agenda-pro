#!/usr/bin/env bash
set -euo pipefail
cp -n .env.example .env || true
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
psql "${DATABASE_URL:-postgres://meri:meri@localhost:5432/meri}" -f packages/db/sql/001_rls.sql
echo "Listo. Ejecuta: pnpm dev"
