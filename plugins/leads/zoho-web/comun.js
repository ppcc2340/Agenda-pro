// Utilidades comunes para manejar Zoho Mail desde el navegador (sin contraseñas guardadas).
// La sesión vive en el perfil del navegador: $ZOHO_WEB_DIR (por defecto ~/.zoho-web/perfil).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = process.env.ZOHO_WEB_DIR || path.join(process.env.HOME, '.zoho-web');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

async function abrir() {
  const ctx = await chromium.launchPersistentContext(path.join(DIR, 'perfil'),
    { viewport: { width: 1400, height: 900 }, locale: 'es-CL' });
  const p = ctx.pages()[0] || await ctx.newPage();
  return { ctx, p };
}

// Abre la bandeja y espera a que la app termine de cargar. Devuelve false si no hay sesión.
async function abrirBandeja(p) {
  await p.goto('https://mail.zoho.com/zm/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let k = 0; k < 90; k++) {
    if (p.url().includes('accounts.zoho')) {
      // Aviso de zona horaria tras iniciar sesión: nunca cambiarla, solo posponer.
      const tarde = p.getByText('Recordármelo más tarde');
      if (await tarde.count()) { await tarde.first().click(); await p.waitForTimeout(3000); continue; }
      if (await p.locator('#login_id, input[type="password"]').count()) return false;
    }
    if (/#mail\/folder/.test(p.url()) && await p.getByRole('button', { name: 'Correo nuevo' }).count()) {
      await p.waitForTimeout(5000);   // si se redacta antes, Zoho vuelve sola a la bandeja
      return true;
    }
    await p.waitForTimeout(1000);
  }
  return false;
}

module.exports = { DIR, abrir, abrirBandeja };
