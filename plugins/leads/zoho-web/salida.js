// Lista todo lo que hay en la Bandeja de salida (programados): una línea JSON por correo
// { asunto, para, programado: "AAAA-MM-DD HH:MM" }
const { abrir, abrirBandeja } = require('./comun');
(async () => {
  const { ctx, p } = await abrir();
  if (!(await abrirBandeja(p))) { console.log('SIN_SESION'); await ctx.close(); return; }
  await p.getByText('Bandeja de salida', { exact: true }).first().click();
  await p.waitForTimeout(5000);
  const total = Number(((await p.getByText(/Correos electrónicos programados: \d+/).first().innerText().catch(() => '')).match(/\d+/) || [0])[0]);
  const vistos = new Map();
  await p.locator('div.zmList').first().click();
  let sinNuevos = 0;
  while (sinNuevos < 4) {
    const filas = await p.locator('div.zmList').evaluateAll(es => es.map(e => ({ id: e.id, t: e.innerText.trim().replace(/\n+/g, ' | ') })));
    const antes = vistos.size;
    for (const f of filas) if (f.id) vistos.set(f.id, f.t);
    sinNuevos = vistos.size === antes ? sinNuevos + 1 : 0;
    await p.keyboard.press('End');
    await p.waitForTimeout(2500);
  }
  for (const t of vistos.values()) {
    const m = t.match(/(\d{2})\/(\d{2})\/(\d{4}) @ (\d{2}:\d{2})/);
    const para = (t.match(/<([^>]+)>/) || [, ''])[1] || (t.match(/\|\s*([^|\s]+@[^|\s]+)\s*\|/) || [, ''])[1];
    const asunto = (t.match(/(Apoyo legal para [^|]+?|\[Prueba[^|]+?)\s*\|\s*\d+ KB/) || [, ''])[1];
    console.log(JSON.stringify({ asunto: asunto.trim(), para, programado: m ? `${m[3]}-${m[1]}-${m[2]} ${m[4]}` : '' , crudo: m ? undefined : t.slice(0, 160)}));
  }
  console.log(JSON.stringify({ TOTAL_ZOHO: total, LEIDOS: vistos.size }));
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
