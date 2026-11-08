// Envía correos desde Zoho Mail web, en texto tal cual. Uso: node enviar.js correos.json [segundos_entre_envios]
// correos.json = [{ id, para, asunto, cuerpo }]. Imprime por correo: OK <id> | FALLO <id> [paso] motivo
const fs = require('fs');
const path = require('path');
const { DIR, abrir, abrirBandeja } = require('./comun');
const correos = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pausa = Number(process.argv[3] || 45) * 1000;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (txt) => txt.split('\n').map(l => `<div>${l.trim() ? esc(l) : '<br>'}</div>`).join('');
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  const nuevo = p.getByRole('button', { name: 'Correo nuevo' });
  const campoPara = p.locator('input.zmCRInputText:visible');
  for (const [i, c] of correos.entries()) {
    let paso = 'abrir';
    try {
      await nuevo.click();
      for (let k = 0; k < 15 && !(await campoPara.count()); k++) {
        await p.waitForTimeout(1000);
        const tab = p.getByText('Sin asunto', { exact: true });
        if (await tab.count()) await tab.last().click().catch(() => {});
      }
      await p.waitForTimeout(2000);
      if (!(await campoPara.count())) { const tab = p.getByText('Sin asunto', { exact: true }); if (await tab.count()) { await tab.last().click(); await p.waitForTimeout(1500); } }
      if (!(await campoPara.count())) throw new Error('no se abrió la ventana de redacción');
      paso = 'para';
      await campoPara.first().click();
      await campoPara.first().type(c.para, { delay: 20 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(600);
      paso = 'asunto';
      await p.locator('input[placeholder="Asunto"]:visible, input.zmtext__box__fvb8gy:visible').first().fill(c.asunto);
      paso = 'cuerpo';
      // Reemplaza todo el cuerpo (incluida la firma automática de Zoho): la plantilla ya trae la firma.
      const cuerpo = p.frameLocator('iframe.ze_area:visible').first().locator('body');
      await cuerpo.evaluate((b, h) => { b.innerHTML = h; b.dispatchEvent(new Event('input', { bubbles: true })); }, html(c.cuerpo));
      await cuerpo.click();
      await p.keyboard.press('End');
      await p.waitForTimeout(800);
      paso = 'enviar';
      await p.locator('button:visible').filter({ hasText: /^\s*Enviar\s*$/ }).first().click();
      for (let k = 0; k < 6; k++) {          // diálogos (p. ej. "¿olvidó el adjunto?"): confirmar envío
        await p.waitForTimeout(1500);
        const dlg = p.locator('[role=dialog]:visible, .zmdialog:visible, .zmalert:visible').first();
        if (!(await dlg.count())) continue;
        const b = dlg.getByRole('button', { name: /Enviar|Send|Continuar|Sí/i }).first();
        if (await b.count()) { await b.click(); continue; }
        break;
      }
      await p.waitForTimeout(3000);
      if (await p.locator('input[placeholder="Asunto"]:visible').count()) throw new Error('la ventana de redacción sigue abierta');
      console.log(`OK ${c.id}`);
    } catch (e) {
      await p.screenshot({ path: path.join(DIR, `fallo-${c.id}.png`) }).catch(() => {});
      console.log(`FALLO ${c.id} [${paso}] ${e.message.split('\n')[0]}`);
      const desc = p.locator('button:visible').filter({ hasText: /Descartar borrador/ });
      if (await desc.count()) await desc.first().click().catch(() => {});
    }
    if (i < correos.length - 1) await p.waitForTimeout(pausa);
  }
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
