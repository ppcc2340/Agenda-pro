# Demo CRM · CLM: estado frente a «Diagnóstico e instrucciones para llegar a 10/10»

Archivo: `crm/demo/crm-tutorial.html`. Es un único HTML, sin servidor ni instalación.

Cómo leer las tablas:
- La columna «Prueba» indica qué test automatizado demuestra cada punto.
- ✅ hecho y probado · 🟡 parcial (se explica qué falta) · ⏳ fuera del alcance de este trabajo.

## Cómo se hizo

El trabajo se repartió en cinco paquetes.

| Paquete | Prefijo | Qué cubre |
|---|---|---|
| A · Datos y seguridad | `dx` | D-01…D-06, E-01, E-02, S-01…S-04 |
| B · Funcionalidad | `fx` | F-01…F-03, F-05, F-06, C-04, O-05 |
| C · Navegación, personalización por usuario y textos | `nv` | F-04, N-01…N-04, N-06, C-01…C-03, T-01…T-05 |
| D · Rendimiento y estabilidad | `px` | R-01…R-04, E-03, E-04, A-03 |
| E · Acabado visual, accesibilidad y primer uso | `ux` | V-01…V-06, A-01, A-02, A-04…A-08, N-05, O-01, O-03, O-04 |

Detalles de la construcción:
- Cada paquete es un bloque `<script>` y `<style>` propio que envuelve las funciones existentes sin reescribirlas. Las ediciones de código previo son tres y mínimas, y cada una se comprueba por número de apariciones.
- Al final se añadió un pequeño bloque de integración: el «Mover a…» del kanban con teclado usa el soltar delegado de la rejilla virtual.
- El paquete A convierte todos los bloques en `text/x-app`. Un cargador asíncrono los ejecuta en orden después de leer IndexedDB y, si el espacio está cifrado, de pedir la contraseña.

## Estado por requisito

### 4.1 Datos y almacenamiento
| Id | Estado | Notas |
|---|---|---|
| D-01 IndexedDB y arranque asíncrono | ✅ | Guardado diferido 300 ms con un único escritor y número de revisión, indicador «Guardado» y reintentos a 1, 5 y 30 s. Los datos de localStorage se migran una sola vez. Sin IndexedDB, la app sigue con localStorage. Probado: 25.000 contactos guardados y recargados, y el cambio se conserva aunque el navegador se mate 1 s después de editar. |
| D-01b Recarga inmediata | ✅ | Al integrar los paquetes apareció una pérdida real: un cambio se perdía si la página se recargaba mientras se estaba guardando. Medido con 8.000 contactos: se perdían 9 de 20 recargas. La causa es que la transacción de IndexedDB no siempre llega a confirmarse al descargar la página. Se ha corregido con un diario síncrono: al cerrar, lo pendiente o en curso se escribe también en el almacenamiento clásico del navegador y, al arrancar, se recupera si es más nuevo. Tras la corrección: 0 pérdidas en 20 recargas, 10 de ellas a mitad de escritura. Límite: el diario solo cabe si el espacio pesa menos de unos 5 MB; por encima, cerrar justo durante un guardado vuelve a ser un riesgo. |
| D-02 Una sola pestaña escribe | ✅ | Web Locks y BroadcastChannel. La segunda pestaña abre en modo lectura con «Usar aquí». Probados 60 escenarios: 0 cambios perdidos. |
| D-03 Instantáneas | ✅ | Comprimidas con gzip. Rotación de 10 recientes, 5 diarias y 5 semanales. «Historial» permite restaurar y descargar; restaurar tarda unos 0,4 s. |
| D-04 Copia automática a archivo | ✅ | Con `showSaveFilePicker` (Chrome y Edge). En Firefox y Safari queda el recordatorio de exportar. |
| D-05 Persistencia y cuota | ✅ | `persist()` y `estimate()`, con aviso al 80 %. |
| D-06 Integridad referencial | ✅ | Se comprueba al cargar, al importar y bajo demanda, con informe, «Reparar» y registro en auditoría. |

### 4.2 Estabilidad y recuperación
| Id | Estado | Notas |
|---|---|---|
| E-01 Pantalla de error segura | ✅ | «Tus datos están a salvo», con Inicio, Reintentar y Copiar detalles. Ya no ofrece ninguna acción que borre datos. |
| E-02 Captura global de errores | ✅ | Anillo de 50 errores y un aviso por minuto como máximo. El diagnóstico se descarga sin datos personales. |
| E-03 Prueba de resistencia | 🟡 | 0 errores y 0 invariantes rotos en 10.000 acciones con semilla fija. La media es de 80-120 ms por acción en la máquina de pruebas (el objetivo es menos de 50 ms). |
| E-04 Escuchadores sin fugas | ✅ | 43 escuchadores antes y 43 después de 500 navegaciones. |

