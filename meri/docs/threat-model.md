# Modelo de amenazas (STRIDE) — Meri

- Versión: 1 (fase 5, 2026-10-20). Se revisa al cerrar cada fase y ante cualquier cambio de flujo de datos.
- Alcance: web (Next.js), API (Fastify), worker (BullMQ), Postgres, Redis, y los proveedores Google (OAuth, Gmail, Calendar), Anthropic, Stripe y PostHog.
- Convención: cada mitigación cita su mecanismo (archivo) y su evidencia (test). «Fase 5 · paso N» remite a `phases/05-security-compliance/PLAN.md`. El riesgo residual es lo que queda después de las mitigaciones, con su dueño.

## 1. Activos
| Activo | Dónde vive | Sensibilidad |
|---|---|---|
| Tokens OAuth de Google (refresh/access) | `integration_accounts.encrypted_tokens` (sobre AES-256-GCM, D-085) | Crítica: acceso al correo y calendario del usuario |
| Metadatos de correo y citas ≤ 200 caracteres | `threads_index`, `proposals`, `commitments` | Alta: información de clientes de un profesional (secreto profesional) |
| Calendario, tareas, tiempo, clientes | tablas de dominio con `workspace_id` | Alta |
| Sesión (JWT cifrado de Auth.js) | cookie `authjs.session-token` (HttpOnly, Secure en producción, SameSite=Lax) | Alta |
| Secretos de servidor (`AUTH_SECRET`, `INTERNAL_API_SECRET`, clave KMS, secretos de Stripe y Google) | gestor de secretos / entorno | Crítica |
| Estado de facturación | `subscriptions`, `entitlements`, `credit_grants` | Media (fraude de créditos) |
| Copias de seguridad | archivos `.mbk` cifrados (D-086) | Crítica (todo lo anterior) |
| Registro de auditoría | `audit_log` | Media (integridad y rendición de cuentas) |

## 2. Límites de confianza
```
Navegador ──(1)── Web Next.js ──(2)── API Fastify ──(3)── Postgres (RLS)
                                   │               └──(4)── Redis (colas, rate limit)
                                   ├──(5)── Google OAuth / Gmail / Calendar
                                   ├──(6)── Anthropic (contenido no confiable de correo)
                                   └──(7)── Stripe (webhooks firmados)
Worker BullMQ ─────────────(3)(4)(5)(6)        Operador ──(8)── scripts de admin, copias, KMS
```
(1) Internet público. (2) Red interna: la web reenvía `/api/v1/*` a la API con la cookie; `/internal/*` exige `INTERNAL_API_SECRET`. (3) El rol `meri_app` no tiene `BYPASSRLS`; toda consulta va dentro de `withWorkspace`. (5–7) Terceros: sus respuestas se validan con Zod en el adaptador. (8) Acceso privilegiado (conexión de administrador), solo desde scripts auditados.

## 3. Amenazas por flujo

### 3.1 Sesión y autenticación
| STRIDE | Amenaza | Mitigación (mecanismo · evidencia) | Residual |
|---|---|---|---|
| S | Falsificar o cruzar la sesión de otro usuario | JWT cifrado con `AUTH_SECRET`, reclamaciones validadas con Zod (`plugins/session.ts`) · `account.test.ts` «forged/crossed claims → 401» | Robo de cookie en un dispositivo comprometido: revocación global (fase 5 · paso 4) |
| S | Proveedor de acceso de desarrollo en producción | rechazado en producción (`apps/web/src/auth.ts`) · `auth.test.ts` | Staging público con `GOOGLE_MODE=fake`: limitar a `DEMO_MODE`/localhost (deuda) |
| T | Redirección abierta tras el login (`next=`) | `safeNext` (`server/demo.ts`) · `demo.test.ts` | — |
| R | Acciones sin rastro | `audit_log` en cada acción automatizada y de permisos · tests de cada ruta | — |
| E | Cuenta borrada sigue usando su cookie | guardia de sesión (`plugins/account-guard.ts`, caché 60 s) · `account-guard.test.ts` | Ventana ≤ 60 s |
| E | Sesión robada válida 14 días | caducidad absoluta desde `authTime` (fijado al iniciar sesión, no se renueva al reemitir el JWT) y «cerrar sesión en todos los dispositivos» (`users.sessions_valid_after`) · fase 5 · paso 4 | — |
| S | Dirección de correo reciclada (empresa que reasigna un buzón) hereda la cuenta anterior | identidad por `sub` de Google + `email_verified` en el login; email existente con otro `sub` → 409 · fase 5 · paso 4 | — |

