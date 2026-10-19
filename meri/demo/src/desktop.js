let view = 'hoy', tab = 'compromisos', dir = 'owed_by_me', cf = null, sel = 'b2', editing = null;
let auditN = 0, idN = 100, tUndo = null, tTimer = null, palIdx = 0;
const undoers = {};
const NAV = [['hoy','sun','Hoy'],['entrada','inbox','Entrada'],['proyectos','layers','Proyectos y compromisos'],['calendario','cal','Calendario'],['control','sliders','Centro de control']];
const TITLES = { hoy:'Lunes 19 de octubre', entrada:'Entrada', proyectos:'Proyectos y compromisos', calendario:'Calendario', control:'Centro de control' };

function audit(who, text, undo) {
  const id = 'a' + (++auditN);
  S.audit.unshift({ id, who, text, time: hm(NOW_MIN + auditN), undoable: !!undo });
  if (undo) undoers[id] = undo;
  return id;
}
function toast(msg, undo) {
  const t = $('#toast'); tUndo = undo || null;
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="link" data-act="toast-undo">Deshacer</button>' : ''}`;
  t.hidden = false; clearTimeout(tTimer); tTimer = setTimeout(() => t.hidden = true, 6500);
}
const curBlock = () => S.blocks.find(b => !b.done && b.s <= NOW_MIN && b.e > NOW_MIN) || S.blocks.find(b => !b.done && b.s > NOW_MIN);
const pendingCount = () => S.proposals.length;
const riskCount = () => S.risks.length + S.commitments.filter(c => c.status === 'overdue').length;

