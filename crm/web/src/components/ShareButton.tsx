/** Compartir un registro con una persona o un equipo (consulta o edición), más allá de lo que ve su rol. */
import { useCallback, useEffect, useState } from "react";
import { Share2, X, Users, User } from "lucide-react";
import { api } from "../api";
import { Modal, Field, useToast, errorMessage } from "./ui";
import { useApp } from "../lib/app";

interface Share { id: string; user_id: string | null; team_id: string | null; user_name: string | null; team_name: string | null; access: "read" | "edit"; created_by_name: string | null; created_at: string }

export function ShareButton({ object, id }: { object: "contact" | "company" | "deal" | "contract" | "ticket"; id: string }) {
  const { users, teams, me } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<Share[]>([]);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [access, setAccess] = useState<"read" | "edit">("read");
  const load = useCallback(() => api.get<{ items: Share[] }>(`shares/${object}/${id}`).then((r) => setItems(r.items)).catch(() => undefined), [object, id]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!target) return;
    const [kind, tid] = target.split(":");
    try { await api.post(`shares/${object}/${id}`, kind === "u" ? { user_id: tid, access } : { team_id: tid, access }); setTarget(""); toast("Compartido", "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); }
  };
  const remove = async (s: Share) => { try { await api.del(`shares/${s.id}`); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const names = items.map((s) => s.user_name ?? s.team_name).filter(Boolean);
  return (
    <>
      <button className="btn ghost sm share-chip" onClick={() => setOpen(true)} title="Compartir este registro">
        <Share2 size={14} />{names.length ? <span className="small">Compartido con {names.slice(0, 2).join(", ")}{names.length > 2 ? ` y ${names.length - 2} más` : ""}</span> : "Compartir"}
      </button>
      {open && <Modal title="Compartir registro" onClose={() => setOpen(false)}>
        <p className="small muted mb12">Da acceso a una persona o a un equipo aunque su rol no vea este registro. Con «edición» también puede modificarlo.</p>
        <div className="row" style={{ gap: 6, alignItems: "flex-end" }}>
          <Field label="Con"><select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Persona o equipo"><option value="">Elige una persona o un equipo…</option><optgroup label="Personas">{users.filter((u) => u.active && u.id !== me.id).map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}</optgroup><optgroup label="Equipos">{teams.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name}</option>)}</optgroup></select></Field>
          <Field label="Acceso"><select className="input" value={access} onChange={(e) => setAccess(e.target.value as "read")} aria-label="Acceso"><option value="read">Consulta</option><option value="edit">Edición</option></select></Field>
          <button className="btn primary" disabled={!target} onClick={add}>Compartir</button>
        </div>
        <div className="col mt12" style={{ gap: 4 }}>
          {!items.length && <p className="small muted">Aún no se ha compartido con nadie.</p>}
          {items.map((s) => <div key={s.id} className="row small" style={{ gap: 8, padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}>{s.user_id ? <User size={14} /> : <Users size={14} />}<b className="grow">{s.user_name ?? s.team_name}</b><span className="badge">{s.access === "edit" ? "edición" : "consulta"}</span><span className="xs muted">por {s.created_by_name ?? "—"}</span><button className="iconbtn" aria-label="Dejar de compartir" onClick={() => remove(s)}><X size={14} /></button></div>)}
        </div>
      </Modal>}
    </>
  );
}