### 3.2 Peticiones del navegador (XSS, CSRF, abuso)
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| T/E | XSS que lee datos o actúa en nombre del usuario | React escapa por defecto; sin `dangerouslySetInnerHTML` con datos; CSP con nonce y `strict-dynamic` (fase 5 · paso 2) | `style-src 'unsafe-inline'` (estilos, sin ejecución) |
| T | CSRF desde otro sitio | cookie `SameSite=Lax`, cabecera `x-requested-with: meri` en escrituras (`plugins/csrf.ts` · `account.test.ts`), API sin CORS, `Origin`/`Sec-Fetch-Site` (fase 5 · paso 4) | GET con efectos solo en demo/`fake` |
| T | Clickjacking | `frame-ancestors` + `X-Frame-Options` (`next.config.ts` / middleware) | — |
| D | Abuso de la API / coste de IA | rate limit por usuario/IP (`app.ts`, `RATE_LIMIT_PER_MINUTE`) · `health.test.ts`; límites por ruta; `bodyLimit` 256 KB; puerta `aiBudget` y tope en USD | Sin WAF hasta el despliegue |
| I | Respuestas con datos cacheadas por intermediarios | `Cache-Control: no-store` en exportaciones (y en toda respuesta con sesión, fase 5 · paso 2) | — |

### 3.3 Aislamiento multi-tenant y entre clientes
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| I | Un workspace lee datos de otro (IDOR) | RLS FORCE por `workspace_id` (`drizzle/0001_rls_roles_grants.sql`), `withWorkspace`, filtros en repos · `rls-coverage.test.ts`, `workspace.test.ts`, pruebas cruzadas por ruta y matriz de autorización (fase 5 · paso 9) | Error humano en una ruta nueva: la matriz falla si una ruta no está cubierta |
| I | Información de un cliente en el contexto de IA de otro | `ContextBuilder` único (`packages/core/src/clients/context.ts`) · `context.properties.test.ts` (1 000 casos) y canario en `briefings.test.ts` / `evals/briefings` | — |
| E | Un job opera sin fijar el workspace | dispatchers con contexto de lectura admin y luego `withWorkspace` (D-025) | — |

### 3.4 Conexión OAuth con Google
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| S | CSRF de login OAuth / inyección de código de autorización | `state` aleatorio en cookie HttpOnly (`routes/integrations.ts`) · `integrations.test.ts`; PKCE S256 y comparación en tiempo constante (fase 5 · paso 4) | — |
| E | Scopes excesivos (envío de correo) | scopes incrementales por función, nunca `gmail.send` (`oauth/scopes.ts`); paso de CI que prohíbe código de envío | — |
| I | Fuga de tokens | cifrado de sobre (`packages/config/src/crypto/envelope.ts`), AAD por cuenta, nunca en logs (lista de censura del logger · `logger.test.ts`); revocación en el proveedor al desconectar y al borrar la cuenta | Clave local en desarrollo: prohibida en producción (`modes.ts`) |

### 3.5 Ingesta de correo → IA → propuestas
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| T/E | Inyección de instrucciones en el correo que hace actuar a la IA | La IA solo escribe `proposals`; la política decide; el usuario confirma; contenido marcado como no confiable (docs/05 §6) · `evals/injection` (100 %), `extract.test.ts` | Ofuscaciones no cubiertas por la suite (deuda de la fase 2) |
| I | Guardar cuerpos de correo | solo metadatos y cita ≤ 200 (`packages/core/src/mail/sanitize.ts`) · `no-mail-bodies.test.ts`; propiedades de los analizadores (fase 5 · paso 9) | — |
| D | Correo malicioso que rompe el analizador | validación Zod, propiedades `fast-check` «nunca lanza» (fase 5 · paso 9) | — |
| I | Datos de clientes enviados al proveedor de IA más allá de lo necesario | contexto mínimo por cliente; uso limitado de Google (sin entrenamiento) en el contrato con el proveedor (`docs/compliance/subprocessors.md`) | Depende del contrato del proveedor (humano) |

