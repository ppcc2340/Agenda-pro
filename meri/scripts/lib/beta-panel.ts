/**
 * Beta decision panel and report (D-100, D-104): aggregates → `decide()` (@meri/core) → text, JSON or a Markdown
 * draft. Only aggregates ever leave the database; figures under the minimum sample are shown as «sin datos».
 */
import { decide, type DecisionInput, type DecisionPanel, type IndicatorKey, type Verdict } from "@meri/core";
import {
  ADMIN_WORKSPACE_CONTEXT,
  createDb,
  listGlobalFlags,
  loadBetaAggregates,
  type BetaAggregates,
} from "@meri/db";
import { z } from "zod";

const WorkerReady = z.object({
  queues: z.record(z.object({ failed: z.number().int().nonnegative().default(0) })).default({}),
  deadLetter: z.number().int().nonnegative().optional(),
});

export interface Reliability {
  /** Failed jobs still retained per queue (BullMQ keeps recent failures), from the worker's `/ready`. */
  failedByQueue: Record<string, number> | null;
  deadLetter: number | null;
  degradedAccounts: number;
  needsReauthAccounts: number;
}

export interface PanelResult {
  generatedAt: string;
  panel: DecisionPanel;
  reliability: Reliability;
  priceExperiment: boolean;
}

export function toDecisionInput(a: BetaAggregates): DecisionInput {
  const opinions = a.seanEllis.very + a.seanEllis.somewhat + a.seanEllis.not;
  return {
    indicators: {
      retention60: a.retention[60],
      trialToPaid: a.trialToPaid,
      confirmedUnedited: a.confirmedUnedited,
      gmailKept30: a.gmailKept30,
      seanEllisVery: { hits: a.seanEllis.very, n: opinions },
      grossMargin: { meanPct: a.grossMargin.meanPct, n: a.grossMargin.n },
    },
    extra: {
      retention30: a.retention[30],
      retention90: a.retention[90],
      "trialToPaid.A": a.trialToPaidByCohort.A,
      "trialToPaid.B": a.trialToPaidByCohort.B,
    },
  };
}

async function workerReliability(url: string | undefined, fetchImpl: typeof fetch) {
  if (!url) return { failedByQueue: null, deadLetter: null };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    // The worker's answer is validated like any other input.
    const body = WorkerReady.parse(await res.json());
    const failedByQueue = Object.fromEntries(Object.entries(body.queues).map(([q, c]) => [q, c.failed]));
    return { failedByQueue, deadLetter: body.deadLetter ?? null };
  } catch {
    return { failedByQueue: null, deadLetter: null };
  }
}

export async function collectPanel(options: {
  adminUrl: string;
  now: Date;
  minSample?: number;
  workerReadyUrl?: string;
  fetch?: typeof fetch;
  workspaceIds?: string[];
}): Promise<PanelResult> {
  // Read-only session in the admin read context: the panel can never change anything.
  const handle = createDb(options.adminUrl, {
    max: 1,
    connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT, default_transaction_read_only: "on" },
  });
  try {
    const aggregates = await loadBetaAggregates(handle.db, options.now, {
      ...(options.workspaceIds ? { workspaceIds: options.workspaceIds } : {}),
    });
    const flags = await listGlobalFlags(handle.db);
    const worker = await workerReliability(options.workerReadyUrl, options.fetch ?? fetch);
    return {
      generatedAt: options.now.toISOString(),
      panel: decide(toDecisionInput(aggregates), {
        ...(options.minSample ? { minSample: options.minSample } : {}),
      }),
      reliability: {
        ...worker,
        degradedAccounts: aggregates.accounts.degraded,
        needsReauthAccounts: aggregates.accounts.needsReauth,
      },
      priceExperiment: flags.price_experiment === true,
    };
  } finally {
    await handle.close();
  }
}

const LABEL: Record<IndicatorKey, string> = {
  retention60: "Retención a 60 días (de usuarios activados)",
  trialToPaid: "Conversión prueba→pago",
  confirmedUnedited: "Propuestas confirmadas sin editar",
  gmailKept30: "Gmail conectado a 30 días",
  seanEllisVery: "«Muy decepcionado» (Sean Ellis)",
  grossMargin: "Margen bruto por usuario",
};
const EXTRA_LABEL: Record<string, string> = {
  retention30: "Retención a 30 días",
  retention90: "Retención a 90 días",
  "trialToPaid.A": "Conversión, cohorte de precio A",
  "trialToPaid.B": "Conversión, cohorte de precio B",
};
export const VERDICT_LABEL: Record<Verdict, string> = {
  advance: "avanzar",
  iterate: "iterar",
  pivot: "pivotar/parar",
  no_data: "sin datos",
};

