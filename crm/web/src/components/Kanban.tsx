import { useState } from "react";
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Clock, AlertTriangle } from "lucide-react";
import { fmtMoney, fmtDate, initials } from "../lib/format";

export interface BoardDeal { id: string; name: string; company_name: string | null; amount: number; currency: string; probability: number; expected_close_date: string | null; owner_name: string | null; days_in_stage: number; stale: boolean; light: "green" | "yellow" | "red"; next_task_at: string | null; status: string; weighted_amount: number }
export interface BoardStage { id: string; name: string; color: string; kind: string; expected_days: number; deals: BoardDeal[]; count: number; amount: number; weighted: number }

export function Kanban({ stages, onMove, onOpen }: { stages: BoardStage[]; onMove: (dealId: string, stageId: string) => Promise<void>; onOpen: (d: BoardDeal) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }));
  const [active, setActive] = useState<BoardDeal | null>(null);
  const all = stages.flatMap((s) => s.deals);
  const onStart = (e: DragStartEvent) => setActive(all.find((d) => d.id === e.active.id) ?? null);
  const onEnd = async (e: DragEndEvent) => {
    setActive(null);
    const dealId = String(e.active.id);
    const stageId = e.over ? String(e.over.id) : null;
    const from = stages.find((s) => s.deals.some((d) => d.id === dealId));
    if (!stageId || !from || from.id === stageId) return;
    await onMove(dealId, stageId);
  };
  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
      <div className="kanban">
        {stages.map((s) => <Column key={s.id} stage={s} onOpen={onOpen} />)}
      </div>
      <DragOverlay dropAnimation={null}><div className="drag-overlay">{active && <Card d={active} overlay />}</div></DragOverlay>
    </DndContext>
  );
}

function Column({ stage, onOpen }: { stage: BoardStage; onOpen: (d: BoardDeal) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div className={`kcol ${isOver ? "over" : ""}`} style={{ "--stage": stage.color } as React.CSSProperties}>
      <div className="kcol-head">
        <div className="t"><span className="ell">{stage.name}</span><span className="num">{stage.count}</span></div>
        <div className="m num">{fmtMoney(stage.amount)} · pond. {fmtMoney(stage.weighted)}</div>
      </div>
      <div className="kcol-body" ref={setNodeRef}>
        {stage.deals.map((d) => <DraggableCard key={d.id} d={d} onOpen={onOpen} />)}
        {stage.deals.length === 0 && <div className="muted small" style={{ textAlign: "center", padding: 12 }}>Arrastra aquí</div>}
      </div>
    </div>
  );
}

function DraggableCard({ d, onOpen }: { d: BoardDeal; onOpen: (d: BoardDeal) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: d.id });
  return <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? "dragging" : ""} onClick={() => onOpen(d)}><Card d={d} /></div>;
}

function Card({ d, overlay }: { d: BoardDeal; overlay?: boolean }) {
  return (
    <div className={`kcard ${d.stale ? "stale" : ""}`} style={overlay ? { width: 256 } : undefined}>
      {d.company_name && <div className="c ell" style={{ color: "var(--stage)" }}>{d.company_name}</div>}
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div className="n ell" title={d.name}>{d.name}</div>
        {d.status === "won" && <span className="badge ok">Ganado</span>}{d.status === "lost" && <span className="badge risk">Perdido</span>}
      </div>
      <div className="f">
        <span className={`light ${d.light}`} title={d.light === "green" ? "Actividad programada" : d.light === "yellow" ? "Sin actividad programada" : "Tarea vencida"} />
        <strong className="num" style={{ color: "var(--ink)" }}>{fmtMoney(d.amount, d.currency)}</strong>
        <span className="num">· {d.probability}%</span>
        {d.expected_close_date && <span className="right num" title="Cierre previsto">{fmtDate(d.expected_close_date, { day: "2-digit", month: "short" })}</span>}
      </div>
      <div className="f" style={{ marginTop: 5 }}>
        {d.stale ? <span style={{ color: "var(--warn)" }} className="row" title={`Más de lo esperado en etapa`}><AlertTriangle size={12} /> {d.days_in_stage} d</span> : <span className="row"><Clock size={12} /> {d.days_in_stage} d</span>}
        {d.owner_name && <span className="right avatar sm" title={d.owner_name}>{initials(d.owner_name)}</span>}
      </div>
    </div>
  );
}
