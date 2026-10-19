"use client";

import { parseCapture, type CaptureSuggestion } from "@meri/core";
import {
  CalendarDays,
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
import { useRouter } from "next/navigation";
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
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDateTime, formatMinutes } from "@/lib/format";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";
import type { Proposal } from "@/lib/types";

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
  const options: { id: string; label: string; icon: LucideIcon; run: () => void }[] = [
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
        {suggestion ? (
          <div className="px-4 pb-3 pt-2">
            <p className="mb-2 text-[13px] text-ink2">{t("understood")}</p>
            <CapturePreview suggestion={suggestion} timezone={data.timezone} />
          </div>
        ) : null}
        <ul className="max-h-[46vh] overflow-auto p-2" role="listbox">
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={o.run}
                className={
                  i === active
                    ? "flex w-full items-center gap-2.5 rounded-lg bg-sea-soft px-3 py-2.5 text-left"
                    : "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-sea-soft"
                }
              >
                <o.icon size={16} aria-hidden="true" />
                {o.label}
              </button>
            </li>
          ))}
        </ul>
        {!suggestion && lower.length === 0 ? (
          <p className="border-t border-rule px-5 py-2.5 text-[12.5px] text-ink3">{t("hint")}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Mobile `+` capture sheet (demo/mobile.html). */
export function MobileCapture({ data }: { data: PaletteContextData }) {
  const t = useTranslations("capture");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const capture = useCaptureMutation();
  const suggestion = q.trim()
    ? parseCapture(q, { now: new Date().toISOString(), timezone: data.timezone, clients: data.clients })
    : null;
  return (
    <>
      <button
        type="button"
        aria-label={t("mobileTitle")}
        onClick={() => setOpen(true)}
        className="fixed bottom-[84px] right-4 z-20 grid h-14 w-14 place-items-center rounded-2xl bg-sea text-on-sea shadow-[0_8px_22px_rgba(14,107,116,0.4)] md:hidden"
      >
        <Plus size={28} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-end bg-[rgba(6,14,21,0.5)] md:hidden"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("mobileTitle")}
            className="max-h-[86%] w-full overflow-auto rounded-t-3xl bg-raised px-5 pb-[calc(22px+env(safe-area-inset-bottom,0px))] pt-2.5"
          >
            <div className="mx-auto mb-3.5 h-1 w-10 rounded-full bg-rule" />
            <h2 className="text-xl">{t("mobileTitle")}</h2>
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
          </div>
        </div>
      ) : null}
    </>
  );
}
