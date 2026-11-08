// Cancela correos programados: los borra de la Bandeja de salida (van a la Papelera y no se envían).
// Uso: node cancelar.js cancelar.json     cancelar.json = [{ id, buscar, asunto }]
// Solo borra filas que estén en BANDEJA DE SALIDA y cuyo asunto coincida exactamente.
// Imprime por correo: OK <id> | NO_ESTA <id> | FALLO <id> motivo
const fs = require('fs');
const { abrir, abrirBandeja } = require('./comun');
const lista = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  const buscar = async (q) => {
    const caja = p.locator('input.zmSearchTB:visible').first();
    await caja.click(); await caja.fill(''); await caja.type(q, { delay: 8 });
    await p.keyboard.press('Enter'); await p.waitForTimeout(1500); await p.keyboard.press('Escape');
    await p.waitForTimeout(3500);
  };
  const filaObjetivo = async (asunto) => {
    const filas = p.locator('div.zmList:visible');
    const n = await filas.count();
    for (let i = 0; i < n; i++) {
      const t = norm(await filas.nth(i).innerText());
      if (t.includes('bandeja de salida') && t.includes(norm(asunto))) return filas.nth(i);
    }
    return null;
  };
  for (const c of lista) {
    let paso = 'buscar';
    try {
      let fila = null;
      for (const q of [c.buscar, c.asunto.replace(/^Apoyo legal para /, '')]) {
        if (!q) continue;
        await buscar(q);
        fila = await filaObjetivo(c.asunto);
        if (fila) break;
      }
      if (!fila) { console.log(`NO_ESTA ${c.id}`); continue; }
      paso = 'abrir'; await fila.click({ timeout: 10000 }); await p.waitForTimeout(2000);   // abre el correo (no lo envía)
      paso = 'borrar'; await p.keyboard.press('Delete');                   // atajo de Zoho: mover a la Papelera
      await p.waitForTimeout(2000);
      if (process.env.DEPURAR) await p.screenshot({ path: process.env.HOME + '/zoho/canc-del.png' });
      // Zoho pide confirmar: "se eliminará de forma permanente" → Aceptar
      paso = 'confirmar';
      const aceptar = p.locator('button:visible').filter({ hasText: /^\s*Aceptar\s*$/ }).first();
      await aceptar.waitFor({ timeout: 8000 });
      await aceptar.click();
      await p.waitForTimeout(2000);
      // Verificación: ya no debe estar en la Bandeja de salida
      paso = 'verificar'; await buscar(c.buscar || c.asunto);
      if (await filaObjetivo(c.asunto)) console.log(`FALLO ${c.id} sigue en la bandeja de salida`);
      else console.log(`OK ${c.id}`);
    } catch (e) { console.log(`FALLO ${c.id} [${paso}] ${e.message.split('\n')[0]}`); }
  }
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
