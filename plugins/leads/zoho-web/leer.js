// Busca en Zoho Mail correos cuyo remitente contiene cierto texto y lee los más recientes.
// Uso: node leer.js buscar.json      buscar.json = [{ id, desde, max? }]
// Imprime una línea JSON por búsqueda: { id, desde, encontrados: [{ remitente, asunto, fecha, texto }] }
const fs = require('fs');
const { abrir, abrirBandeja } = require('./comun');
const lista = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  for (const l of lista) {
    const res = { id: l.id, desde: l.desde, encontrados: [] };
    try {
      const caja = p.locator('input.zmSearchTB:visible').first();
      await caja.click(); await caja.fill('');
      await caja.type(`desde:${l.desde}`, { delay: 15 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(5000);
      const filas = await p.locator('div.zmList:visible').evaluateAll(es => es.map(e => e.innerText.trim().replace(/\n+/g, ' | ')));
      for (let k = 0; k < Math.min(filas.length, l.max || 3); k++) {
        await p.locator('div.zmList:visible').nth(k).click();
        await p.waitForTimeout(3500);
        const texto = await p.locator('.zmPVMail:visible').first()
          .evaluate(m => [...m.children].filter(c => !c.classList.contains('zmMailHeader')).map(c => c.innerText).join('\n')).catch(() => '');
        const partes = filas[k].split(' | ');
        res.encontrados.push({ remitente: partes[0], asunto: partes[1] || '', fecha: (partes[partes.length - 1] || '').trim(),
                               texto: texto.trim().replace(/\n{2,}/g, '\n').slice(0, 1500) });
      }
    } catch (e) { res.error = e.message.split('\n')[0]; }
    console.log(JSON.stringify(res));
  }
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
