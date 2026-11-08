// Deja correos PROGRAMADOS en Zoho Mail (salen solos desde los servidores de Zoho, aunque este
// equipo se apague). Uso: node programar.js programados.json
// programados.json = [{ id, para, asunto, cuerpo, fecha: "AAAA-MM-DD", hora: "HH", minuto: "MM" }]
// (hora de Chile, America/Santiago). Imprime por correo: OK <id> <fecha hora:minuto> | FALLO <id> [paso] motivo
const fs = require('fs');
const path = require('path');
const { DIR, abrir, abrirBandeja } = require('./comun');
const lista = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (txt) => txt.split('\n').map(l => `<div>${l.trim() ? esc(l) : '<br>'}</div>`).join('');
const visibleBtn = (p, re) => p.locator('button:visible').filter({ hasText: re }).first();
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  const nuevo = p.getByRole('button', { name: 'Correo nuevo' });
  const campoPara = p.locator('input.zmCRInputText:visible');
  for (const c of lista) {
    let paso = 'abrir';
    try {
      await nuevo.click();
      for (let k = 0; k < 15 && !(await campoPara.count()); k++) {
        await p.waitForTimeout(1000);
        const tab = p.getByText('Sin asunto', { exact: true });
        if (await tab.count()) await tab.last().click().catch(() => {});
      }
      await p.waitForTimeout(1500);
      if (!(await campoPara.count())) throw new Error('no se abrió la ventana de redacción');
      paso = 'para';
      await campoPara.first().click();
      await campoPara.first().type(c.para, { delay: 15 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(500);
      paso = 'asunto';
      await p.locator('input[placeholder="Asunto"]:visible').first().fill(c.asunto);
      paso = 'cuerpo';
      const cuerpo = p.frameLocator('iframe.ze_area:visible').first().locator('body');
      await cuerpo.evaluate((b, h) => { b.innerHTML = h; b.dispatchEvent(new Event('input', { bubbles: true })); }, html(c.cuerpo));
      await cuerpo.click();
      await p.keyboard.press('End');
      await p.waitForTimeout(600);
      paso = 'programar';
      await visibleBtn(p, /Enviar más tarde/).click();
      await p.getByText('Fecha y hora personalizadas').first().click();
      await p.waitForTimeout(800);
      await p.getByText(/^\d{2}\/\d{2}\/\d{4}$/).first().click();
      await p.waitForTimeout(800);
      const dia = p.locator(`[data-date-iso="${c.fecha}"]:visible`).first();
      if (!(await dia.count())) throw new Error('día no disponible en el calendario: ' + c.fecha);
      await dia.click();
      await p.waitForTimeout(500);
      for (const [campo, valor] of [['Hour', c.hora], ['Minute', c.minuto]]) {
        const i = p.locator(`input[aria-label="${campo}"]:visible`).first();
        await i.click(); await i.fill(''); await i.type(String(valor).padStart(2, '0')); await p.keyboard.press('Tab');
      }
      await p.waitForTimeout(500);
      // Verifica fecha, hora y zona horaria antes de confirmar.
      const [mm, dd, aaaa] = (await p.getByText(/^\d{2}\/\d{2}\/\d{4}$/).first().innerText()).split('/');
      const h = await p.locator('input[aria-label="Hour"]:visible').first().inputValue();
      const m = await p.locator('input[aria-label="Minute"]:visible').first().inputValue();
      const zona = await p.getByText(/America\/Santiago/).count();
      const esperado = `${c.fecha} ${String(c.hora).padStart(2, '0')}:${String(c.minuto).padStart(2, '0')}`;
      const leido = `${aaaa}-${mm}-${dd} ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
      if (leido !== esperado || !zona) throw new Error(`programación no coincide: ${leido} (esperado ${esperado}, zona Chile: ${!!zona})`);
      console.log(`CONFIRMANDO ${c.id}`);
      await visibleBtn(p, /Programar y enviar/).click();
      paso = 'confirmar';   // ya se pulsó "Programar y enviar": un fallo aquí puede ser un programado real
      await p.waitForTimeout(3500);
      if (await p.locator('input[placeholder="Asunto"]:visible').count()) throw new Error('la ventana de redacción sigue abierta');
      console.log(`OK ${c.id} ${esperado}`);
    } catch (e) {
      await p.screenshot({ path: path.join(DIR, `fallo-prog-${c.id}.png`) }).catch(() => {});
      console.log(`FALLO ${c.id} [${paso}] ${e.message.split('\n')[0]}`);
      await p.keyboard.press('Escape').catch(() => {});
      const desc = visibleBtn(p, /Descartar borrador/);
      if (await desc.count()) {
        await desc.click().catch(() => {});
        await p.waitForTimeout(1000);
        const conf = p.locator('[role=dialog]:visible button, .zmdialog:visible button').filter({ hasText: /Descartar|Sí|Aceptar/ });
        if (await conf.count()) await conf.first().click().catch(() => {});
      }
    }
  }
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
