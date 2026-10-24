import { useState } from "react";
import { api } from "../api";
import { errorMessage } from "../components/ui";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"login" | "2fa">("login");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      if (step === "login") { const r = await api.post<{ requires_2fa?: boolean }>("auth/login", { email, password }); if (r.requires_2fa) setStep("2fa"); else onLogin(); }
      else { await api.post("auth/2fa", { code }); onLogin(); }
    } catch (ex) { setErr(errorMessage(ex)); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="box" onSubmit={submit}>
        <div className="row mb16"><span className="logo avatar" style={{ borderRadius: 8 }}>C</span><h1>CRM</h1></div>
        {step === "login" ? (<>
          <p className="sub mb16">Inicia sesión con tu cuenta de empresa.</p>
          <div className="col" style={{ gap: 12 }}>
            <div className="field"><label>Email</label><input className="input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div className="field"><label>Contraseña</label><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          </div>
        </>) : (<>
          <p className="sub mb16">Introduce el código de 6 dígitos de tu aplicación de autenticación.</p>
          <div className="field"><label>Código</label><input className="input" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} required maxLength={8} style={{ fontSize: 22, letterSpacing: 6, textAlign: "center" }} /></div>
        </>)}
        {err && <div className="alert error mt12">{err}</div>}
        <button className="btn primary mt16" style={{ width: "100%" }} disabled={busy}>{step === "login" ? "Entrar" : "Verificar"}</button>
        {step === "2fa" && <button type="button" className="btn ghost mt8" style={{ width: "100%" }} onClick={() => setStep("login")}>Volver</button>}
      </form>
    </div>
  );
}
