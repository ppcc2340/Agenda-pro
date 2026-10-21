# Runbook: recuperación ante desastres

**RPO ≤ 24 h · RTO ≤ 4 h** (D-092). Aplica cuando se pierde la base de datos, el proveedor de hosting o la cuenta de un proveedor.

## 1. Escenarios

| Escenario | Fuente de recuperación | Pérdida máxima |
|---|---|---|
| Error humano (borrado, migración rota) | PITR del Postgres gestionado al minuto anterior | minutos |
| Corrupción o pérdida de la base | Instantánea del proveedor o PITR | minutos a 24 h |
| Pérdida del proveedor de base de datos o de su cuenta | Última copia `MERI-BACKUP-1` del almacenamiento externo | ≤ 24 h |
| Pérdida del hosting de la app | Redespliegue de las imágenes en otro proveedor | 0 (sin estado) |
| Pérdida de Redis | Nada que restaurar: colas y contadores se regeneran | trabajos en curso (se vuelven a encolar) |

## 2. Presupuesto de tiempo (RTO 4 h)

| Paso | Objetivo | Medido |
|---|---|---|
| Declarar el incidente y decidir el escenario | 30 min | — |
| Aprovisionar Postgres 16 vacío | 30 min | — |
| Descargar la copia y restaurar (`pnpm restore`) | 60 min | 1,3 s para 10 748 filas en el simulacro; escala lineal con el tamaño del volcado |
| Migraciones, secretos y redespliegue de API, worker y web | 60 min | — |
| Verificación y reapertura | 30 min | — |
| Margen | 30 min | — |

## 3. Procedimiento (pérdida del proveedor de base de datos)

1. **Declarar** S2 ([`incident-response.md`](incident-response.md)); congelar despliegues; poner la web en mantenimiento.
2. **Aprovisionar** una base Postgres 16 vacía y los roles:
   ```bash
   psql "$NEW_ADMIN_URL" -c "create role meri_app login password '<secreto>';"
   ```
3. **Restaurar** la última copia (detalle en [`backup-restore.md`](backup-restore.md)):
   ```bash
   pnpm restore <ultima>.mbk --target="$NEW_ADMIN_URL" --receipts-from="<réplica o copia con deletion_receipts>"
   DATABASE_ADMIN_URL="$NEW_ADMIN_URL" pnpm db:migrate
   ```
4. **Reconfigurar** `DATABASE_URL` y `DATABASE_ADMIN_URL` en el gestor de secretos; redesplegar API, worker y web.
5. **Verificar**: `/health` de la API, `/ready` del worker, `pnpm smoke kms`, `pnpm smoke google-oauth`, entrada de una cuenta de prueba.
6. **Reabrir** y comunicar: qué ventana de datos se perdió (desde la fecha del manifiesto de la copia). Las sincronizaciones de Google recuperan solas los eventos y correos posteriores; las tareas creadas en esa ventana se pierden y se avisa a los usuarios afectados.
7. **Post-mortem** en ≤ 5 días laborables.

## 4. Simulacros

- `pnpm dr:drill --report` trimestral (mide la parte de datos y deja informe).
- Una vez al año, simulacro completo en staging con cronómetro de todos los pasos de §3 (humano; necesita staging).
- Historial: [`dr-drill-2026-10-20.md`](dr-drill-2026-10-20.md).