const figure = (valuePct: number | null, n: number, min: number) =>
  valuePct === null || n < min ? `sin datos (n=${String(n)})` : `${valuePct.toFixed(1)} % (n=${String(n)})`;

/** How many of the six indicators back the recommendation (one indicator alone is not a decision). */
const coverage = (r: PanelResult) =>
  `${String(r.panel.indicators.filter((i) => i.verdict !== "no_data").length)} de ${String(r.panel.indicators.length)} indicadores con datos`;

export function renderText(r: PanelResult): string {
  const min = r.panel.minSample;
  const lines = [
    `Panel de decisión de la beta — ${r.generatedAt} (muestra mínima ${String(min)})`,
    "",
    ...r.panel.indicators.map(
      (i) =>
        `  ${LABEL[i.key].padEnd(46)} ${figure(i.valuePct, i.n, min).padEnd(22)} umbral ≥${String(i.threshold.advance)} / ≥${String(i.threshold.iterate)}  → ${VERDICT_LABEL[i.verdict]}`,
    ),
    "",
    ...r.panel.extra.map(
      (e) => `  ${(EXTRA_LABEL[e.key] ?? e.key).padEnd(46)} ${figure(e.valuePct, e.n, min)}`,
    ),
    "",
    `  Recomendación: ${VERDICT_LABEL[r.panel.recommendation].toUpperCase()} (el peor veredicto entre los indicadores con datos; ${coverage(r)})`,
    `  Experimento de precio: ${r.priceExperiment ? "activo" : "apagado"}`,
    "",
    "Fiabilidad",
    r.reliability.failedByQueue
      ? `  Trabajos fallidos retenidos por cola: ${
          Object.entries(r.reliability.failedByQueue)
            .filter(([, n]) => n > 0)
            .map(([q, n]) => `${q}=${String(n)}`)
            .join(", ") || "ninguno"
        }; cola de muertos: ${String(r.reliability.deadLetter ?? 0)}`
      : "  Worker no disponible (WORKER_READY_URL): sin datos de colas",
    `  Conexiones degradadas: ${String(r.reliability.degradedAccounts)}; pendientes de reconectar: ${String(r.reliability.needsReauthAccounts)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderReport(r: PanelResult): string {
  const min = r.panel.minSample;
  const date = r.generatedAt.slice(0, 10);
  return `# Informe de la beta — borrador (${date})

> **Borrador generado por \`pnpm beta:report\`.** Solo es válido con datos reales de la beta: en desarrollo, en la
> demo o con muestras por debajo de ${String(min)} el veredicto no significa nada. La decisión final (avanzar /
> iterar / pivotar) la toma una persona con este panel, las entrevistas y los motivos de cancelación (docs/09).

## Recomendación del panel
**${VERDICT_LABEL[r.panel.recommendation]}** — el peor veredicto entre los indicadores con muestra suficiente (${coverage(r)}).

## Indicadores (umbrales de docs/09)
| Indicador | Valor | Avanzar | Iterar | Veredicto |
|---|---|---|---|---|
${r.panel.indicators
  .map(
    (i) =>
      `| ${LABEL[i.key]} | ${figure(i.valuePct, i.n, min)} | ≥ ${String(i.threshold.advance)} % | ≥ ${String(i.threshold.iterate)} % | ${VERDICT_LABEL[i.verdict]} |`,
  )
  .join("\n")}

## Otras cifras
| Cifra | Valor |
|---|---|
${r.panel.extra.map((e) => `| ${EXTRA_LABEL[e.key] ?? e.key} | ${figure(e.valuePct, e.n, min)} |`).join("\n")}

Experimento de precio: ${r.priceExperiment ? "activo" : "apagado"}.

## Fiabilidad
- Conexiones degradadas: ${String(r.reliability.degradedAccounts)}; pendientes de reconectar: ${String(r.reliability.needsReauthAccounts)}.
- ${r.reliability.failedByQueue ? `Trabajos fallidos retenidos: ${String(Object.values(r.reliability.failedByQueue).reduce((s, n) => s + n, 0))}; cola de muertos: ${String(r.reliability.deadLetter ?? 0)}.` : "Colas: sin datos (worker no disponible)."}

## Para completar a mano
- Los 10 problemas principales de retención y fiabilidad, con su estado (P6-07).
- Resumen de entrevistas y de motivos de cancelación.
- Decisión y siguientes pasos.
`;
}