/* ---------- Shell ---------- */
function render() {
  const sc = $('.main') ? $('.main').scrollTop : 0;
  $('#app').innerHTML = `
  <aside class="rail">
    <div class="brand">${LOGO(30)}<span>meri</span></div>
    <nav class="nav" aria-label="Áreas">
      ${NAV.map(([k, i, l]) => `<button data-act="nav" data-v="${k}" ${view === k ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span>
        ${k === 'entrada' && pendingCount() ? `<em class="badge">${pendingCount()}</em>` : ''}
        ${k === 'proyectos' && riskCount() ? `<em class="badge r">${riskCount()}</em>` : ''}</button>`).join('')}
    </nav>
    <div class="rail-foot">
      <button data-act="theme">${ic('moon', 16)}<span>Cambiar tema</span></button>
      <span>Demo con datos de ejemplo. Nada se envía ni se guarda.</span>
    </div>
  </aside>
  <main class="main"><div class="wrap">${topbar()}${VIEWS[view]()}</div></main>`;
  $('.main').scrollTop = sc;
}
function topbar() {
  const subs = {
    hoy: S.risks.length ? `Tu plan cabe con margen. ${S.risks.length === 1 ? 'Una cosa pide' : 'Dos cosas piden'} atención antes del miércoles.` : 'Tu plan cabe con margen y no hay nada en riesgo. Puedes concentrarte.',
    entrada: 'Meri propone, tú decides. Nada de esto es definitivo hasta que lo confirmes.',
    proyectos: 'Lo que debes, lo que te deben y el tiempo de cada cliente.',
    calendario: 'Tus reuniones y los bloques de trabajo que Meri reserva para ti.',
    control: 'Qué puede hacer Meri por su cuenta, qué datos usa y qué ha hecho.',
  };
  return `<div class="top"><div><h1>${TITLES[view]}</h1><p class="sub">${subs[view]}</p></div>
    <button class="kbtn" data-act="pal">${ic('search', 16)}<span>Capturar o buscar</span><kbd>Ctrl K</kbd></button></div>`;
}

/* ---------- Hoy ---------- */
function timeline() {
  const A = T(8), B = T(19), sp = B - A, X = m => (m - A) / sp * 100, W = (a, b) => (b - a) / sp * 100;
  const ticks = Array.from({ length: 12 }, (_, i) => `<span style="left:${X(T(8 + i))}%">${8 + i}</span>`).join('');
  const evs = S.events.map(e => `<div class="ev ${W(e.s, e.e) < 12 ? 'narrow' : ''}" style="left:${X(e.s)}%;width:${W(e.s, e.e)}%;--cc:${cc(e.client)}" title="${esc(e.title)}"><b>${esc(e.title)}</b><i>${hm(e.s)} a ${hm(e.e)}</i></div>`).join('');
  const mar = S.margin.map(m => `<div class="mar" style="left:${X(m.s)}%;width:${W(m.s, m.e)}%" title="Margen para imprevistos">margen</div>`).join('');
  const blks = S.blocks.map(b => `<button class="blk ${W(b.s, b.e) < 12 ? 'narrow' : ''} ${b.done ? 'done' : ''} ${sel === b.id ? 'sel' : ''}" data-act="sel" data-id="${b.id}" style="left:${X(b.s)}%;width:${W(b.s, b.e)}%;--cc:${cc(b.client)}" aria-label="${esc(b.title)}, ${hm(b.s)} a ${hm(b.e)}"><b>${esc(b.title)}</b><i>${hm(b.s)} a ${hm(b.e)}</i></button>`).join('');
  const sb = S.blocks.find(b => b.id === sel);
  return `<div class="tl">
    <div class="tlc"><div class="ticks" aria-hidden="true">${ticks}</div>
    <div class="lane"><span class="lane-l">Calendario</span><div class="track">${evs}</div></div>
    <div class="lane"><span class="lane-l">Plan de Meri</span><div class="track">${mar}${blks}</div></div>
    <div class="nowwrap" aria-hidden="true"><div class="now" style="left:${X(NOW_MIN)}%"><em>${hm(NOW_MIN)}</em></div></div></div>
    <div class="legend"><span><i class="sw f"></i>Reunión fija: Meri no la toca</span><span><i class="sw s"></i>Bloque de trabajo confirmado</span><span><i class="sw p"></i>Sugerido: espera tu decisión</span></div>
    ${sb ? `<div class="detail" style="--cc:${cc(sb.client)}"><div><h3>${esc(sb.title)}</h3><p class="num">${hm(sb.s)} a ${hm(sb.e)}, ${fmtMin(sb.e - sb.s)}. ${sb.kind === 'deep' ? 'Trabajo profundo.' : 'Trabajo corto.'}</p><p class="why"><b>Por qué está aquí.</b> ${esc(sb.why)}</p></div>
      <button class="btn ${sb.done ? '' : 'primary'}" data-act="done" data-id="${sb.id}">${ic('check', 16)}${sb.done ? 'Reabrir' : 'Marcar como hecho'}</button></div>` : ''}
  </div>`;
}
function viewHoy() {
  const cur = curBlock();
  const key = S.blocks.filter(b => !b.done).sort((a, b) => a.pri - b.pri || a.s - b.s).slice(0, 3);
  const waiting = S.commitments.filter(c => c.dir === 'owed_to_me').sort((a, b) => (b.status === 'overdue') - (a.status === 'overdue')).slice(0, 3);
  const nowCard = cur ? (() => {
    const live = cur.s <= NOW_MIN, pct = live ? Math.round((NOW_MIN - cur.s) / (cur.e - cur.s) * 100) : 0;
    return `<div class="now-card" style="--cc:${cc(cur.client)}">${chip(cur.client)}<h3>${esc(cur.title)}</h3>
      <p class="muted num">${live ? `Quedan ${fmtMin(cur.e - NOW_MIN)} de este bloque.` : `Empieza a las ${hm(cur.s)} y dura ${fmtMin(cur.e - cur.s)}.`}</p>
      <div class="bar"><b style="width:${pct}%"></b></div>
      <div style="display:flex;gap:8px"><button class="btn primary" data-act="done" data-id="${cur.id}">${ic('check', 16)}Marcar como hecho</button><button class="btn" data-act="sel" data-id="${cur.id}">Ver por qué está aquí</button></div></div>`;
  })() : `<div class="empty"><h3>Has terminado el plan de hoy</h3><p>No queda nada programado. Mira Entrada por si hay compromisos nuevos.</p></div>`;
  return `
  <section class="sec" style="margin-top:0"><h2>Tu día</h2>${timeline()}</section>
  <div class="cols">
    <div>
      <section class="sec" style="margin-top:8px"><h2>¿Qué hago ahora?</h2>${nowCard}</section>
      <section class="sec"><h2>¿Qué es lo más importante hoy?</h2>
        <div class="list">${key.map(b => `<div class="row"><button class="check ${b.done ? 'on' : ''}" data-act="done" data-id="${b.id}" aria-label="Marcar ${esc(b.title)} como hecho">${ic('check', 14)}</button>
          <div class="grow"><div class="ttl">${esc(b.title)}</div><div class="meta">${chip(b.client)}<span class="num">${hm(b.s)} a ${hm(b.e)}</span></div></div></div>`).join('') || '<div class="empty">Todo lo importante de hoy está hecho.</div>'}</div></section>
      ${S.unscheduled.length ? `<section class="sec"><h2>Por programar</h2><div class="list">${S.unscheduled.map(u => `<div class="row"><div class="grow"><div class="ttl">${esc(u.title)}</div><div class="meta">${u.client ? chip(u.client) : ''}${u.due ? `<span>Para el ${esc(u.due)}</span>` : ''}${u.est ? `<span>${fmtMin(u.est)}</span>` : ''}<span class="pill sug">Meri la programará en el siguiente hueco</span></div></div></div>`).join('')}</div></section>` : ''}
    </div>
    <div>
      <section class="sec" style="margin-top:8px"><h2>¿Qué podría salir mal?</h2>
        <div class="list">${S.risks.map(r => `<div class="row risk-row"><div class="grow"><div class="ttl">${esc(r.title)}</div><div class="meta">${chip(r.client)}<span>${esc(r.detail)}</span></div></div>
          <div class="acts">${r.fix === 'reorganize' ? `<button class="btn sm primary" data-act="reorg">Ver cómo reorganizar</button>` : `<button class="btn sm" data-act="followup" data-id="${r.cid}">Preparar seguimiento</button>`}</div></div>`).join('') || '<div class="empty"><h3>Sin riesgos a la vista</h3><p>Si algo pone en peligro una fecha, lo verás aquí con una propuesta.</p></div>'}</div></section>
      <section class="sec"><h2>¿Qué estoy esperando de otras personas?</h2>
        <div class="list">${waiting.map(c => `<div class="row"><div class="grow"><div class="ttl">${esc(c.action)}</div><div class="meta">${chip(c.client)}<span>${esc(c.who)}</span><span class="pill ${c.status === 'overdue' ? 'risk' : 'plain'}">${c.status === 'overdue' ? 'Vencido ' + esc(c.due) : 'Para ' + esc(c.due)}</span></div></div>
          ${c.status === 'overdue' ? `<div class="acts"><button class="btn sm" data-act="followup" data-id="${c.id}">${ic('mail', 14)}Seguimiento</button></div>` : ''}</div>`).join('')}</div></section>
    </div>
  </div>`;
}

/* ---------- Entrada ---------- */
function viewEntrada() {
  const explicit = S.proposals.filter(p => p.kind === 'explicit' && p.conf >= .9).length;
  const kindLbl = { explicit:'Explícito', inferred:'Inferido', suggested:'Sugerencia', capture:'Captura' };
  const rows = S.proposals.map(p => {
    const ed = editing === p.id;
    return `<article class="prop" style="--cc:${cc(p.client)}"><div class="grow" style="flex:1;min-width:0">
      ${ed ? `<div class="edit-grid"><input id="e-action" value="${esc(p.action)}" aria-label="Acción"><input id="e-due" value="${esc(p.due || '')}" aria-label="Fecha"></div>`
           : `<div class="ttl" style="font-weight:600;font-size:15.5px">${esc(p.action)}</div>`}
      <div class="meta" style="display:flex;gap:12px;flex-wrap:wrap;color:var(--ink2);font-size:13px;margin-top:4px;align-items:center">
        ${chip(p.client)}${p.kind !== 'capture' ? `<span>${p.dir === 'owed_to_me' ? 'Te lo debe' : 'Se lo debes a'} ${esc(p.who)}</span>` : ''}<span>${p.due ? 'Para: ' + esc(p.due) : 'Sin fecha'}</span>${p.est ? `<span>${fmtMin(p.est)}</span>` : ''}
        <span class="pill sug">${kindLbl[p.kind]}</span>
        ${p.conf ? `<span class="conf"><span><b style="width:${p.conf * 100}%"></b></span>${Math.round(p.conf * 100)} %</span>` : ''}</div>
      ${p.evidence ? `<div class="q">“${esc(p.evidence)}”</div><div class="src">${ic('mail', 14)} Del hilo «${esc(p.source)}». <button class="btn quiet sm" style="padding:0 4px">Abrir en Gmail</button></div>` : ''}
    </div>
    <div class="acts" style="flex-direction:column;align-items:stretch;gap:6px;min-width:128px">
      ${ed ? `<button class="btn primary sm" data-act="save" data-id="${p.id}">Guardar y confirmar</button><button class="btn sm" data-act="cancel">Cancelar</button>`
           : `<button class="btn primary sm" data-act="confirm" data-id="${p.id}">${ic('check', 14)}Confirmar</button><button class="btn sm" data-act="edit" data-id="${p.id}">${ic('edit', 14)}Editar</button><button class="btn quiet sm" data-act="dismiss" data-id="${p.id}">Descartar</button>`}
    </div></article>`;
  }).join('');
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span class="muted">${S.proposals.length ? `${S.proposals.length} por revisar` : ''}</span>
      ${explicit ? `<button class="btn sm" data-act="confirm-explicit">${explicit === 1 ? 'Confirmar la explícita de alta confianza' : `Confirmar las ${explicit} explícitas de alta confianza`}</button>` : ''}</div>
    <div style="border-top:1px solid var(--rule)">${rows || `<div class="empty"><h3>Todo al día</h3><p>Cuando llegue un correo con un compromiso, o captures algo con Ctrl K, aparecerá aquí para que lo revises.</p></div>`}</div>`;
}

/* ---------- Proyectos y compromisos ---------- */
function viewProyectos() {
  const tabs = [['compromisos','Compromisos'],['clientes','Clientes'],['tiempo','Tiempo']];
  return `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>` +
    (tab === 'compromisos' ? tabCompromisos() : tab === 'clientes' ? tabClientes() : tabTiempo());
}
function tabCompromisos() {
  const list = S.commitments.filter(c => c.dir === dir && (!cf || c.client === cf));
  const cnt = d => S.commitments.filter(c => c.dir === d).length;
  const st = { confirmed:['Confirmado','plain'], overdue:['Vencido','risk'], fulfilled:['Cumplido','ok'] };
  return `<div class="filters"><div class="seg"><button data-act="dir" data-v="owed_by_me" aria-pressed="${dir === 'owed_by_me'}">Debo (${cnt('owed_by_me')})</button><button data-act="dir" data-v="owed_to_me" aria-pressed="${dir === 'owed_to_me'}">Me deben (${cnt('owed_to_me')})</button></div>
    <span style="width:10px"></span>${Object.keys(CLIENTS).map(k => `<button class="fchip" style="--cc:${cc(k)}" data-act="cf" data-v="${k}" aria-pressed="${cf === k}"><i></i>${CLIENTS[k].name}</button>`).join('')}
    ${cf ? '<button class="btn quiet sm" data-act="cf" data-v="">Quitar filtro</button>' : ''}</div>
    <div class="list">${list.map(c => `<div class="row"><div class="grow"><div class="ttl">${esc(c.action)}</div><div class="meta">${chip(c.client)}<span>${esc(c.who)}</span><span class="pill ${st[c.status][1]}">${st[c.status][0]}, ${esc(c.due)}</span></div></div>
      <div class="acts">${c.dir === 'owed_to_me' ? `<button class="btn sm ${c.status === 'overdue' ? 'primary' : ''}" data-act="followup" data-id="${c.id}">${ic('mail', 14)}Preparar seguimiento</button>` : `<button class="btn sm" data-act="fulfil" data-id="${c.id}">${ic('check', 14)}Cumplido</button>`}</div></div>`).join('') || '<div class="empty">No hay compromisos con este filtro.</div>'}</div>`;
}
function tabClientes() {
  return `<div class="list" style="margin-top:12px">${Object.keys(CLIENTS).map(k => {
    const open = S.commitments.filter(c => c.client === k && c.status !== 'fulfilled').length;
    const risk = S.risks.filter(r => r.client === k).length + S.commitments.filter(c => c.client === k && c.status === 'overdue').length;
    const mins = S.time.filter(t => t.client === k).reduce((a, t) => a + t.min, 0);
    return `<div class="row" style="align-items:center"><span class="sw" style="background:${cc(k)};width:8px;height:38px;border-radius:4px;flex-shrink:0"></span>
      <div class="grow"><div class="ttl">${CLIENTS[k].name}</div><div class="meta"><span>${open} compromisos abiertos</span><span>${fmtMin(mins)} esta semana</span>${risk ? `<span class="pill risk">${risk} en riesgo</span>` : '<span class="pill ok">Sin riesgos</span>'}</div></div>
      <div class="acts"><button class="btn sm" data-act="brief" data-v="${k}">Generar briefing</button></div></div>`; }).join('')}</div>
    <p class="dim" style="margin-top:14px;max-width:62ch">${ic('shield', 14)} Cada briefing usa solo los datos del cliente elegido. Nunca se mezcla información de otro cliente.</p>`;
}
function tabTiempo() {
  const ap = S.time.filter(t => t.status === 'approved'), su = S.time.filter(t => t.status === 'suggested');
  const sum = a => a.reduce((x, t) => x + t.min, 0);
  return `<div class="stats"><div class="stat"><b class="num">${fmtMin(sum(ap))}</b><span>Aprobadas esta semana</span></div><div class="stat"><b class="num" style="color:var(--sug)">${fmtMin(sum(su))}</b><span>Sugeridas, esperan tu revisión</span></div></div>
  <div style="display:flex;gap:8px;margin:6px 0 10px">${su.length ? `<button class="btn primary sm" data-act="approve-all">Aprobar las ${su.length} sugeridas</button>` : ''}<button class="btn sm" data-act="csv">${ic('download', 14)}Exportar CSV</button></div>
  <table><thead><tr><th>Día</th><th>Cliente</th><th>Descripción</th><th>Origen</th><th class="r">Duración</th><th></th></tr></thead><tbody>
  ${[...su, ...ap].map(t => `<tr class="${t.status === 'suggested' ? 'sug' : ''}"><td>${t.day}</td><td>${chip(t.client)}</td><td>${esc(t.desc)}</td><td class="muted">${esc(t.src)}</td><td class="r num">${fmtMin(t.min)}</td>
    <td class="r">${t.status === 'approved' ? '<span class="pill ok">Aprobada</span>' : `<button class="btn sm" data-act="approve" data-id="${t.id}">Aprobar</button>`}</td></tr>`).join('')}</tbody></table>
  <p class="dim" style="margin-top:12px">Meri infiere el tiempo desde tu calendario y tus bloques. Nada cuenta como facturable hasta que lo apruebas.</p>`;
}

/* ---------- Calendario ---------- */
function viewCalendario() {
  const A = T(8), H = 48, Y = m => (m - A) / 60 * H;
  const cols = DAYS.map((d, i) => {
    const { events, blocks } = dayItems(i);
    const it = [...events.map(e => ({ ...e, ev: true })), ...blocks];
    return `<div class="dcol">${it.map(x => `<div class="${x.ev ? 'ev' : 'blk'}" style="top:${Y(x.s)}px;height:${Y(x.e) - Y(x.s)}px;--cc:${cc(x.client)};position:absolute" title="${esc(x.title)}"><b>${esc(x.title)}</b>${Y(x.e) - Y(x.s) > 40 ? `<i>${hm(x.s)} a ${hm(x.e)}</i>` : ''}</div>`).join('')}${i === 0 ? `<div class="nowline" style="top:${Y(NOW_MIN)}px"></div>` : ''}</div>`;
  }).join('');
  return `<div class="legend" style="margin:0"><span><i class="sw f"></i>Reuniones</span><span><i class="sw s"></i>Bloques de Meri</span><span class="dim">Meri solo crea y mueve sus propios bloques en un calendario aparte.</span></div>
  <div class="week"><div></div>${DAYS.map((d, i) => `<div class="hd ${i === 0 ? 'today' : ''}">${d}</div>`).join('')}
  <div class="hours">${Array.from({ length: 12 }, (_, i) => `<span style="top:${i * H}px">${8 + i}:00</span>`).join('')}</div>${cols}</div>`;
}

/* ---------- Centro de control ---------- */
function viewControl() {
  const used = 412, cap = 1500;
  return `
  <div class="panel"><div><h3>Autonomía</h3><p class="d">Cuánto puede hacer Meri sin preguntarte.</p></div><div>
    <div class="seg"><button data-act="auto" data-v="suggest" aria-pressed="${S.autonomy === 'suggest'}">Solo sugerir</button><button data-act="auto" data-v="low" aria-pressed="${S.autonomy === 'low'}">Actuar en lo de bajo riesgo</button></div>
    <p class="muted" style="margin-top:10px;max-width:60ch">${S.autonomy === 'suggest' ? 'Meri propone y tú confirmas todo. Es la opción por defecto.' : 'Meri puede confirmar compromisos explícitos de alta confianza y mover sus propios bloques. Nunca toca reuniones ni envía correos.'}</p></div></div>
  <div class="panel"><div><h3>Conexiones</h3><p class="d">Qué cuentas lee Meri y con qué permiso.</p></div><div>
    <div class="conn"><div><b>Google Calendar</b><div class="muted">Lectura de eventos y escritura solo en el calendario «Meri»</div></div><span class="pill sug">Demo, sin conectar</span></div>
    <div class="conn"><div><b>Gmail</b><div class="muted">Lectura y borradores. Sin permiso de envío</div></div><span class="pill sug">Demo, sin conectar</span></div>
    <div class="conn"><div><b>Outlook y Notion</b><div class="muted">Llegan después del lanzamiento</div></div><span class="pill plain">Próximamente</span></div></div></div>
  <div class="panel"><div><h3>Créditos de IA</h3><p class="d">Se usan al leer correos y generar borradores y briefings. El planificador no gasta créditos.</p></div><div>
    <div class="num"><b style="font:600 24px var(--f-head)">${used}</b> <span class="muted">de ${cap} este mes</span></div><div class="meter"><b style="width:${used / cap * 100}%"></b></div>
    <p class="muted">Al llegar al límite, la IA se pausa y el calendario y el plan siguen funcionando.</p></div></div>
  <div class="panel"><div><h3>Actividad</h3><p class="d">Todo lo que Meri hizo o propuso, con opción de deshacer.</p></div><div class="list" style="border:0">
    ${S.audit.slice(0, 8).map(a => `<div class="row"><span class="pill ${a.who === 'ia' ? 'sug' : a.who === 'user' ? 'ok' : 'plain'}">${{ ia:'IA', user:'Tú', sistema:'Sistema' }[a.who]}</span><div class="grow">${esc(a.text)}<div class="dim num" style="font-size:12.5px">${a.time}</div></div>
      ${a.undoable && !a.undone ? `<button class="btn sm" data-act="undo" data-id="${a.id}">${ic('undo', 14)}Deshacer</button>` : a.undone ? '<span class="dim">Deshecho</span>' : ''}</div>`).join('')}</div></div>
  <div class="panel" style="border:0"><div><h3>Privacidad</h3><p class="d">Tus datos son tuyos.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn" data-act="toast-demo" data-m="En el producto real, esto pausa la lectura de correo al instante.">Pausar lectura de correo</button>
    <button class="btn" data-act="toast-demo" data-m="Se descargaría un archivo con todos tus datos.">Exportar mis datos</button>
    <button class="btn risk" data-act="toast-demo" data-m="En la demo no se elimina nada.">Eliminar mi cuenta</button></div></div>`;
}
const VIEWS = { hoy: viewHoy, entrada: viewEntrada, proyectos: viewProyectos, calendario: viewCalendario, control: viewControl };

/* ---------- Modales ---------- */
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; const b = $('.dlg .primary,.dlg button', m); if (b) b.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
function openReorg() {
  openModal(`<header><h2>Reorganizar para proteger la fecha de Beta</h2><p>Meri propone dos cambios. Ninguna reunión se mueve.</p></header>
  <div class="body">
    <div class="diff"><span class="chip" style="--cc:${cc('beta')}"><i></i></span><div><b>Borrador de contestación para Beta</b><div class="arrow"><s class="num">13:30 a 15:00</s>${ic('chev', 14)}<b class="num" style="color:var(--ink)">13:30 a 16:00</b><span class="pill ok">+1 h</span></div></div></div>
    <div class="diff"><span class="chip" style="--cc:${cc('norte')}"><i></i></span><div><b>Revisar factura de Estudio Norte</b><div class="arrow"><s class="num">Hoy 15:00 a 16:00</s>${ic('chev', 14)}<b class="num" style="color:var(--ink)">Mañana 09:00 a 10:00</b></div></div></div>
    <p class="muted" style="margin:14px 0 4px"><b style="color:var(--ink)">Qué cambia.</b> La holgura del borrador de Beta sube de 3 h a 5 h. La factura de Norte no tiene fecha límite esta semana, así que puede esperar.</p></div>
  <footer><span class="note">Se guarda en Actividad y podrás deshacerlo.</span><button class="btn" data-act="close">Ahora no</button><button class="btn primary" data-act="accept-reorg">Aceptar cambios</button></footer>`);
}
function openFollowup(cid) {
  const c = S.commitments.find(x => x.id === cid); const d = followupDraft(c);
  openModal(`<header><h2>Seguimiento para ${esc(c.who)}</h2><p>Para: ${esc(c.who)}. Asunto: ${esc(d.subject)}</p></header>
  <div class="body"><label class="sr" for="draft">Borrador</label><textarea id="draft">${esc(d.body)}</textarea></div>
  <footer><span class="note">Meri solo crea borradores. Tú decides cuándo enviarlo.</span><button class="btn" data-act="close">Cancelar</button><button class="btn" data-act="remind" data-id="${c.id}">Recordarme mañana</button><button class="btn primary" data-act="save-draft" data-id="${c.id}">${ic('mail', 15)}Guardar borrador en Gmail</button></footer>`);
}
function openBrief(k) {
  openModal(`<header><h2>Briefing de ${esc(CLIENTS[k].name)}</h2><p>${ic('shield', 14)} Contexto aislado: solo datos de este cliente. Cada punto enlaza a su fuente.</p></header>
  <div class="body">${BRIEFS[k].map(([t, kind, src]) => `<div class="row"><div class="grow">${esc(t)}<div class="dim" style="font-size:12.5px;margin-top:2px">${kind}: ${esc(src)}</div></div></div>`).join('')}</div>
  <footer><button class="btn primary" data-act="close">Cerrar</button></footer>`);
}

/* ---------- Paleta ⌘K ---------- */
const CMDS = [
  ['Ir a Hoy','sun',() => go('hoy')], ['Ir a Entrada','inbox',() => go('entrada')], ['Mostrar compromisos en riesgo','alert',() => { go('proyectos'); tab = 'compromisos'; dir = 'owed_to_me'; render(); }],
  ['¿De quién espero una respuesta?','mail',() => { go('proyectos'); tab = 'compromisos'; dir = 'owed_to_me'; render(); }], ['Reorganizar mi semana','calendar',() => openReorg()],
  ['Ver el calendario de la semana','cal',() => go('calendario')], ['Ir al Centro de control','sliders',() => go('control')],
];
function go(v) { view = v; closePal(); render(); }
function openPal() { $('#pal').hidden = false; const i = $('#pal-in'); i.value = ''; palIdx = 0; palRender(); i.focus(); }
function closePal() { $('#pal').hidden = true; }
function palRender() {
  const q = $('#pal-in').value.trim(), low = q.toLowerCase();
  const cmds = CMDS.filter(c => !q || c[0].toLowerCase().includes(low));
  let html = '';
  if (q.length > 3 && !cmds.length || q.split(' ').length > 2) {
    const p = parseCapture(q);
    html += `<div class="cap" aria-label="Lo que Meri entendió"><span class="muted" style="width:100%">Meri entendió esto. Puedes corregirlo después.</span><span class="pill sug">${esc(p.title)}</span>${p.client ? chip(p.client) : ''}${p.due ? `<span class="pill sug">Para: ${esc(p.due)}</span>` : ''}${p.est ? `<span class="pill sug">${fmtMin(p.est)}</span>` : ''}</div>
      <ul><li><button data-act="pal-capture" class="${palIdx === 0 ? 'act' : ''}">${ic('plus', 16)}Capturar «${esc(q)}» en Entrada</button></li></ul>`;
  }
  const rows = cmds.map((c, i) => `<li><button data-act="pal-cmd" data-i="${CMDS.indexOf(c)}" class="${!html && i === palIdx ? 'act' : ''}">${ic(IC[c[1]] ? c[1] : 'cal', 16)}${c[0]}</button></li>`).join('');
  $('#pal-body').innerHTML = html + (rows ? `<ul>${rows}</ul>` : (!html ? '<div class="tip">Escribe una tarea con fecha y duración, por ejemplo: Informe para Acme el jueves, 2 h.</div>' : ''));
}
function capture() {
  const q = $('#pal-in').value.trim(); if (!q) return; const p = parseCapture(q);
  const id = 'p' + (++idN);
  S.proposals.unshift({ id, kind:'capture', client:p.client, action:p.title, due:p.due, est:p.est, conf:null, dir:'owed_by_me', who:'' });
  const aid = audit('user', `Capturaste «${p.title}».`, () => { S.proposals = S.proposals.filter(x => x.id !== id); });
  closePal(); render(); toast('Capturado en Entrada. Revisa lo que Meri entendió.', () => H.undo({ id: aid }));
}

/* ---------- Acciones ---------- */
const H = {
  nav: d => { view = d.v; editing = null; render(); },
  tab: d => { tab = d.v; render(); },
  dir: d => { dir = d.v; render(); },
  cf: d => { cf = d.v || null; render(); },
  sel: d => { sel = d.id; if (view !== 'hoy') view = 'hoy'; render(); },
  done: d => {
    const b = S.blocks.find(x => x.id === d.id); b.done = !b.done;
    if (b.done) {
      const tid = 't' + (++idN); S.time.unshift({ id: tid, day: 'Lun 19', client: b.client, desc: b.title, min: b.e - b.s, src: 'Bloque completado', status: 'suggested' });
      const aid = audit('user', `Completaste «${b.title}». Meri sugirió ${fmtMin(b.e - b.s)} de tiempo.`);
      render(); toast(`Hecho. Añadí ${fmtMin(b.e - b.s)} sugeridas en Tiempo.`);
    } else { render(); }
  },
  reorg: () => openReorg(),
  'accept-reorg': () => {
    const b3 = S.blocks.find(b => b.id === 'b3'), b4 = S.blocks.find(b => b.id === 'b4'), r1 = S.risks.find(r => r.id === 'r1');
    const old = { e: b3.e, b4: { ...b4 }, r1 };
    b3.e = T(16); S.blocks = S.blocks.filter(b => b.id !== 'b4'); S.moved.push({ ...b4, s: T(9), e: T(10) }); S.risks = S.risks.filter(r => r.id !== 'r1'); S.margin = [];
    const aid = audit('user', 'Aceptaste reorganizar: ampliar el borrador de Beta y mover la factura de Norte a mañana.', () => {
      b3.e = old.e; S.blocks.push(old.b4); S.blocks.sort((a, b) => a.s - b.s); S.moved = S.moved.filter(m => m.id !== 'b4'); S.risks.unshift(old.r1); S.margin = [{ s: T(16), e: T(16, 30) }];
    });
    closeModal(); render(); toast('Plan actualizado. La holgura de Beta sube a 5 h.', () => H.undo({ id: aid }));
  },
  undo: d => { const f = undoers[d.id]; if (!f) return; f(); const a = S.audit.find(x => x.id === d.id); a.undone = true; delete undoers[d.id]; closeModal(); render(); toast('Deshecho.'); },
  confirm: d => {
    const p = S.proposals.find(x => x.id === d.id);
    if (p.kind === 'capture') S.unscheduled.push({ title: p.action, client: p.client, due: p.due, est: p.est });
    else S.commitments.unshift({ id: 'c' + (++idN), dir: p.dir, client: p.client, action: p.action, who: p.who, due: p.due, status: 'confirmed' });
    S.proposals = S.proposals.filter(x => x.id !== p.id);
    audit('user', `Confirmaste «${p.action}».`); editing = null; render();
    toast(p.kind === 'capture' ? 'Añadida. Meri la programará en el siguiente hueco.' : 'Confirmado. Ya está en tus compromisos.');
  },
  'confirm-explicit': () => { S.proposals.filter(p => p.kind === 'explicit' && p.conf >= .9).forEach(p => H.confirm({ id: p.id })); },
  dismiss: d => { const p = S.proposals.find(x => x.id === d.id); S.proposals = S.proposals.filter(x => x.id !== d.id); audit('user', `Descartaste «${p.action}». Meri aprenderá de esto.`); render(); toast('Descartada. Meri aprenderá de esto.'); },
  edit: d => { editing = d.id; render(); const i = $('#e-action'); if (i) i.focus(); },
  cancel: () => { editing = null; render(); },
  save: d => { const p = S.proposals.find(x => x.id === d.id); p.action = $('#e-action').value.trim() || p.action; p.due = $('#e-due').value.trim(); editing = null; H.confirm({ id: p.id }); },
  fulfil: d => { const c = S.commitments.find(x => x.id === d.id); S.commitments = S.commitments.filter(x => x.id !== c.id); audit('user', `Marcaste como cumplido «${c.action}».`); render(); toast('Cumplido. Cuenta para tu informe de valor.'); },
  followup: d => openFollowup(d.id),
  'save-draft': d => { const c = S.commitments.find(x => x.id === d.id); audit('ia', `Preparó un borrador de seguimiento para ${c.who}.`); closeModal(); toast('Borrador guardado en Gmail. Meri no envía correos.'); },
  remind: d => { closeModal(); toast('Te lo recordaré mañana a las 9:00.'); },
  brief: d => openBrief(d.v),
  approve: d => { S.time.find(t => t.id === d.id).status = 'approved'; render(); },
  'approve-all': () => { S.time.forEach(t => t.status = t.status === 'suggested' ? 'approved' : t.status); audit('user', 'Aprobaste todo el tiempo sugerido.'); render(); toast('Todo el tiempo sugerido quedó aprobado.'); },
  csv: () => { downloadText('meri-tiempo.csv', csvOf(S.time.filter(t => t.status === 'approved'))); toast('Exportadas las entradas aprobadas.'); },
  auto: d => { S.autonomy = d.v; audit('user', d.v === 'suggest' ? 'Cambiaste la autonomía a «Solo sugerir».' : 'Cambiaste la autonomía a «Actuar en lo de bajo riesgo».'); render(); },
  theme: () => { const r = document.documentElement, dark = r.dataset.theme === 'dark' || (!r.dataset.theme && matchMedia('(prefers-color-scheme:dark)').matches); r.dataset.theme = dark ? 'light' : 'dark'; },
  close: () => closeModal(),
  pal: () => openPal(),
  'pal-capture': () => capture(),
  'pal-cmd': d => { closePal(); CMDS[+d.i][2](); },
  'toast-demo': (d, b) => toast(b.dataset.m),
  'toast-undo': () => { const f = tUndo; $('#toast').hidden = true; if (f) f(); },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b) { H[b.dataset.act]?.(b.dataset, b, e); return; }
  if (e.target.id === 'modal') closeModal();
  if (e.target.id === 'pal') closePal();
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#pal').hidden ? openPal() : closePal(); return; }
  if (e.key === 'Escape') { closePal(); closeModal(); }
  if (!$('#pal').hidden) {
    const btns = $$('#pal-body button');
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palIdx + 1, btns.length - 1); palRender(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(palIdx - 1, 0); palRender(); }
    if (e.key === 'Enter') { e.preventDefault(); const a = $('#pal-body button.act') || btns[0]; if (a) a.click(); }
  }
});
document.addEventListener('input', e => { if (e.target.id === 'pal-in') { palIdx = 0; palRender(); } });
render();
