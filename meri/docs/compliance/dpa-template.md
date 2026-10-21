# Plantilla de acuerdo de encargo del tratamiento (DPA)

> **Plantilla técnica, no asesoramiento jurídico.** Debe revisarla un abogado antes de ofrecerla. Los anexos se rellenan desde los documentos del repositorio, que describen lo que el código hace.

**Partes.** El Cliente (responsable del tratamiento) y [razón social de Meri] (encargado del tratamiento).

## 1. Objeto
El encargado trata, por cuenta del responsable, los datos personales de terceros que aparecen en el correo y el calendario que el responsable conecta a Meri, solo para prestar el servicio descrito en los términos (planificación, radar de compromisos, preparaciones de reunión y tiempo por cliente).

## 2. Instrucciones
El encargado trata los datos solo según las instrucciones documentadas del responsable, que son la configuración que este elige en la aplicación (conexiones, exclusiones de correo, retención, autonomía). Meri no envía correos en nombre del responsable: solo crea borradores que este revisa.

## 3. Confidencialidad
Las personas autorizadas están sujetas a confidencialidad. No existe herramienta interna para leer el contenido de los clientes.

## 4. Seguridad
Medidas del Anexo II. El encargado avisa sin dilación indebida, y en todo caso en un plazo de 48 horas, de cualquier violación de seguridad que afecte a los datos del responsable, con la información del art. 33.3 RGPD de que disponga.

## 5. Subencargados
El responsable autoriza a los subencargados del Anexo III. Cualquier cambio se comunica con 30 días de antelación; el responsable puede oponerse y, si no hay alternativa, resolver el contrato sin penalización.

## 6. Derechos de los interesados
El encargado ayuda al responsable con herramientas de exportación (JSON y ZIP), corrección y supresión disponibles en la aplicación.

## 7. Supresión y devolución
Al terminar el servicio, el responsable exporta sus datos y borra la cuenta. El encargado purga todos los datos a los 30 días y lo verifica con el procedimiento de [`deletion-verification.md`](deletion-verification.md). Las copias de seguridad caducan en ≤ 30 días; una restauración reaplica las supresiones registradas.

## 8. Auditoría
El encargado pone a disposición la información necesaria para demostrar el cumplimiento (este paquete, informes de pruebas y, cuando exista, el informe SOC 2 o CASA). Las auditorías in situ se acuerdan con 30 días de preaviso.

## 9. Transferencias internacionales
Solo con garantías adecuadas (cláusulas contractuales tipo o decisión de adecuación). Detalle en el Anexo III.

## Anexo I — Descripción del tratamiento
Categorías de interesados, de datos, finalidades y plazos: actividades 2, 3 y 4 de [`record-of-processing.md`](record-of-processing.md).

## Anexo II — Medidas técnicas y organizativas
[`record-of-processing.md`](record-of-processing.md) (medidas), [`docs/threat-model.md`](../threat-model.md) y ADR 0007.

## Anexo III — Subencargados
[`subprocessors.md`](subprocessors.md).
