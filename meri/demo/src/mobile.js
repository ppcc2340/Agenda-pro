let tab = 'hoy', more = null, day = 0, dir = 'owed_by_me', cf = null, sheet = null, editing = null;
let auditN = 0, idN = 100, tUndo = null, tTimer = null;
const undoers = {};
const TABS = [['hoy','sun','Hoy'],['entrada','inbox','Entrada'],['agenda','cal','Agenda'],['comp','layers','Compromisos'],['mas','more','Más']];

function audit(who, text, undo) {
  const id = 'a' + (++auditN);
  S.audit.unshift({ id, who, text, time: hm(NOW_MIN + auditN), undoable: !!undo });
  if (undo) undoers[id] = undo; return id;
}
function toast(msg, undo) {
  const t = $('#toast'); tUndo = undo || null;
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="link" data-act="toast-undo">Deshacer</button>' : ''}`;
  t.hidden = false; clearTimeout(tTimer); tTimer = setTimeout(() => t.hidden = true, 6000);
}
const curBlock = () => S.blocks.find(b => !b.done && b.s <= NOW_MIN && b.e > NOW_MIN) || S.blocks.find(b => !b.done && b.s > NOW_MIN);
const riskCount = () => S.risks.length + S.commitments.filter(c => c.status === 'overdue').length;

function render() {
  const sc = $('#screen').scrollTop;
  const views = { hoy: vHoy, entrada: vEntrada, agenda: vAgenda, comp: vComp, mas: vMas };
  $('#screen').innerHTML = views[tab]();
  $('#screen').scrollTop = sc;
  $('#tabbar').innerHTML = TABS.map(([k, i, l]) => `<button data-act="tab" data-v="${k}" ${tab === k ? 'aria-current="page"' : ''}>${ic(i, 22)}<span>${l}</span>
    ${k === 'entrada' && S.proposals.length ? `<em class="bdg">${S.proposals.length}</em>` : ''}${k === 'comp' && riskCount() ? `<em class="bdg r">${riskCount()}</em>` : ''}</button>`).join('');
  $('#fab').hidden = tab === 'mas' && !!more;
}

