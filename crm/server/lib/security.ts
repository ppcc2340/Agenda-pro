/** Política de contraseñas y códigos de recuperación de la verificación en dos pasos. */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sha256 } from "./util.js";

const COMMON = new Set(["password1234", "contraseña123", "123456789012", "qwertyuiop12", "administrador", "passwordpassword", "letmein12345", "welcome12345", "bienvenido123", "123456789abc"]);
export const PASSWORD_MIN = 12;
/** Mínimo 12 caracteres, con letras y números, sin ser una contraseña común ni contener el email. */
export function passwordSchema(email?: string) {
  return z.string().min(PASSWORD_MIN, `Mínimo ${PASSWORD_MIN} caracteres`).max(200)
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Combina letras y números")
    .refine((p) => !COMMON.has(p.toLowerCase()), "Esa contraseña es demasiado común")
    .refine((p) => !email || !p.toLowerCase().includes(email.split("@")[0]!.toLowerCase()), "No uses tu email en la contraseña");
}
/** 10 códigos de un solo uso (xxxx-xxxx); se guardan solo sus hashes. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => { const h = randomBytes(5).toString("hex"); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  return { codes, hashes: codes.map((c) => sha256(c)) };
}
/** Consume un código si es válido; devuelve la lista restante o null si no coincide. */
export function useRecoveryCode(stored: unknown, code: string): string[] | null {
  let list: string[] = []; try { list = typeof stored === "string" ? JSON.parse(stored) : Array.isArray(stored) ? (stored as string[]) : []; } catch { list = []; }
  const h = sha256(code.trim().toLowerCase()); const i = list.indexOf(h);
  if (i < 0) return null;
  list.splice(i, 1); return list;
}
