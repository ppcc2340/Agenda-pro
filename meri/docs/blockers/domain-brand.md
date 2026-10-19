# Dominio y marca de Meri

**Variable:** `PUBLIC_DOMAIN`
**Desbloquea:** verificación de Google y beta con usuarios reales.
**Mientras tanto:** `localhost`. Las páginas `/privacy` y `/terms` existen pero sin dominio público.

## Pasos
1. Elige y registra el dominio (por ejemplo `meri.app` o `getmeri.com`, según disponibilidad).
2. Verifica el dominio en **Google Search Console**. Google lo exige para la pantalla de consentimiento.
3. Crea buzones: `soporte@`, `privacidad@` y `seguridad@`. Se citan en la política de privacidad.
4. Correo transaccional: configura SPF, DKIM y DMARC.
5. Publica `/privacy` y `/terms` en el dominio.
6. Anota el dominio en `.env` (`PUBLIC_DOMAIN`) y actualiza `APP_URL` y `API_URL`.
7. `pnpm blockers`, luego `/connect-blocker domain-brand`.

## Marca (en paralelo, tarda meses)
- Antes de invertir en identidad, busca conflictos con «Meri» en el registro de marcas de tu país y en los de EE. UU. y la UE, en las clases de software y servicios. Un abogado de propiedad intelectual puede hacer el análisis formal.
- Reserva los nombres de usuario en las redes que vayas a usar.
- Esto es una lista de comprobación, no asesoría legal.
