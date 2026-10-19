"use client";

import { parseCapture, type CaptureSuggestion } from "@meri/core";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  CalendarDays,
  Handshake,
  Inbox,
  Layers,
  ListChecks,
  Mail,
  Plus,
  Search,
  SlidersHorizontal,
  Sun,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ClientChip } from "@/components/ui/client-chip";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDateTime, formatMinutes } from "@/lib/format";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";
import type { Proposal, SearchHit } from "@/lib/types";

interface PaletteApi {
  open: () => void;
  close: () => void;
}
const PaletteContext = createContext<PaletteApi>({ open: () => {}, close: () => {} });
export const usePalette = () => useContext(PaletteContext);

export interface PaletteContextData {
  clients: { id: string; name: string }[];
  timezone: string;
}

type CommandKey = "hoy" | "entrada" | "tasks" | "risks" | "waiting" | "replan" | "calendar" | "control";
const COMMANDS: { key: CommandKey; icon: LucideIcon; href: string }[] = [
  { key: "hoy", icon: Sun, href: "/hoy" },
  { key: "entrada", icon: Inbox, href: "/entrada" },
  { key: "tasks", icon: ListChecks, href: "/proyectos?tab=tareas" },
  { key: "risks", icon: TriangleAlert, href: "/hoy#risks" },
  { key: "waiting", icon: Mail, href: "/hoy#waiting" },
  { key: "replan", icon: Layers, href: "/hoy?replan=1" },
  { key: "calendar", icon: CalendarDays, href: "/calendario" },
  { key: "control", icon: SlidersHorizontal, href: "/control" },
];

/**
 * Global capture + commands (docs/11 "Captura global con Ctrl/⌘ K"). The preview runs the same rules parser the API
 * uses (@meri/core), so what the user sees is what Meri understood; the proposal itself is created server-side.
 */