/* ---------- Hoy ---------- */
function vHoy() {
  const cur = curBlock();
  const next = S.blocks.filter(b => !b.done && b !== cur).sort((a, b) => a.pri - b.pri || a.s - b.s).slice(0, 2);
  const waiting = S.commitments.filter(c => c.dir === 'owed_to_me').sort((a, b) => (b.status === 'overdue') - (a.status === 'overdue')).slice(0, 3);
  const nowCard = cur ? (() => {
    const live = cur.s <= NOW_MIN, pct = live ? Math.round((NOW_MIN - cur.s) / (cur.e - cur.s) * 100) : 0;
    return `<div class="card now-m" style="--cc:${cc(cur.client)}">${chip(cur.client)}<h3>${esc(cur.title)}</h3>
      <p class="muted num">${live ? `Quedan ${fmtMin(cur.e - NOW_MIN)} de este bloque.` : `Empieza a las ${hm(cur.s)} y dura ${fmtMin(cur.e - cur.s)}.`}</p>
      <div class="bar"><b style="width:${pct}%"></b></div>
      <button class="btn primary block" data-act="done" data-id="${cur.id}">${ic('check', 18)}Marcar como hecho</button>
      <p class="dim" style="margin-top:10px;font-size:13px"><b style="color:var(--ink2)">Por qué ahora.</b> ${esc(cur.why)}</p></div>`;
  })() : `<div class="empty"><h3>Has terminado el plan de hoy</h3><p>No queda nada programado.</p></div>`;
  return `<header class="mh"><h1>Lunes 19 de octubre</h1><p>${S.risks.length ? `Tu plan cabe con margen. ${S.risks.length === 1 ? 'Una cosa pide' : 'Dos cosas piden'} atención.` : 'Tu plan cabe con margen y no hay nada en riesgo.'}</p></header>
  <section class="msec"><h2>¿Qué hago ahora?</h2>${nowCard}</section>
  ${next.length ? `<section class="msec"><h2>¿Qué es lo más importante hoy?</h2><div>${next.map(b => `<div class="lrow"><div class="grow"><div class="t">${esc(b.title)}</div><div class="m">${chip(b.client)}<span class="num">${hm(b.s)} a ${hm(b.e)}</span></div></div></div>`).join('')}</div></section>` : ''}
  <section class="msec"><h2>¿Qué podría salir mal?</h2>
    ${S.risks.map(r => `<div class="lrow risk-m"><div class="grow"><div class="t">${esc(r.title)}</div><div class="m">${chip(r.client)}</div><p class="muted" style="font-size:13.5px;margin-top:4px">${esc(r.detail)}</p>
      <button class="btn sm ${r.fix === 'reorganize' ? 'primary' : ''}" style="margin-top:9px" data-act="${r.fix === 'reorganize' ? 'sheet-reorg' : 'sheet-follow'}" data-id="${r.cid || ''}">${r.fix === 'reorganize' ? 'Ver cómo reorganizar' : 'Preparar seguimiento'}</button></div></div>`).join('') || '<div class="empty"><h3>Sin riesgos a la vista</h3><p>Si algo pone en peligro una fecha, lo verás aquí con una propuesta.</p></div>'}</section>
  <section class="msec"><h2>¿Qué estoy esperando de otras personas?</h2>
    ${waiting.map(c => `<div class="lrow"><div class="grow"><div class="t">${esc(c.action)}</div><div class="m">${chip(c.client)}<span>${esc(c.who)}</span><span class="pill ${c.status === 'overdue' ? 'risk' : 'plain'}">${c.status === 'overdue' ? 'Vencido ' + esc(c.due) : 'Para ' + esc(c.due)}</span></div></div></div>`).join('')}</section>
  ${S.unscheduled.length ? `<section class="msec"><h2>Por programar</h2>${S.unscheduled.map(u => `<div class="lrow"><div class="grow"><div class="t">${esc(u.title)}</div><div class="m">${u.client ? chip(u.client) : ''}${u.due ? `<span>Para el ${esc(u.due)}</span>` : ''}${u.est ? `<span>${fmtMin(u.est)}</span>` : ''}</div></div></div>`).join('')}</section>` : ''}`;
}

/* ---------- Entrada ---------- */
function vEntrada() {
  const kl = { explicit:'Explícito', inferred:'Inferido', suggested:'Sugerencia', capture:'Captura' };
  return `<header class="mh"><h1>Entrada</h1><p>Meri propone, tú decides. Nada es definitivo hasta que lo confirmes.</p></header>
  ${S.proposals.map(p => { const ed = editing === p.id; return `<article class="pcard" style="--cc:${cc(p.client)}">
    ${ed ? `<input id="e-action" value="${esc(p.action)}" aria-label="Acción"><input id="e-due" value="${esc(p.due || '')}" aria-label="Fecha">` : `<div class="t">${esc(p.action)}</div>`}
    <div class="m" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--ink2);font-size:13px;margin-top:5px">${chip(p.client)}${p.kind !== 'capture' ? `<span>${p.dir === 'owed_to_me' ? 'Te lo debe' : 'Se lo debes a'} ${esc(p.who)}</span>` : ''}<span>${p.due ? 'Para: ' + esc(p.due) : 'Sin fecha'}</span>${p.est ? `<span>${fmtMin(p.est)}</span>` : ''}</div>
    <div style="margin-top:8px;display:flex;gap:10px;align-items:center"><span class="pill sug">${kl[p.kind]}</span>${p.conf ? `<span class="conf"><span><b style="width:${p.conf * 100}%"></b></span>${Math.round(p.conf * 100)} %</span>` : ''}</div>
    ${p.evidence ? `<div class="q">“${esc(p.evidence)}”</div><div class="src">Del hilo «${esc(p.source)}»</div>` : ''}
    <div class="acts">${ed ? `<button class="btn primary" style="justify-content:center" data-act="save" data-id="${p.id}">Guardar y confirmar</button><button class="btn" data-act="cancel">Cancelar</button><span></span>`
      : `<button class="btn primary" style="justify-content:center" data-act="confirm" data-id="${p.id}">${ic('check', 16)}Confirmar</button><button class="btn" data-act="edit" data-id="${p.id}" aria-label="Editar">${ic('edit', 16)}</button><button class="btn" data-act="dismiss" data-id="${p.id}" aria-label="Descartar">${ic('x', 16)}</button>`}</div></article>`; }).join('')
   || `<div class="empty"><h3>Todo al día</h3><p>Cuando llegue un correo con un compromiso, o captures algo con el botón +, aparecerá aquí.</p></div>`}`;
}

