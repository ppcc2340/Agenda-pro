# 0002. Componentes de interfaz propios (convención shadcn/ui, sin su CLI)

- Estado: aceptada
- Fecha: 2026-10-19

## Contexto
`docs/02` propone Tailwind + shadcn/ui. La CLI de shadcn genera código en el repositorio a partir de un registro remoto y cambia de versión con frecuencia; el diseño de Meri (`docs/11`) usa tokens propios y pocos componentes.

## Opciones consideradas
1. CLI de shadcn/ui para generar componentes y adaptarlos.
2. Componentes propios en `apps/web/src/components/ui` siguiendo la misma convención (`cva`, `clsx` + `tailwind-merge`, primitivas Radix para diálogos y accesibilidad).

## Decisión
Opción 2. Mismo modelo mental y mismas dependencias que shadcn/ui, sin depender de su CLI ni de su registro. Tailwind 4 con tokens de `docs/11` definidos en CSS. Estado de servidor con TanStack Query; formularios con React Hook Form + Zod; textos solo por `next-intl` y la regla `react/jsx-no-literals` impide literales en JSX.

## Consecuencias
- Menos código generado y control total del diseño; hay que escribir cada componente (botón, diálogo, campo, pestañas, chip, pill, toast).
- Si en el futuro se adopta la CLI, la convención es compatible.
