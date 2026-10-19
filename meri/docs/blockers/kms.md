# Gestión de claves (KMS) para producción

**Variables:** `KMS_PROVIDER` (`aws` o `gcp`), `KMS_KEY_ID`
**Desbloquea:** cifrado de tokens en producción (Fase 5) y beta con correos reales (Fase 6).
**Mientras tanto:** clave maestra local `LOCAL_MASTER_KEY`, **solo desarrollo**. Con datos reales está prohibido.

## Pasos
1. Elige proveedor (AWS KMS o Google Cloud KMS) según dónde vayas a desplegar.
2. Crea una clave simétrica y una política de acceso mínima para el servicio de Meri (cifrar y descifrar, sin administrar).
3. Activa la rotación automática.
4. Rellena `KMS_PROVIDER` y `KMS_KEY_ID` en el gestor de secretos del entorno.
5. `pnpm blockers`, luego `/connect-blocker kms`.

## Prueba
Cifrar y descifrar un token de ejemplo, rotar la clave y comprobar que los datos antiguos siguen descifrándose (`docs/06-security-privacy.md` §2).