/* ---------- Agenda ---------- */
function vAgenda() {
  const { events, blocks } = dayItems(day);
  const items = [...events.map(e => ({ ...e, ev: true })), ...blocks].sort((a, b) => a.s - b.s);
  let html = '', shown = false;
  const nowRow = `<div class="nw"><em>${hm(NOW_MIN)}</em><div></div></div>`;
  items.forEach(x => {
    if (day === 0 && !shown && x.s > NOW_MIN) { html += nowRow; shown = true; }
    html += `<div class="it"><div class="tm num">${hm(x.s)}</div><div class="bx ${x.ev ? 'fx' : ''} ${x.done ? 'dn' : ''}" style="--cc:${cc(x.client)}"><b>${esc(x.title)}</b><span class="num">${hm(x.s)} a ${hm(x.e)}${x.ev ? '. Reunión fija' : ''}</span></div></div>`;
  });
  if (day === 0 && !shown) html += nowRow;
  return `<header class="mh"><h1>Agenda</h1><p>Tus reuniones y los bloques que Meri reserva. Meri no toca tus reuniones.</p></header>
  <div class="dstrip">${DAYS.map((d, i) => `<button data-act="day" data-v="${i}" aria-pressed="${day === i}"><span>${d.split(' ')[0]}</span><b>${d.split(' ')[1]}</b></button>`).join('')}</div>
  <div class="ag">${html}</div>`;
}

/* ---------- Compromisos ---------- */
function vComp() {
  const list = S.commitments.filter(c => c.dir === dir && (!cf || c.client === cf));
  const cnt = d => S.commitments.filter(c => c.dir === d).length;
  const st = { confirmed:['Confirmado','plain'], overdue:['Vencido','risk'] };
  return `<header class="mh"><h1>Compromisos</h1><p>Lo que debes y lo que te deben.</p></header>
  <div class="seg"><button data-act="dir" data-v="owed_by_me" aria-pressed="${dir === 'owed_by_me'}">Debo (${cnt('owed_by_me')})</button><button data-act="dir" data-v="owed_to_me" aria-pressed="${dir === 'owed_to_me'}">Me deben (${cnt('owed_to_me')})</button></div>
  <div class="fscroll">${Object.keys(CLIENTS).map(k => `<button class="fchip" style="--cc:${cc(k)}" data-act="cf" data-v="${cf === k ? '' : k}" aria-pressed="${cf === k}"><i></i>${CLIENTS[k].name}</button>`).join('')}</div>
  <div style="margin-top:6px">${list.map(c => `<div class="lrow"><div class="grow"><div class="t">${esc(c.action)}</div><div class="m">${chip(c.client)}<span>${esc(c.who)}</span></div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="pill ${st[c.status][1]}">${st[c.status][0]}, ${esc(c.due)}</span>
    ${c.dir === 'owed_to_me' ? `<button class="btn sm ${c.status === 'overdue' ? 'primary' : ''}" data-act="sheet-follow" data-id="${c.id}">${ic('mail', 14)}Seguimiento</button>` : `<button class="btn sm" data-act="fulfil" data-id="${c.id}">${ic('check', 14)}Cumplido</button>`}</div></div></div>`).join('') || '<div class="empty">No hay compromisos con este filtro.</div>'}</div>`;
}

