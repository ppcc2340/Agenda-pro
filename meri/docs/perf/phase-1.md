# Rendimiento — Fase 1 («Hoy» con 500 tareas / 5 000 eventos)

Objetivo (P1-10): «Hoy» < 1,5 s p75 con un workspace cargado.

## Cómo reproducir
```
DEMO_NOW=2026-10-20T08:40:00Z pnpm seed:perf          # perf@meri.local: 500 tareas (30 % completadas), 5 000 eventos ±180 días
APP_ENV=development ALLOW_FAKES_ON_PRODUCTION_BUILD=1 DEMO_NOW=2026-10-20T08:40:00Z pnpm --filter @meri/web build && pnpm --filter @meri/web start
pnpm perf:hoy                                         # 30 cargas de /hoy con Playwright (Chromium), p50/p75/p95
```
`seed:perf` usa los mismos repositorios que la app (RLS activo) y es idempotente por correo. `perf:hoy` inicia sesión con el proveedor de desarrollo, lanza un `POST /v1/plan/replan` síncrono y mide navegación → red inactiva (render de servidor + `GET /v1/plan`, eventos y avisos).

## Resultado (2026-10-19, contenedor de la sesión: Postgres 16 y Redis 7 locales, build optimizado de Next)
replan síncrono sobre 331 tareas abiertas y 5 000 eventos: **292 ms** (31 bloques añadidos, 153 riesgos, 59 conflictos, 305 sin programar en el horizonte de 14 días: sobrecarga esperada).

| métrica | p50 ms | p75 ms | p95 ms | máx ms |
|---|---|---|---|---|
| «Hoy» navegación → red inactiva | 748 | **772** | 902 | 910 |
| TTFB del servidor (`/hoy`) | 58 | 68 | 155 | 169 |
| `GET /api/v1/plan` | 62 | 73 | 114 | 122 |

**p75 = 772 ms < 1 500 ms.** ✅

## Índices revisados con `EXPLAIN (ANALYZE)`
- `schedule_blocks` filtrado por `workspace_id` + rango: 0,07 ms (51 filas; seq scan elegido por tamaño; índice `schedule_blocks_ws_starts_idx` disponible al crecer).
- `calendar_events` por `workspace_id` + rango: 0,67 ms sobre 5 021 filas (seq scan a este tamaño; índice `(workspace_id, starts_at)` presente).
- `tasks` abiertas por workspace: 0,2 ms (331 filas; `tasks_ws_status_due_idx`).
- `plan_runs` por `id` desc (uuid v7) y `notifications (workspace_id, day, created_at)`: índices propios.

Con ~5 000 filas por workspace el planificador de Postgres prefiere recorridos secuenciales (< 1 ms); los índices garantizan el comportamiento al multiplicar los workspaces (RLS filtra siempre por `workspace_id`).

## Notas
- La web consulta el plan persistido (`plan_runs` + `schedule_blocks`); nunca ejecuta el planificador en la petición (docs/04).
- `GET /v1/plan` devuelve solo las tareas referenciadas por bloques, riesgos y conflictos (no las 500).
- Pendiente para fases posteriores: paginar `risks`/`conflicts` en `GET /v1/plan` cuando superen ~200 entradas y cachear `/v1/clients` en el layout.
