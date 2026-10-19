# Evals de IA

- `commitments/*.jsonl`: casos de extracción de compromisos (ES/EN). Meta: ≥ 200 casos antes de cerrar la Fase 2.
- `injection/*.jsonl`: correos hostiles (prompt injection). Debe pasar el 100 %.
- `reports/`: salidas de `pnpm eval`.

## Formato de caso (commitments)
```json
{"id":"c-001","lang":"es","message":{"id":"m1","from":"ana@acme.com","to":["yo@mifirma.com"],"date":"2026-10-12T10:00:00Z","body":"Hola, te envío el contrato firmado el miércoles."},"me":"yo@mifirma.com","expected":[{"direction":"owed_to_me","action":"enviar contrato firmado","kind":"explicit","dueText":"el miércoles"}]}
```
Los casos deben ser **sintéticos o anonimizados**; nunca datos reales de clientes.