/* ---------- Más ---------- */
function vMas() {
  if (!more) return `<header class="mh"><h1>Más</h1><p>Tiempo, clientes y control de lo que hace Meri.</p></header>
  <div class="mlist" style="margin-top:12px">${[['tiempo','clock','Tiempo',`${S.time.filter(t => t.status === 'suggested').length} entradas sugeridas por revisar`],['clientes','users','Clientes y briefings','Cada cliente con su contexto aislado'],['actividad','undo','Actividad','Qué hizo Meri y cómo deshacerlo'],['ajustes','shield','Autonomía y privacidad','Permisos, conexiones y créditos de IA']].map(([k, i, t, s]) => `<button class="mr" data-act="more" data-v="${k}">${ic(i, 22)}<span class="grow"><b>${t}</b><small>${s}</small></span>${ic('chev', 16)}</button>`).join('')}</div>`;
  const back = t => `<header class="mh"><button class="back" data-act="more" data-v="">${ic('back', 18)}Más</button><h1>${t}</h1></header>`;
  if (more === 'tiempo') {
    const ap = S.time.filter(t => t.status === 'approved'), su = S.time.filter(t => t.status === 'suggested'), sum = a => a.reduce((x, t) => x + t.min, 0);
    return back('Tiempo') + `<div class="stats"><div><b class="num">${fmtMin(sum(ap))}</b><span>Aprobadas</span></div><div><b class="num" style="color:var(--sug)">${fmtMin(sum(su))}</b><span>Por revisar</span></div></div>
    <div style="display:flex;gap:8px;margin:10px 0">${su.length ? `<button class="btn primary" data-act="approve-all">Aprobar las ${su.length}</button>` : ''}<button class="btn" data-act="csv">${ic('download', 16)}Exportar CSV</button></div>
    ${[...su, ...ap].map(t => `<div class="lrow"><div class="grow"><div class="t">${esc(t.desc)}</div><div class="m">${chip(t.client)}<span>${t.day}</span><span>${esc(t.src)}</span></div></div>
      <div style="text-align:right"><div class="num" style="font-weight:600">${fmtMin(t.min)}</div>${t.status === 'approved' ? '<span class="pill ok">Aprobada</span>' : `<button class="btn sm" style="margin-top:4px" data-act="approve" data-id="${t.id}">Aprobar</button>`}</div></div>`).join('')}
    <p class="dim" style="margin-top:12px;font-size:13px">Nada cuenta como facturable hasta que lo apruebas.</p>`;
  }
  if (more === 'clientes') return back('Clientes') + Object.keys(CLIENTS).map(k => {
    const open = S.commitments.filter(c => c.client === k).length, mins = S.time.filter(t => t.client === k).reduce((a, t) => a + t.min, 0);
    return `<div class="lrow" style="align-items:center"><span style="width:7px;height:42px;border-radius:4px;background:${cc(k)};flex-shrink:0"></span><div class="grow"><div class="t">${CLIENTS[k].name}</div><div class="m"><span>${open} compromisos</span><span>${fmtMin(mins)} esta semana</span></div></div><button class="btn sm" data-act="sheet-brief" data-v="${k}">Briefing</button></div>`; }).join('')
    + `<p class="dim" style="margin-top:12px;font-size:13px">${ic('shield', 14)} Cada briefing usa solo datos del cliente elegido.</p>`;
  if (more === 'actividad') return back('Actividad') + S.audit.slice(0, 10).map(a => `<div class="lrow"><span class="pill ${a.who === 'ia' ? 'sug' : a.who === 'user' ? 'ok' : 'plain'}">${{ ia:'IA', user:'Tú', sistema:'Sistema' }[a.who]}</span><div class="grow">${esc(a.text)}<div class="dim num" style="font-size:12.5px">${a.time}</div></div>
    ${a.undoable && !a.undone ? `<button class="btn sm" data-act="undo" data-id="${a.id}">Deshacer</button>` : a.undone ? '<span class="dim" style="font-size:13px">Deshecho</span>' : ''}</div>`).join('');
  if (more === 'ajustes') return back('Autonomía y privacidad') + `
    <section class="msec" style="margin-top:6px"><h2>Autonomía</h2><div class="seg" style="margin-top:0"><button data-act="auto" data-v="suggest" aria-pressed="${S.autonomy === 'suggest'}">Solo sugerir</button><button data-act="auto" data-v="low" aria-pressed="${S.autonomy === 'low'}">Bajo riesgo</button></div>
    <p class="muted" style="margin-top:8px;font-size:13.5px">${S.autonomy === 'suggest' ? 'Meri propone y tú confirmas todo.' : 'Meri puede confirmar compromisos explícitos y mover sus bloques. Nunca toca reuniones ni envía correos.'}</p></section>
    <section class="msec"><h2>Conexiones</h2><div class="lrow"><div class="grow"><b>Google Calendar</b><div class="muted" style="font-size:13px">Escribe solo en el calendario «Meri»</div></div><span class="pill sug">Demo</span></div><div class="lrow"><div class="grow"><b>Gmail</b><div class="muted" style="font-size:13px">Lectura y borradores. Sin envío</div></div><span class="pill sug">Demo</span></div></section>
    <section class="msec"><h2>Créditos de IA</h2><div class="num"><b style="font:600 22px var(--f-head)">412</b> <span class="muted">de 1.500 este mes</span></div><div class="meter"><b style="width:27%"></b></div><p class="muted" style="font-size:13px">Al llegar al límite, la IA se pausa y el plan sigue funcionando.</p></section>
    <section class="msec"><h2>Privacidad</h2><div style="display:grid;gap:8px"><button class="btn" data-act="toast-demo" data-m="En el producto real, esto pausa la lectura de correo al instante.">Pausar lectura de correo</button><button class="btn" data-act="toast-demo" data-m="Se descargaría un archivo con todos tus datos.">Exportar mis datos</button><button class="btn risk" data-act="toast-demo" data-m="En la demo no se elimina nada.">Eliminar mi cuenta</button></div></section>`;
}