### 4.3 Funcionalidad y validación
| Id | Estado | Notas |
|---|---|---|
| F-01 Validación única | ✅ | Se aplica en celdas, pegado, formularios, importación y `setField`. De 387 valores inválidos se aceptan 0, y el mensaje aparece junto al campo. |
| F-02 Deshacer universal | ✅ | Una sola pila con Ctrl/Cmd+Z, Ctrl+Mayús+Z y «Deshacer» en el aviso. Cubre todas las acciones de la lista y además la edición masiva y la importación. |
| F-03 Duplicados al crear | ✅ | Por email, teléfono normalizado y dominio. |
| F-04 Búsqueda global | ✅ | Busca en todos los objetos y en el texto de los contratos. Respeta permisos, agrupa resultados, resalta la coincidencia e ignora tildes. |
| F-05 CLM | ✅ | Imprimir o guardar en PDF, comparación de versiones lado a lado, calendario mensual, exportación .ics de preavisos, vista «Vencen en 90 días» y plantillas con formato. |
| F-06 Edición masiva | ✅ | Barra igual en todos los tableros, incluidos los objetos personalizados. Se deshace de una vez. |

### 4.4 Personalización
| Id | Estado | Notas |
|---|---|---|
| C-01 Preferencias por usuario | ✅ | Se guardan en `S.prefs[usuario]`. Incluye «Restablecer mi vista» y «Mis vistas». Prueba: los ajustes de un usuario no afectan a otro. |
| C-02 Vocabulario | ✅ | Singular, plural y género («Nueva oportunidad», «los acuerdos»). |
| C-03 Plantillas de espacio | ✅ | Exportar e importar solo la configuración. Plantillas de serie: CRM, CLM y CRM + CLM. |
| C-04 Reglas de validación configurables | ✅ | Sin expresiones regulares visibles; incluye «Prueba la regla». |

### 4.5 Rendimiento
| Id | Estado | Notas |
|---|---|---|
| R-01 Presupuestos con 10.000 registros | 🟡 | Ficha: menos de 40 ms (cumple). Edición de celda: menos de 4 ms (cumple). Cambio de vista: 100-200 ms (objetivo: menos de 100). Búsqueda: 100-250 ms (objetivo: menos de 50). Medido en una máquina de pruebas lenta, de 2 a 2,5 veces más lenta que un portátil actual; aun así no se puede afirmar que se cumpla. |
| R-02 Virtualización | ✅ | Ventana de filas visibles con altura real. La paginación se mantiene para imprimir. |
| R-03 Índices en memoria | ✅ | `byId` es O(1) y el índice de texto se valida contra la búsqueda lineal. |
| R-04 Web Worker | ✅ | Se crea desde un Blob para los agregados de Informes; si no hay Worker, el cálculo se trocea en el hilo principal. |

### 4.6 Acabado visual
| Id | Estado | Notas |
|---|---|---|
| V-01 Cero defectos | ✅ | Corregidos los 7 defectos del diagnóstico. La lista de comprobación está en la carpeta del paquete E. |
| V-02 Regresión visual | ✅ | 336 capturas de referencia con un umbral del 0,5 %. |
| V-03…V-06 | ✅ | Ilustraciones de línea, movimiento con `prefers-reduced-motion`, esqueletos de carga, logotipo SVG y favicon. |

### 4.7 Navegación y productividad
| Id | Estado | Notas |
|---|---|---|
| N-01 Paleta | ✅ | Busca, crea, navega, ejecuta acciones sobre el registro abierto, cambia de espacio y muestra los recientes. |
| N-02 Atajos | ✅ | La ayuda se abre con «?». |
| N-03 Estado al volver | ✅ | Atrás y Adelante recuperan el desplazamiento, los filtros, los grupos plegados y la ficha abierta. |
| N-04 Enlaces profundos | ✅ | `#/negocios?ficha=deals:ID`, «Copiar enlace». |
| N-05 Migas | ✅ | En Ajustes, el contrato, Configurar CLM y las fichas. |
| N-06 Favoritos y recientes | ✅ | Por usuario y filtrados por permisos. |
| Títulos de pestaña | ✅ | 41 pantallas, ninguna sin título. |

