// Lista los correos de la campaña que están en la carpeta Enviado: una línea JSON por correo { para, asunto, cuando }
const { abrir, abrirBandeja } = require('./comun');
const desde = process.argv[2] || 'Apoyo legal para';
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  await p.getByText('Enviado', { exact: true }).first().click(); await p.waitForTimeout(5000);
  await p.locator('div.zmList').first().click();
  let antes = -1, quietos = 0;
  while (quietos < 8) {
    const n = await p.locator('div.zmList').count();
    quietos = n === antes ? quietos + 1 : 0; antes = n;
    const ultima = await p.locator('div.zmList').last().innerText().catch(() => '');
    if (/OCT\.|oct\./.test(ultima)) break;                       // ya llegó a octubre: la campaña empezó en noviembre
    await p.keyboard.press('End'); await p.waitForTimeout(3000);
  }
  const filas = await p.locator('div.zmList').evaluateAll(es => es.map(e => ({ t: e.innerText.replace(/\n+/g, ' | '), a: e.getAttribute('aria-label') || '' })));
  for (const f of filas) {
    if (!f.t.includes(desde)) continue;
    const para = (f.t.match(/<([^>]+)>/) || [, ''])[1] || (f.t.match(/\|\s*([^\s|]+@[^\s|]+)\s*\|/) || [, ''])[1];
    const cuando = (f.a.match(/Hora de entrega: (.+)$/) || [, ''])[1];
    console.log(JSON.stringify({ para, asunto: (f.t.match(/(Apoyo legal para [^|]+)/) || [, ''])[1].trim(), cuando, t: para ? undefined : f.t.slice(0, 150) }));
  }
  console.log(JSON.stringify({ FILAS: filas.length }));
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
