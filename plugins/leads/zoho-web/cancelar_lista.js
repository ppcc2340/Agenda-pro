// Cancela programados buscándolos en la lista completa de la Bandeja de salida (sin usar el buscador).
// Uso: node cancelar_lista.js correos.json     correos.json = [{ id, email }]
// Imprime: OK <id> | NO_ESTA <id> | FALLO <id> motivo
const fs = require('fs');
const { abrir, abrirBandeja } = require('./comun');
const lista = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  const cargarTodo = async () => {
    await p.getByText('Bandeja de salida', { exact: true }).first().click();
    await p.waitForTimeout(4000);
    const total = Number(((await p.getByText(/Correos electrónicos programados: \d+/).first().innerText().catch(() => '')).match(/\d+/) || [0])[0]);
    await p.locator('div.zmList').first().click();
    let antes = -1, quietos = 0, n = 0;
    while (quietos < 6 && n < total) {
      n = await p.locator('div.zmList').count();
      quietos = n === antes ? quietos + 1 : 0; antes = n;
      await p.keyboard.press('End'); await p.waitForTimeout(2500);
    }
    console.log(`CARGADOS ${n} de ${total}`);
  };
  await cargarTodo();
  for (const c of lista) {
    try {
      const fila = p.locator('div.zmList').filter({ hasText: `<${c.email}>` }).first();
      if (!(await fila.count())) { console.log(`NO_ESTA ${c.id}`); continue; }
      await fila.scrollIntoViewIfNeeded(); await fila.click({ timeout: 10000 }); await p.waitForTimeout(1500);
      await p.keyboard.press('Delete');
      const aceptar = p.locator('button:visible').filter({ hasText: /^\s*Aceptar\s*$/ }).first();
      await aceptar.waitFor({ timeout: 8000 }); await aceptar.click(); await p.waitForTimeout(2000);
      if (await p.locator('div.zmList').filter({ hasText: `<${c.email}>` }).count()) console.log(`FALLO ${c.id} sigue en la bandeja`);
      else console.log(`OK ${c.id}`);
    } catch (e) { console.log(`FALLO ${c.id} ${e.message.split('\n')[0]}`); }
  }
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
