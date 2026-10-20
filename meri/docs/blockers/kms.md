# Gestión de claves (KMS) para producción

**Variables:** `KMS_PROVIDER=aws`, `KMS_KEY_ID` (ARN de la clave), `AWS_REGION`; opcional `KMS_PREVIOUS_KEY_IDS` (claves retiradas que aún hay que poder leer, separadas por comas). Credenciales: **rol de la instancia o de la tarea** (cadena estándar de AWS); `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` solo como último recurso.
**Desbloquea:** cifrado de tokens en producción (fase 5) y beta con correos reales (fase 6). ADR 0007.
**Mientras tanto:** clave maestra local `LOCAL_MASTER_KEY`, **solo desarrollo**. Con datos reales está prohibido (la configuración de producción lo rechaza). Google Cloud KMS no está disponible todavía (ADR 0007).

## Pasos
1. En AWS KMS, crea una clave simétrica (`SYMMETRIC_DEFAULT`) en la región del despliegue y activa la **rotación automática** anual.
2. Política mínima para el rol del servicio de Meri (api y worker): solo `kms:Encrypt` y `kms:Decrypt` sobre esa clave, con condición sobre el contexto de cifrado:
   ```json
   {
     "Effect": "Allow",
     "Action": ["kms:Encrypt", "kms:Decrypt"],
     "Resource": "<ARN de la clave>",
     "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": ["integration-tokens", "backup"] } }
   }
   ```
   Si separas claves por propósito (recomendado para copias), da a cada rol solo el propósito que necesita: el worker y la api `integration-tokens`; el trabajo de copias `backup`.
3. Nadie con acceso a la aplicación administra la clave (sin `kms:ScheduleKeyDeletion`, `kms:PutKeyPolicy`). El borrado de una clave exige dos personas y espera de 30 días (ver `docs/runbooks/key-rotation.md`).
4. Rellena `KMS_PROVIDER=aws`, `KMS_KEY_ID` y `AWS_REGION` en el gestor de secretos del entorno.
5. `pnpm blockers`, luego `/connect-blocker kms`.

## Prueba
`pnpm smoke kms`: cifra y descifra con los dos propósitos y lista las claves aceptadas. Rotación manual (cambio de clave, no la anual automática): pon la clave nueva en `KMS_KEY_ID`, la antigua en `KMS_PREVIOUS_KEY_IDS`, ejecuta `pnpm keys:rotate` y, cuando el informe diga 0 pendientes y la copia más antigua cifrada con la clave vieja haya caducado, quítala de `KMS_PREVIOUS_KEY_IDS` (`docs/runbooks/key-rotation.md`).
