import { useState } from "react";
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Clock, AlertTriangle, Plus, Pencil, Palette, ArrowLeft, ArrowRight, Trash2, Percent, CalendarClock } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Menu, Modal, Field, useToast, useConfirm, errorMessage } from "./ui";
import { ColorPicker, RenameDialog } from "./DataTable";
import { fmtMoney, fmtDate, initials } from "../lib/format";

export interface BoardDeal { id: string; name: string; company_name: string | null; amount: number; currency: string; probability: number; expected_close_date: string | null; owner_name: string | null; days_in_stage: number; stale: boolean; light: "green" | "yellow" | "red"; next_task_at: string | null; status: string; weighted_amount: number }
export interface BoardStage { id: string; name: string; color: string; kind: string; expected_days: number; deals: BoardDeal[]; count: number; amount: number; weighted: number }

export function Kanban({ stages, pipelineId, editable, onMove, onOpen, onStagesChanged }: { stages: BoardStage[]; pipelineId?: string; editable?: boolean; onMove: (dealId: string, stageId: string) => Promise<void>; onOpen: (d: BoardDeal) => void; onStagesChanged?: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const addStage = async () => { if (!newName.trim() || !pipelineId) return; try { await api.post(`pipelines/${pipelineId}/stages`, { name: newName.trim(), probability: 50, color: "#a25ddc", expected_days: 14 }); setNewName(""); setAdding(false); toast("Etapa añadida", "ok"); onStagesChanged?.(); } catch (e) { toast(errorMessage(e), "error"); } };
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
        {stages.map((s, i) => <Column key={s.id} stage={s} index={i} all={stages} pipelineId={pipelineId} editable={!!editable} onOpen={onOpen} onChanged={onStagesChanged} />)}
        {editable && pipelineId && (
          <div className="kcol kadd">
            {adding ? <div className="col"><input className="input sm" autoFocus placeholder="Nombre de la etapa" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addStage(); if (e.key === "Escape") setAdding(false); }} /><div className="row"><button className="btn primary sm" onClick={addStage}>Añadir</button><button className="btn ghost sm" onClick={() => setAdding(false)}>Cancelar</button></div></div>
              : <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setAdding(true)}><Plus />Añadir etapa</button>}
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={null}><div className="drag-overlay">{active && <Card d={active} overlay />}</div></DragOverlay>
    </DndContext>
  );
}

function Column({ stage, index, all, pipelineId, editable, onOpen, onChanged }: { stage: BoardStage; index: number; all: BoardStage[]; pipelineId?: string; editable: boolean; onOpen: (d: BoardDeal) => void; onChanged?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const toast = useToast();
  const confirm = useConfirm();
  const { pipelines } = useApp();
  const [rename, setRename] = useState(false);
  const [pick, setPick] = useState(false);
  const [edit, setEdit] = useState<"probability" | "expected_days" | null>(null);
  const full = pipelines.find((p) => p.id === pipelineId)?.stages.find((s) => s.id === stage.id);
  const patch = async (body: Record<string, unknown>) => { if (!pipelineId) return; try { await api.put(`pipelines/${pipelineId}/stages/${stage.id}`, body); onChanged?.(); } catch (e) { toast(errorMessage(e), "error"); } };
  const move = async (dir: -1 | 1) => { if (!pipelineId) return; const open = all.filter((s) => s.kind === "open").map((s) => s.id); const i = open.indexOf(stage.id); const j = i + dir; if (i < 0 || j < 0 || j >= open.length) return; [open[i], open[j]] = [open[j]!, open[i]!]; try { await api.put(`pipelines/${pipelineId}/stages-order`, { order: open }); onChanged?.(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!pipelineId) return; if (!(await confirm({ title: `¿Borrar la etapa «${stage.name}»?`, text: stage.count ? "Mueve antes los negocios a otra etapa." : undefined, danger: true, confirmText: "Borrar" }))) return; try { await api.del(`pipelines/${pipelineId}/stages/${stage.id}`); toast("Etapa borrada", "ok"); onChanged?.(); } catch (e) { toast(errorMessage(e), "error"); } };
  const canEdit = editable && !!pipelineId;
  return (
    <div className={`kcol ${isOver ? "over" : ""}`} style={{ "--stage": stage.color } as React.CSSProperties}>
      <div className="kcol-head" style={{ position: "relative" }}>
        <div className="t"><span className="ell" onClick={() => canEdit && setRename(true)} style={canEdit ? { cursor: "text" } : undefined} title={canEdit ? "Clic para renombrar" : undefined}>{stage.name}</span><span className="row" style={{ gap: 4 }}><span className="num">{stage.count}</span>{canEdit && <Menu trigger={<button className="kmenu" aria-label="Opciones de etapa">⋯</button>}>
          <button onClick={() => setRename(true)}><Pencil />Renombrar</button>
          <button onClick={() => setPick(true)}><Palette />Cambiar color</button>
          {stage.kind === "open" && <button onClick={() => setEdit("probability")}><Percent />Probabilidad: {full?.probability ?? "–"}%</button>}
          {stage.kind === "open" && <button onClick={() => setEdit("expected_days")}><CalendarClock />Días esperados: {stage.expected_days}</button>}
          {stage.kind === "open" && index > 0 && <button onClick={() => move(-1)}><ArrowLeft />Mover a la izquierda</button>}
          {stage.kind === "open" && <button onClick={() => move(1)}><ArrowRight />Mover a la derecha</button>}
          {stage.kind === "open" && <button onClick={del} style={{ color: "var(--risk)" }}><Trash2 />Borrar etapa</button>}
        </Menu>}</span></div>
        <div className="m num">{fmtMoney(stage.amount)} · pond. {fmtMoney(stage.weighted)}</div>
        {pick && <ColorPicker value={stage.color} onPick={(c) => { setPick(false); patch({ color: c }); }} onClose={() => setPick(false)} />}
      </div>
      <div className="kcol-body" ref={setNodeRef}>
        {stage.deals.map((d) => <DraggableCard key={d.id} d={d} onOpen={onOpen} />)}
        {stage.deals.length === 0 && <div className="muted small" style={{ textAlign: "center", padding: 12 }}>Arrastra aquí</div>}
      </div>
      {rename && <RenameDialog title="Renombrar etapa" value={stage.name} onClose={() => setRename(false)} onSave={(n) => { setRename(false); patch({ name: n }); }} />}
      {edit && <NumberDialog title={edit === "probability" ? "Probabilidad de cierre (%)" : "Días esperados en la etapa"} value={edit === "probability" ? (full?.probability ?? 50) : stage.expected_days} min={edit === "probability" ? 0 : 1} max={edit === "probability" ? 100 : 365} onClose={() => setEdit(null)} onSave={(v) => { setEdit(null); patch({ [edit]: v }); }} />}
    </div>
  );
}

function NumberDialog({ title, value, min, max, onClose, onSave }: { title: string; value: number; min: number; max: number; onClose: () => void; onSave: (v: number) => void }) {
  const [v, setV] = useState(value);
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave(Math.max(min, Math.min(max, v)))}>Guardar</button></>}><Field label={title}><input className="input" type="number" min={min} max={max} autoFocus value={v} onChange={(e) => setV(Number(e.target.value))} onKeyDown={(e) => e.key === "Enter" && onSave(Math.max(min, Math.min(max, v)))} /></Field></Modal>;
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
