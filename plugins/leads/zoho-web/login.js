// Inicia sesión en Zoho Mail con un código de un solo uso que Zoho envía al propio correo.
// Uso: node login.js correo@dominio   (déjalo corriendo en segundo plano)
// Imprime CODIGO_ENVIADO y luego espera el código en $ZOHO_WEB_DIR/otp.txt (puede reintentarse
// varias veces sin pedir un código nuevo). Termina con LISTO, INCORRECTO… o SIN_CODIGO (40 min).
// No pide un código nuevo mientras corre: si se reinicia, Zoho envía otro y el anterior deja de valer.
const fs = require('fs');
const path = require('path');
const { DIR, abrir } = require('./comun');
const OTP = path.join(DIR, 'otp.txt');
const correo = process.argv[2];
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);
if (!correo) { console.log('Uso: node login.js correo@dominio'); process.exit(2); }
(async () => {
  try { fs.unlinkSync(OTP); } catch {}
  const { ctx, p } = await abrir();
  await p.goto('https://accounts.zoho.com/signin?servicename=VirtualOffice&serviceurl=https%3A%2F%2Fmail.zoho.com%2Fzm%2F', { waitUntil: 'networkidle', timeout: 60000 });
  if (p.url().includes('mail.zoho.com')) { log('LISTO (la sesión ya estaba abierta)'); await ctx.close(); return; }
  await p.fill('#login_id', correo);
  await p.click('#nextbtn');
  await p.waitForTimeout(4000);
  await p.locator('span.showmoresigininoption:visible').first().click();   // "OTP basada en correo"
  await p.waitForTimeout(4000);
  log('CODIGO_ENVIADO ' + ((await p.evaluate(() => document.body.innerText)).match(/Se ha enviado[^\n]*/) || [''])[0]);
  const limite = Date.now() + 40 * 60 * 1000;
  while (Date.now() < limite) {
    if (!fs.existsSync(OTP)) { await p.waitForTimeout(1500); continue; }
    const codigo = fs.readFileSync(OTP, 'utf8').replace(/\D/g, '');
    fs.unlinkSync(OTP);
    const cajas = p.locator('input[type="tel"]:visible');
    for (let i = 0; i < await cajas.count(); i++) await cajas.nth(i).fill('');
    await cajas.first().click();
    await p.keyboard.type(codigo, { delay: 120 });
    await p.waitForTimeout(800);
    if (await p.locator('#nextbtn:visible').count()) await p.locator('#nextbtn:visible').first().click();
    await p.waitForTimeout(8000);
    const t = await p.evaluate(() => document.body.innerText);
    if (/incorrect/i.test(t) && p.url().includes('accounts.zoho')) { log('INCORRECTO (espera otro código en otp.txt)'); continue; }
    const tarde = p.getByText('Recordármelo más tarde');      // nunca cambiar la zona horaria
    if (await tarde.count()) { await tarde.first().click(); await p.waitForTimeout(3000); }
    log('LISTO');
    await ctx.close();
    return;
  }
  log('SIN_CODIGO'); await ctx.close();
})().catch(e => { log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