### 3.6 Escritura en calendario y acciones automáticas
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| T | Meri modifica reuniones de terceros | solo escribe bloques propios en el calendario «Meri»; el planificador nunca mueve eventos externos (`core/planner`, propiedades) · `plan.properties.test.ts` | — |
| R | Cambios automáticos sin explicación | auditoría + deshacer (`POST /v1/audit/:id/undo`) · `plan.test.ts` | — |

### 3.7 Webhooks
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| S | Webhook de Stripe falsificado | firma `t=…,v1=` HMAC con tolerancia de 5 min y relectura canónica (ADR 0006) · `billing.test.ts` | — |
| S | Notificación de Google falsificada | token de canal compartido (`x-goog-channel-token`) | Token global y `x-goog-channel-id` confiado: token por `watch` y JWT OIDC de Pub/Sub al activar Google en vivo (fase 6) |
| D | Reenvíos masivos | idempotencia por evento (`stripe_events`), límites por ruta (120/600 por minuto) | — |

### 3.8 Facturación
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| T | Créditos sin pagar (evento de paquete inventado) | concesión solo con la sesión canónica pagada (D-075) · `billing.test.ts` | — |
| R | Doble cobro por reintentos | `Idempotency-Key` por intención (D-073) | — |

### 3.9 Datos en reposo, claves y copias
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| I | Volcado de la base expone tokens | tokens cifrados con KMS (fase 5 · paso 5); cifrado en reposo del proveedor gestionado | Metadatos en claro en la base (cifrado del proveedor) |
| I | Copia robada | copia cifrada con una DEK envuelta por KMS (fase 5 · paso 6) | Quien tenga acceso a la clave KMS y a la copia |
| D | Pérdida de la clave | rotación con anillo (claves anteriores para descifrar), rotación automática del KMS | Borrado de la clave en el KMS = pérdida irreversible (procedimiento con doble control en `docs/runbooks/key-rotation.md`) |
| T | Copia alterada restaurada | autenticación por trozo y del orden/final del archivo (fase 5 · paso 6) | — |

### 3.10 Privacidad y retención
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| I | Datos que sobreviven a la eliminación | purga física `data.delete_account` y verificación sobre una lista de tablas clasificada (fase 5 · paso 7) | Copias de seguridad hasta su caducidad (documentado en privacidad) |
| R | Alteración o borrado del registro de auditoría (también en cascada al borrar un workspace) | sin UPDATE/DELETE para la app · `workspace.test.ts`; sin DELETE sobre `workspaces`/`users` para la app; purga solo por función `SECURITY DEFINER`; trigger de inmutabilidad (fase 5 · pasos 7 y 8) | El propietario de la base puede desactivar el trigger (acceso de operador auditado) |

### 3.11 Cadena de suministro y operación
| STRIDE | Amenaza | Mitigación | Residual |
|---|---|---|---|
| T | Dependencia comprometida | `pnpm-lock.yaml` congelado, `pnpm audit --prod` bloqueante, Dependabot, SBOM (fase 5 · paso 9) | Ataques de día cero |
| I | Secretos en el repositorio | gitleaks en CI (`.gitleaks.toml`), `.env` ignorado | — |
| T | Vulnerabilidad en el código | CodeQL `security-extended` (fase 5 · paso 9), revisiones por fase | — |
| E | Acceso de operador indebido | conexión de administrador solo en scripts; producción prohíbe `fake` y `KMS_PROVIDER=local` | Controles de acceso del proveedor de hosting (humano) |

## 4. Fuera de alcance
Ataques físicos al dispositivo del usuario, compromiso de la cuenta de Google del usuario (la mitigan sus propios controles), proveedores de infraestructura comprometidos.

## 5. Revisión
Revisado por el subagente `security-auditor` al cerrar la fase 5. Próxima revisión: cierre de la fase 6 (Google en vivo, Pub/Sub, despliegue).
