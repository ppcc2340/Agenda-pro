// Comprueba si hay sesión de Zoho Mail abierta. Imprime SESION_OK o SIN_SESION.
const { abrir, abrirBandeja } = require('./comun');
(async () => {
  const { ctx, p } = await abrir();
  console.log((await abrirBandeja(p)) ? 'SESION_OK' : 'SIN_SESION');
  await ctx.close();
})().catch(e => { console.log('ERROR ' + e.message.split('\n')[0]); process.exit(1); });
