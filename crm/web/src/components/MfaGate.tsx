/**
 * Puerta de verificación en dos pasos: si el rol del usuario la exige y aún no la tiene activada, la API
 * responde 403 «mfa_setup_required» y aquí se le guía para activarla (y guardar los códigos de recuperación).
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

export function MfaGate() {
  const [need, setNeed] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const h = () => setNeed(true);
    window.addEventListener("crm:mfa-required", h);
    api.get<{ mfa_setup_required?: boolean }>("auth/me").then((r) => r.mfa_setup_required && setNeed(true)).catch(() => undefined);
    return () => window.removeEventListener("crm:mfa-required", h);
  }, []);
  if (!need) return null;
  const start = async () => { setErr(""); try { setSetup(await api.post("auth/2fa/setup")); } catch (e) { setErr((e as ApiError).message); } };
  const enable = async () => { setErr(""); try { const r = await api.post<{ recovery_codes: string[] }>("auth/2fa/enable", { code }); setCodes(r.recovery_codes); } catch (e) { setErr((e as ApiError).message); } };
  return (
    <div className="mfa-gate" role="dialog" aria-modal="true" aria-labelledby="mfa-title">
      <div className="card" style={{ maxWidth: 460, width: "100%" }}>
        <h1 id="mfa-title" style={{ fontSize: 20 }}>Activa la verificación en dos pasos</h1>
        {!codes ? <>
          <p className="small">Tu rol la exige para proteger los datos de clientes y contratos. Necesitas una app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
          {!setup ? <button className="btn primary mt8" onClick={start}>Empezar</button> : <>
            <p className="small">1. Añade la cuenta en la app con esta clave (o abre el enlace en el móvil):</p>
            <code style={{ display: "block", wordBreak: "break-all", padding: 8, background: "var(--panel)", borderRadius: 6 }}>{setup.secret}</code>
            <a className="small" href={setup.otpauth}>Abrir en la app de autenticación</a>
            <p className="small mt8">2. Escribe el código de 6 cifras que muestra la app:</p>
            <div className="row"><input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label="Código de 6 cifras" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => e.key === "Enter" && enable()} /><button className="btn primary" disabled={code.length !== 6} onClick={enable}>Activar</button></div>
          </>}
          {err && <p className="small" role="alert" style={{ color: "var(--risk-ink)" }}>{err}</p>}
        </> : <>
          <p className="small">Listo. Guarda estos <b>códigos de recuperación</b> en un lugar seguro: cada uno sirve una vez si pierdes el móvil. No se volverán a mostrar.</p>
          <pre style={{ columns: 2, background: "var(--panel)", padding: 10, borderRadius: 6 }}>{codes.join("\n")}</pre>
          <div className="row"><button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copiar</button><button className="btn primary" onClick={() => location.reload()}>He guardado los códigos</button></div>
        </>}
      </div>
    </div>
  );
}