### 4.8 Textos
| Id | Estado | Notas |
|---|---|---|
| T-01…T-03, T-05 | ✅ | Inventario automático: 2.801 cadenas en 98 pantallas, con 154 problemáticas antes y 0 ahora. Los errores siguen la fórmula «qué ha pasado + qué hacer». Formatos con Intl. |
| T-04 Lectura por una persona ajena | ⏳ | Requiere una persona real. |

Limitación: las correcciones de texto se aplican sobre lo que se pinta, con un diccionario único y un MutationObserver. Un texto nuevo que no siga los patrones conocidos no se corrige solo.

### 4.9 Accesibilidad
| Id | Estado | Notas |
|---|---|---|
| A-01 Contraste | ✅ | 0 fallos AA en claro y oscuro. Antes había 93 y 71 combinaciones por debajo. |
| A-02 Foco al cerrar | ✅ | En diálogos, panel, menús y paleta. |
| A-03 Rejilla accesible | ✅ | `role="grid"`, `aria-rowcount` real y navegación completa con teclado. |
| A-04…A-07 | ✅ | Objetivos táctiles de al menos 24 px, foco nunca tapado, «Mover a…» sin arrastrar, región viva, `forced-colors`, 320 px y zoom al 200 %. |
| A-08 NVDA y VoiceOver | 🟡 | Semántica verificada con el árbol de accesibilidad. La prueba con lectores de pantalla reales queda pendiente: es manual. |

### 4.10 Primer uso
| Id | Estado | Notas |
|---|---|---|
| O-01 Bienvenida y asistente | ✅ | Asistente del primer contrato en tres pasos. |
| O-02 Menos de 5 minutos con 4 de 5 personas | ⏳ | Requiere sesiones con usuarios reales. |
| O-03 Ayudas de una sola vez | ✅ | Con «No volver a mostrar», por usuario. |
| O-04 Espacio «Ejemplo» separado | ✅ | En el primer arranque se crean «Ejemplo» (con su etiqueta) y «Mi empresa» en blanco. A quien ya tenía datos no se le toca nada. |
| O-05 Importación guiada | ✅ | CSV o pegado desde Excel, mapeo automático, vista previa, duplicados y deshacer la importación completa. |

### 4.11 Seguridad y privacidad locales
| Id | Estado | Notas |
|---|---|---|
| S-01 Cifrado | ✅ | PBKDF2-SHA-256 con 600.000 iteraciones y AES-GCM. Bloqueo por inactividad y copias cifradas. Con el cifrado activo, IndexedDB no contiene datos legibles. |
| S-02 CSP y cero peticiones | ✅ | 0 peticiones de red. Se ha quitado la fuente de Google. |
| S-03 Avisos de privacidad | ✅ | |
| S-04 Borrado seguro de un espacio | ✅ | |

## Pruebas
Las pruebas están en la carpeta de trabajo de la sesión, no en el repositorio:
- Las 6 pruebas de regresión anteriores (cuswalk, prowalk, xlwalk, v2walk, demo-clm, txtwalk).
- Las 5 baterías de los paquetes.
- La prueba de resistencia (monkey).
- La regresión visual.

Tres pruebas antiguas se adaptaron porque el comportamiento cambió a propósito:
- CP-08 (cuota de localStorage): ahora se cubre con la prueba de fallo de escritura en IndexedDB.
- «Mostrar 200 más»: sustituido por la virtualización.
- Varias etiquetas renombradas por la revisión de textos.

## Lo que sigue fuera (apartado 7 del documento)
- Varias personas en distintos equipos trabajando sobre los mismos datos.
- Correo real.
- Firma con validez eIDAS.
- Auditoría inalterable.

Todo eso corresponde a la versión con servidor, que es el CRM de `crm/`. El formato JSON del espacio se mantiene estable para que esa versión pueda importarlo.

---

# Segunda revisión (`diagnostico_10_v2_crm_clm.txt`, nota de partida 8,9)

El trabajo se hizo en tres paquetes:
- **R**: datos, rescate y solo lectura (prefijo `rz`).
- **F**: permisos, línea temporal y textos (prefijo `fz`).
- **V**: acabado visual (prefijo `vz`).

Al fusionarlos, los bloques se renumeraron en el orden del documento para que el cargador los ejecute en orden estrictamente creciente.