export function PaletteProvider({ children, data }: { children: ReactNode; data: PaletteContextData }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => {
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const api = useMemo(() => ({ open, close }), [open, close]);
  return (
    <PaletteContext.Provider value={api}>
      {children}
      {isOpen ? <Palette data={data} onClose={close} /> : null}
    </PaletteContext.Provider>
  );
}

export function CapturePreview({
  suggestion,
  timezone,
}: {
  suggestion: CaptureSuggestion;
  timezone: string;
}) {
  const t = useTranslations("inbox");
  const tTasks = useTranslations("tasks");
  const locale = useLocale();
  return (
    <div className="flex flex-wrap gap-2" aria-live="polite">
      <Pill variant="sug">{suggestion.title}</Pill>
      {suggestion.clientName ? <Pill variant="sug">{suggestion.clientName}</Pill> : null}
      {suggestion.dueAt ? (
        <Pill variant="sug">
          {t("forDate", { date: formatDateTime(suggestion.dueAt, locale, timezone) })}
        </Pill>
      ) : null}
      {suggestion.estimateMinutes ? (
        <Pill variant="sug">{formatMinutes(suggestion.estimateMinutes, (k, v) => tTasks(k, v))}</Pill>
      ) : null}
    </div>
  );
}

export function useCaptureMutation() {
  const t = useTranslations("capture");
  const { toast } = useToast();
  const dismiss = useApiMutation(
    (id: string) => clientApi(`/v1/proposals/${id}/dismiss`, { method: "POST", json: {} }),
    [keys.proposals],
  );
  return useApiMutation(
    (text: string) =>
      clientApi<Proposal>("/v1/capture", {
        method: "POST",
        json: { text },
        headers: { "idempotency-key": idempotencyKey() },
      }),
    [keys.proposals],
    {
      onSuccess: (p) => {
        toast(t("captured"), { undo: () => dismiss.mutate(p.id), undoLabel: t("undo") });
      },
    },
  );
}

/** "contrato en Acme" → scope the search to Acme (F-09 AC2); the chip shows the scope. */
export function splitScope(
  q: string,
  clients: { id: string; name: string }[],
): { term: string; client: { id: string; name: string } | null } {
  const m = /^(.*?)\s+(?:en|in)\s+(.+)$/i.exec(q.trim());
  if (m) {
    const name = (m[2] ?? "").toLowerCase();
    const client = clients.find((c) => c.name.toLowerCase() === name || c.name.toLowerCase().startsWith(name));
    if (client) return { term: (m[1] ?? "").trim(), client };
  }
  return { term: q.trim(), client: null };
}

const HIT_ICON: Record<SearchHit["type"], LucideIcon> = { task: ListChecks, commitment: Handshake, client: Briefcase };
const hitHref = (h: SearchHit) =>
  h.type === "client"
    ? `/clientes/${h.id}`
    : h.type === "task"
      ? `/proyectos?tab=tareas${h.clientId ? `&clientId=${h.clientId}` : ""}#task-${h.id}`
      : `/proyectos?tab=compromisos${h.clientId ? `&clientId=${h.clientId}` : ""}#commitment-${h.id}`;

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

function Palette({ data, onClose }: { data: PaletteContextData; onClose: () => void }) {
  const t = useTranslations("capture");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const capture = useCaptureMutation();
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const lower = q.trim().toLowerCase();
  const commands = COMMANDS.filter((c) => !lower || t(`commands.${c.key}`).toLowerCase().includes(lower));
  const isCapture = q.trim().length > 3 && (commands.length === 0 || q.trim().split(" ").length > 2);
  const suggestion = isCapture
    ? parseCapture(q, { now: new Date().toISOString(), timezone: data.timezone, clients: data.clients })
    : null;
  const scope = splitScope(q, data.clients);
  const debounced = useDebounced(scope.term, 200);
  const search = useQuery({
    queryKey: ["search", debounced, scope.client?.id ?? ""],
    queryFn: () =>
      clientApi<{ items: SearchHit[] }>(
        `/v1/search?q=${encodeURIComponent(debounced)}${scope.client ? `&clientId=${scope.client.id}` : ""}`,
      ),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });
  const hits = debounced.length >= 2 ? (search.data?.items ?? []).slice(0, 8) : [];
  const options: { id: string; label: string; icon: LucideIcon; run: () => void; meta?: string }[] = [
    ...hits.map((h) => ({
      id: `hit-${h.type}-${h.id}`,
      label: h.title,
      meta:
        t(`search.${h.type}`) +
        (h.clientId && h.type !== "client" ? ` · ${data.clients.find((c) => c.id === h.clientId)?.name ?? ""}` : ""),
      icon: HIT_ICON[h.type],
      run: () => {
        router.push(hitHref(h));
        onClose();
      },
    })),
    ...(isCapture
      ? [
          {
            id: "capture",
            label: t("captureInInbox", { text: q.trim() }),
            icon: Plus,
            run: () => {
              capture.mutate(q.trim());
              onClose();
            },
          },
        ]
      : []),
    ...commands.map((c) => ({
      id: c.key,
      label: t(`commands.${c.key}`),
      icon: c.icon,
      run: () => {
        router.push(c.href);
        onClose();
      },
    })),
  ];
  const active = Math.min(idx, Math.max(0, options.length - 1));

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-[rgba(6,14,21,0.55)] pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("placeholder")}
        className="w-[min(640px,92vw)] overflow-hidden rounded-2xl border border-rule bg-raised shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-rule px-4">
          <Search size={16} aria-hidden="true" className="text-ink3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, options.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                options[active]?.run();
              }
            }}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            className="w-full bg-transparent px-1 py-4 text-[17px] font-medium outline-none"
          />
        </div>
        {scope.client ? (
          <div className="px-4 pt-2">
            <Pill variant="sea">
              {t("search.scope")} <ClientChip clientId={scope.client.id} clients={data.clients} />
            </Pill>
          </div>
        ) : null}
        {suggestion ? (
          <div className="px-4 pb-3 pt-2">
            <p className="mb-2 text-[13px] text-ink2">{t("understood")}</p>
            <CapturePreview suggestion={suggestion} timezone={data.timezone} />
          </div>
        ) : null}
        <ul className="max-h-[46vh] overflow-auto p-2" aria-label={t("placeholder")}>
          {options.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                aria-current={i === active ? "true" : undefined}
                onMouseEnter={() => setIdx(i)}
                onClick={o.run}
                className={
                  i === active
                    ? "flex w-full items-center gap-2.5 rounded-lg bg-sea-soft px-3 py-2.5 text-left"
                    : "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-sea-soft"
                }
              >
                <o.icon size={16} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.meta ? <span className="shrink-0 text-[12px] text-ink3">{o.meta}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {!suggestion && lower.length === 0 ? (
          <p className="border-t border-rule px-5 py-2.5 text-[12.5px] text-ink3">{t("hint")}</p>
        ) : null}
        {debounced.length >= 2 && search.isFetching ? (
          <p className="border-t border-rule px-5 py-2.5 text-[12.5px] text-ink3" aria-live="polite">
            {t("search.searching")}
          </p>
        ) : null}
        {debounced.length >= 2 && !search.isFetching && options.length === 0 ? (
          <p className="border-t border-rule px-5 py-2.5 text-[12.5px] text-ink3">{t("search.empty", { q: scope.term })}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Mobile `+` capture sheet (demo/mobile.html) on the Radix dialog (ADR 0002): Escape closes, focus is trapped
 * and returns to the `+` button. Hidden on the «Más» sub-pages, as in the demo.
 */
export function MobileCapture({ data }: { data: PaletteContextData }) {
  const t = useTranslations("capture");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const capture = useCaptureMutation();
  const suggestion = q.trim()
    ? parseCapture(q, { now: new Date().toISOString(), timezone: data.timezone, clients: data.clients })
    : null;
  if (pathname.startsWith("/mas/")) return null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={t("mobileTitle")}
          className="fixed bottom-[84px] right-4 z-20 grid h-14 w-14 place-items-center rounded-2xl bg-sea text-on-sea shadow-[0_8px_22px_rgba(14,107,116,0.4)] md:hidden"
        >
          <Plus size={28} aria-hidden="true" />
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(6,14,21,0.5)] md:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[86%] w-full overflow-auto rounded-t-3xl bg-raised px-5 pb-[calc(22px+env(safe-area-inset-bottom,0px))] pt-2.5 focus:outline-none md:hidden"
        >
            <div className="mx-auto mb-3.5 h-1 w-10 rounded-full bg-rule" />
            <DialogPrimitive.Title className="font-head text-xl font-semibold">{t("mobileTitle")}</DialogPrimitive.Title>
            <p className="mb-3 mt-1 text-ink2">{t("mobileSub")}</p>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && q.trim()) {
                  capture.mutate(q.trim());
                  setOpen(false);
                  setQ("");
                }
              }}
              placeholder={t("hint")}
              aria-label={t("mobileTitle")}
              className="w-full rounded-xl border border-rule bg-panel px-3.5 py-3 text-[17px] font-medium"
            />
            <div className="my-3 min-h-7">
              {suggestion ? <CapturePreview suggestion={suggestion} timezone={data.timezone} /> : null}
            </div>
            <button
              type="button"
              disabled={!q.trim()}
              onClick={() => {
                capture.mutate(q.trim());
                setOpen(false);
                setQ("");
              }}
              className="w-full rounded-xl bg-sea px-3.5 py-3 text-[15px] font-semibold text-on-sea disabled:opacity-50"
            >
              {t("mobileAdd")}
            </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