/* ---------- Hojas ---------- */
function openSheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`; s.hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }
function sheetCapture() {
  openSheet(`<h2>Capturar</h2><p class="sub">Escribe como hablas. Meri entiende clientes, fechas y duración.</p>
  <input class="cin" id="cap" placeholder="Informe para Acme el jueves, 2 h" autocomplete="off" aria-label="Captura"><div class="chips" id="chips" aria-live="polite"></div>
  <div class="foot"><button class="btn primary block" data-act="capture">${ic('plus', 18)}Añadir a Entrada</button></div>`);
  $('#cap').focus();
}
function chipsUpdate() {
  const q = $('#cap').value.trim(); if (!q) { $('#chips').innerHTML = ''; return; }
  const p = parseCapture(q);
  $('#chips').innerHTML = `<span class="pill sug">${esc(p.title)}</span>${p.client ? chip(p.client) : ''}${p.due ? `<span class="pill sug">Para: ${esc(p.due)}</span>` : ''}${p.est ? `<span class="pill sug">${fmtMin(p.est)}</span>` : ''}`;
}
function sheetReorg() {
  openSheet(`<h2>Proteger la fecha de Beta</h2><p class="sub">Meri propone dos cambios. Ninguna reunión se mueve.</p>
  <div class="diff"><b>Borrador de contestación para Beta</b><div class="ar"><s class="num">13:30 a 15:00</s>${ic('chev', 14)}<b class="num" style="color:var(--ink)">13:30 a 16:00</b><span class="pill ok">+1 h</span></div></div>
  <div class="diff"><b>Revisar factura de Estudio Norte</b><div class="ar"><s class="num">Hoy 15:00 a 16:00</s>${ic('chev', 14)}<b class="num" style="color:var(--ink)">Mañana 09:00</b></div></div>
  <p class="muted" style="margin-top:12px;font-size:14px"><b style="color:var(--ink)">Qué cambia.</b> La holgura de Beta sube de 3 h a 5 h. La factura de Norte no tiene fecha límite esta semana.</p>
  <div class="foot"><button class="btn primary block" data-act="accept-reorg">Aceptar cambios</button><button class="btn block" data-act="close">Ahora no</button></div><p class="dim" style="margin-top:10px;font-size:12.5px;text-align:center">Podrás deshacerlo desde Actividad.</p>`);
}
function sheetFollow(cid) {
  const c = S.commitments.find(x => x.id === cid), d = followupDraft(c);
  openSheet(`<h2>Seguimiento para ${esc(c.who)}</h2><p class="sub">Asunto: ${esc(d.subject)}</p><label class="sr" for="draft">Borrador</label><textarea id="draft">${esc(d.body)}</textarea>
  <div class="foot"><button class="btn primary block" data-act="save-draft" data-id="${c.id}">${ic('mail', 18)}Guardar borrador en Gmail</button><button class="btn block" data-act="remind">Recordarme mañana</button></div><p class="dim" style="margin-top:10px;font-size:12.5px;text-align:center">Meri solo crea borradores. Tú decides cuándo enviarlo.</p>`);
}
function sheetBrief(k) {
  openSheet(`<h2>Briefing de ${esc(CLIENTS[k].name)}</h2><p class="sub">${ic('shield', 14)} Contexto aislado: solo datos de este cliente.</p>
  ${BRIEFS[k].map(([t, kind, src]) => `<div class="lrow"><div class="grow">${esc(t)}<div class="dim" style="font-size:12.5px;margin-top:2px">${kind}: ${esc(src)}</div></div></div>`).join('')}
  <div class="foot"><button class="btn primary block" data-act="close">Cerrar</button></div>`);
}

/* ---------- Acciones ---------- */
const H = {
  tab: d => { tab = d.v; more = null; editing = null; render(); $('#screen').scrollTop = 0; },
  more: d => { more = d.v || null; render(); $('#screen').scrollTop = 0; },
  day: d => { day = +d.v; render(); },
  dir: d => { dir = d.v; render(); },
  cf: d => { cf = d.v || null; render(); },
  done: d => {
    const b = S.blocks.find(x => x.id === d.id); b.done = true;
    S.time.unshift({ id: 't' + (++idN), day: 'Lun 19', client: b.client, desc: b.title, min: b.e - b.s, src: 'Bloque completado', status: 'suggested' });
    audit('user', `Completaste «${b.title}». Meri sugirió ${fmtMin(b.e - b.s)} de tiempo.`);
    render(); toast(`Hecho. Añadí ${fmtMin(b.e - b.s)} sugeridas en Tiempo.`);
  },
  'sheet-capture': () => sheetCapture(),
  capture: () => {
    const q = $('#cap').value.trim(); if (!q) return; const p = parseCapture(q), id = 'p' + (++idN);
    S.proposals.unshift({ id, kind:'capture', client:p.client, action:p.title, due:p.due, est:p.est, conf:null, dir:'owed_by_me', who:'' });
    const aid = audit('user', `Capturaste «${p.title}».`, () => { S.proposals = S.proposals.filter(x => x.id !== id); });
    closeSheet(); render(); toast('Capturado en Entrada. Revisa lo que Meri entendió.', () => H.undo({ id: aid }));
  },
  'sheet-reorg': () => sheetReorg(),
  'accept-reorg': () => {
    const b3 = S.blocks.find(b => b.id === 'b3'), b4 = S.blocks.find(b => b.id === 'b4'), r1 = S.risks.find(r => r.id === 'r1'), oldE = b3.e, oldB4 = { ...b4 };
    b3.e = T(16); S.blocks = S.blocks.filter(b => b.id !== 'b4'); S.moved.push({ ...b4, s: T(9), e: T(10) }); S.risks = S.risks.filter(r => r.id !== 'r1'); S.margin = [];
    const aid = audit('user', 'Aceptaste reorganizar: ampliar el borrador de Beta y mover la factura de Norte a mañana.', () => {
      b3.e = oldE; S.blocks.push(oldB4); S.blocks.sort((a, b) => a.s - b.s); S.moved = S.moved.filter(m => m.id !== 'b4'); S.risks.unshift(r1); S.margin = [{ s: T(16), e: T(16, 30) }];
    });
    closeSheet(); render(); toast('Plan actualizado. La holgura de Beta sube a 5 h.', () => H.undo({ id: aid }));
  },
  undo: d => { const f = undoers[d.id]; if (!f) return; f(); S.audit.find(x => x.id === d.id).undone = true; delete undoers[d.id]; render(); toast('Deshecho.'); },
  confirm: d => {
    const p = S.proposals.find(x => x.id === d.id);
    if (p.kind === 'capture') S.unscheduled.push({ title: p.action, client: p.client, due: p.due, est: p.est });
    else S.commitments.unshift({ id: 'c' + (++idN), dir: p.dir, client: p.client, action: p.action, who: p.who, due: p.due, status: 'confirmed' });
    S.proposals = S.proposals.filter(x => x.id !== p.id); audit('user', `Confirmaste «${p.action}».`); editing = null; render();
    toast(p.kind === 'capture' ? 'Añadida. Meri la programará en el siguiente hueco.' : 'Confirmado. Ya está en tus compromisos.');
  },
  dismiss: d => { const p = S.proposals.find(x => x.id === d.id); S.proposals = S.proposals.filter(x => x.id !== d.id); audit('user', `Descartaste «${p.action}». Meri aprenderá de esto.`); render(); toast('Descartada. Meri aprenderá de esto.'); },
  edit: d => { editing = d.id; render(); },
  cancel: () => { editing = null; render(); },
  save: d => { const p = S.proposals.find(x => x.id === d.id); p.action = $('#e-action').value.trim() || p.action; p.due = $('#e-due').value.trim(); editing = null; H.confirm({ id: p.id }); },
  fulfil: d => { const c = S.commitments.find(x => x.id === d.id); S.commitments = S.commitments.filter(x => x.id !== c.id); audit('user', `Marcaste como cumplido «${c.action}».`); render(); toast('Cumplido. Cuenta para tu informe de valor.'); },
  'sheet-follow': d => sheetFollow(d.id),
  'save-draft': d => { const c = S.commitments.find(x => x.id === d.id); audit('ia', `Preparó un borrador de seguimiento para ${c.who}.`); closeSheet(); toast('Borrador guardado en Gmail. Meri no envía correos.'); },
  remind: () => { closeSheet(); toast('Te lo recordaré mañana a las 9:00.'); },
  'sheet-brief': d => sheetBrief(d.v),
  approve: d => { S.time.find(t => t.id === d.id).status = 'approved'; render(); },
  'approve-all': () => { S.time.forEach(t => { if (t.status === 'suggested') t.status = 'approved'; }); audit('user', 'Aprobaste todo el tiempo sugerido.'); render(); toast('Todo el tiempo sugerido quedó aprobado.'); },
  csv: () => { downloadText('meri-tiempo.csv', csvOf(S.time.filter(t => t.status === 'approved'))); toast('Exportadas las entradas aprobadas.'); },
  auto: d => { S.autonomy = d.v; audit('user', d.v === 'suggest' ? 'Cambiaste la autonomía a «Solo sugerir».' : 'Cambiaste la autonomía a «Bajo riesgo».'); render(); },
  close: () => closeSheet(),
  'toast-demo': (d, b) => toast(b.dataset.m),
  'toast-undo': () => { const f = tUndo; $('#toast').hidden = true; if (f) f(); },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b) { H[b.dataset.act]?.(b.dataset, b, e); return; }
  if (e.target.id === 'sheet') closeSheet();
});
document.addEventListener('input', e => { if (e.target.id === 'cap') chipsUpdate(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.id === 'cap') { e.preventDefault(); H.capture(); }
});
render();