| Id | Estado | Notas |
|---|---|---|
| P0-1 Datos dañados o de una versión más nueva | ✅ | El arranque detecta los datos dañados, los de una versión más nueva y los de formato no reconocible. Guarda una «Copia de rescate» y pone el escritor en pausa: no se escribe nada, tampoco en el diario. Solo se ejecuta el bloque de rescate. La pantalla `#/rescate` ofrece «Restaurar la última copia buena», «Descargar los datos tal como están», «Importar una copia…», «Abrir otro espacio» y «Empezar de cero…». Solo «Ejemplo» se regenera solo, y siempre con aviso. Prueba 9.1 hecha en «Mi empresa» y en el espacio principal, con JSON roto y con `version = 99`: el registro de IndexedDB no cambia ni un byte y CLIENTE_REAL SL se recupera. |
| P0-2 Campo oculto | ✅ | `canSee()` se aplica en la cabecera de la ficha, la paleta, la búsqueda global, Relacionados, Duplicados, Listas, el «Para» del email y «exportar lista». Esta última era una fuga nueva: sacaba siempre el email y el teléfono. |
| P0-3 Línea temporal | ✅ | Primero las fijadas y después por fecha descendente. Sin asuntos repetidos en 85 fichas. Las entradas automáticas las firma «Automático». |
| P0-4 Pestaña en solo lectura | ✅ | La clase `dx-ro` bloquea `setField`, `xlSetRaw`, `moveStage`, crear, borrar y editar celdas sin tocar `S`. «Nuevo…» queda deshabilitado con un aviso. El banner muestra el nombre del espacio y la hora del último cambio recibido. |
| P1-1 Barra de herramientas | ✅ | Nuevo · Buscar · Persona · Filtro · Ordenar · Agrupar · Mi vista … Más. Deshacer y rehacer van junto al título. |
| P1-2 Columna de nombre | ✅ | 320 px; 360 px en Negocios y Contratos. El ancho que arrastra cada usuario es solo suyo (antes se aplicaba a todos). |
| P1-3 Botón del tutorial | ✅ | Solo aparece mientras el tutorial está en curso. «Tutorial guiado» está en el menú «?» y en el del avatar. |
| P1-4 y P1-5 Ficha y pestañas del contrato | ✅ | Transiciones con verbos, paso a paso sin truncar (en móvil, «Paso 3 de 7 · …»), hallazgos con «Ver más», resumen de cláusulas, «Riesgo medio · 34/100», y pestañas con degradado y flechas. |
| P1-6 Móvil | ✅ | La marca muestra solo el icono, la insignia «Ejemplo» es un punto con descripción emergente, y las tarjetas ya no se cortan. |
| P1-7 Inicio del espacio real | ✅ | «Restablecer datos de ejemplo» solo aparece en «Ejemplo». Los gráficos vacíos tienen su propia acción y un «0 €» se muestra en gris. |
| P1-8 Barra lateral | ✅ | No se muestran contadores a 0. La carpeta se llama «Objetos». |
| P1-9 Números | ✅ | Agrupación siempre («2.400 €») y espacio antes del % («10 %»). |
| P1-10 Contraste | ✅ | Se amplió el auditor para que mire también lo que está fuera de pantalla, las filas resaltadas y las estrellas. Resultado: 0 fallos en 13 vistas, en claro y en oscuro. |
| P1-11 Textos | ✅ | Inventario automático: 101 pantallas y 0 cadenas problemáticas. |
| P1-12 Datos deterministas | ✅ | La siembra usa mulberry32 con semilla fija. Dos instalaciones limpias dan los mismos recuentos. |
| P1-13 Tamaño | 🟡 | 1,53 MB, por encima del presupuesto de 1,2 MB. Carga hasta la aplicación lista: 0,3-0,4 s. Para llegar a 1,2 MB habría que minificar la versión publicada. |
| P2 | ✅ | El asistente pide el nombre de pila, la paleta vacía muestra «Favoritos y recientes», y el banner de solo lectura lleva el nombre y la hora. El historial muestra el tamaño con un decimal y permite «Comparar con ahora». Se han quitado las notificaciones duplicadas de la siembra. «Bloquear ahora» y el tiempo de bloqueo se han verificado. El pie de grupo muestra la fecha más próxima, con el rango en la descripción emergente. |
| Pruebas manuales (5 personas; NVDA y VoiceOver) | ⏳ | Necesitan personas. |

Pruebas antiguas adaptadas en esta revisión:
- xlwalk, v2walk y demo-clm abren ahora «Formato condicional», «Reglas» y «Automatizaciones» desde «Más».
- La prueba E del botón flotante del tutorial lo abre antes, porque ese botón solo existe mientras el tutorial está en curso.
