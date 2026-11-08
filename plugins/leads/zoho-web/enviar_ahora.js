// Envía YA los correos que están programados en la Bandeja de salida ("Enviar ahora"), uno cada N segundos.
// Uso: node enviar_ahora.js excluir.json [segundos=15] [maximo=999999]
// excluir.json = ["correo@x.cl", …] (no se envían; p. ej. descartados). Imprime: OK <correo> | FALLO <correo> motivo | LIMITE
const fs = require('fs');
const { abrir, abrirBandeja } = require('./comun');
const excluir = new Set(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).map(e => e.trim().toLowerCase()));
const pausa = Number(process.argv[3] || 15) * 1000;
const maximo = Number(process.argv[4] || 999999);
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  const cargar = async () => {
    await p.getByText('Bandeja de salida', { exact: true }).first().click();
    await p.waitForTimeout(4000);
    const total = Number(((await p.getByText(/Correos electrónicos programados: \d+/).first().innerText().catch(() => '')).match(/\d+/) || [0])[0]);
    if (!total) return 0;
    await p.locator('div.zmList').first().click();
    let antes = -1, quietos = 0, n = 0;
    while (quietos < 6 && n < total) {
      n = await p.locator('div.zmList').count(); quietos = n === antes ? quietos + 1 : 0; antes = n;
      await p.keyboard.press('End'); await p.waitForTimeout(2500);
    }
    console.log(`CARGADOS ${n} de ${total}`);
    return total;
  };
  let enviados = 0;
  while (enviados < maximo) {
    const total = await cargar();
    if (!total) break;
    const filas = await p.locator('div.zmList').evaluateAll(es => es.map(e => (e.innerText.match(/<([^>]+)>/) || [, ''])[1]));
    const pendientes = filas.filter(e => e && !excluir.has(e.trim().toLowerCase()));
    if (!pendientes.length) break;
    for (const email of pendientes.reverse()) {          // de abajo hacia arriba = los primeros programados
      if (enviados >= maximo) break;
      const t0 = Date.now();
      try {
        const fila = p.locator('div.zmList').filter({ hasText: `<${email}>` }).first();
        if (!(await fila.count())) continue;
        await fila.scrollIntoViewIfNeeded(); await fila.click({ timeout: 10000 }); await p.waitForTimeout(1200);
        await p.locator('button:visible, [role=button]:visible').filter({ hasText: /^\s*Enviar ahora\s*$/ }).first().click({ timeout: 10000 });
        await p.waitForTimeout(1500);
        const conf = p.locator('button:visible').filter({ hasText: /^\s*(Aceptar|Enviar|Sí|Enviar ahora)\s*$/ });
        if (await conf.count()) { await conf.first().click().catch(() => {}); await p.waitForTimeout(1500); }
        const txt = await p.evaluate(() => document.body.innerText);
        if (/l[ií]mite de env[ií]o|sending limit|quota exceeded|cuota/i.test(txt)) {
          console.log('LIMITE'); await p.waitForTimeout(15 * 60 * 1000); break;   // espera y recarga la lista
        }
        if (await p.locator('div.zmList').filter({ hasText: `<${email}>` }).count()) { console.log(`FALLO ${email} sigue en la bandeja`); }
        else { enviados++; console.log(`OK ${email}`); }
      } catch (e) { console.log(`FALLO ${email} ${e.message.split('\n')[0]}`); }
      const resto = pausa - (Date.now() - t0);
      if (resto > 0) await p.waitForTimeout(resto);
    }
  }
  console.log(`FIN enviados=${enviados}`);
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
