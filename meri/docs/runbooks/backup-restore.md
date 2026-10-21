# Runbook: copias de seguridad y restauración

Objetivos (D-092): **RPO ≤ 24 h**, **RTO ≤ 4 h**. Formato y garantías: ADR 0007 (D-086).

## 1. Dos capas de copia

| Capa | Qué es | RPO | Quién la configura |
|---|---|---|---|
| Principal | Instantáneas diarias + PITR del Postgres gestionado | minutos (PITR) | humano, en el proveedor |
| Adicional | `pnpm backup`: volcado lógico cifrado `MERI-BACKUP-1`, independiente del proveedor | 24 h (diaria) | humano: programar el cron y el almacenamiento |

La copia lógica protege contra la pérdida del proveedor o de la cuenta del proveedor. Retención **≤ 30 días** (igual que la ventana de supresión), en almacenamiento con bloqueo de objetos (WORM) y en una cuenta distinta de la de producción.

## 2. Hacer una copia

Requisitos: `DATABASE_ADMIN_URL` (rol propietario, sin `BYPASSRLS`), la configuración KMS del entorno (`KMS_PROVIDER`, `KMS_KEY_ID`, `AWS_REGION`) y `pg_dump` 16.

```bash
pnpm backup --out=backups/meri-$(date -u +%Y%m%dT%H%M%SZ).mbk
```

- Vuelca con `--enable-row-security` en el contexto de lectura admin y cuenta las filas en la misma instantánea (`pg_export_snapshot`).
- Cifra por trozos con una DEK nueva envuelta por KMS con `purpose=backup`; la cabecera lleva el manifiesto (fecha, migración, filas por tabla).
- Subir el `.mbk` al almacenamiento de copias. **Nunca** guardar la clave junto a la copia: la DEK solo se desenvuelve con KMS.

Cron sugerido (humano), diario a las 03:17 UTC: `pnpm backup --out=/var/backups/meri-$(date -u +\%Y\%m\%d).mbk && <subida al almacenamiento>`. Alertar si el último objeto tiene más de 26 h.

## 3. Restaurar

Solo sobre una base **vacía**. El script se niega si la base destino tiene tablas.

```bash
# 1. Crear la base destino vacía (en el proveedor o con psql).
createdb -h <host> -U <owner> meri_restore
# 2. Restaurar: autentica el archivo entero antes de pg_restore, compara recuentos con el manifiesto
#    y reaplica las supresiones posteriores a la copia leyendo deletion_receipts de la base indicada.
pnpm restore backups/meri-20261020T031700Z.mbk \
  --target=postgres://<owner>:<pass>@<host>:5432/meri_restore \
  --receipts-from=$DATABASE_ADMIN_URL
# 3. Migraciones pendientes (si la copia es de una versión anterior del esquema).
DATABASE_ADMIN_URL=postgres://<owner>:<pass>@<host>:5432/meri_restore pnpm db:migrate
```

Si la base principal ya no existe, `--receipts-from` apunta a la réplica o a la copia más reciente que conserve `deletion_receipts`. Si no hay ninguna, anotar en el incidente qué supresiones habrá que repetir a mano desde los avisos de borrado.

Errores esperados y qué significan:

| Mensaje | Causa | Acción |
|---|---|---|
| `target database is not empty` | La base destino tiene tablas | Crear otra base vacía |
| autenticación fallida / trozo final ausente | Archivo truncado o manipulado | Usar la copia anterior; abrir incidente S1 si hay sospecha de manipulación |
| `UNKNOWN_KEY` | La clave KMS de la copia no está configurada | Añadirla a `KMS_PREVIOUS_KEY_IDS` (ver [`key-rotation.md`](key-rotation.md)) |
| recuentos distintos del manifiesto | Restauración incompleta | No dar servicio; repetir y revisar la salida de `pg_restore` |

## 4. Verificar después de restaurar

1. `pnpm smoke kms` y `pnpm smoke google-oauth` contra el entorno restaurado.
2. Apuntar la API a la base restaurada en staging y comprobar `/health` y `/ready` del worker.
3. Una cuenta de prueba entra, ve su plan y su actividad.

## 5. Simulacro

`pnpm dr:drill --report` hace copia, restauración en una base temporal del mismo servidor, verificación de recuentos y borrado de la temporal, y escribe `docs/runbooks/dr-drill-<fecha>.md`. Frecuencia: **trimestral** y después de cada cambio de formato de copia o de clave. Último: [`dr-drill-2026-10-20.md`](dr-drill-2026-10-20.md) (10 748 filas, 1,3 s, recuentos verificados).
