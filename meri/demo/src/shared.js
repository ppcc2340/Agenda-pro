/* ===== Datos de ejemplo y utilidades compartidas (demo de Meri) ===== */
const BASE = new Date(2026, 9, 19);            // lunes 19 de octubre de 2026
const T = (h, m = 0) => h * 60 + m;
const NOW_MIN = T(10, 40);
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const fmtMin = m => m < 60 ? m + ' min' : (Math.round(m / 6) / 10).toString().replace('.', ',') + ' h';
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const CLIENTS = {
  acme:  { name: 'Acme Corp',       css: 'var(--c-acme)' },
  norte: { name: 'Estudio Norte',   css: 'var(--c-norte)' },
  luna:  { name: 'Luna Legal',      css: 'var(--c-luna)' },
  beta:  { name: 'Beta Logística',  css: 'var(--c-beta)' },
};
const cc = c => c ? CLIENTS[c].css : 'var(--ink3)';
const chip = c => c ? `<span class="chip" style="--cc:${CLIENTS[c].css}"><i></i>${esc(CLIENTS[c].name)}</span>` : '';

const IC = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  inbox:'<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  layers:'<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  sliders:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x:'<path d="M6 6l12 12M18 6L6 18"/>',
  edit:'<path d="M4 20h4l11-11-4-4L4 16z"/>',
  search:'<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  alert:'<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  undo:'<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  moon:'<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  more:'<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  back:'<path d="M15 5l-7 7 7 7"/>',
  chev:'<path d="M9 5l7 7-7 7"/>',
  users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3-5.5 6.5-5.5s5.9 2 6.5 5.5"/><path d="M16 5a3.5 3.5 0 010 6.5M18 14.8c2 .6 3.3 2.4 3.7 5.2"/>',
  download:'<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
};
const ic = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const LOGO = (s = 26) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--sea)"/><path d="M5 13c3.5-3 7-3 10.5 0s7 3 11.5 0" stroke="var(--on-sea)" stroke-width="2.4" stroke-linecap="round"/><path d="M5 20c3.5-3 7-3 10.5 0s7 3 11.5 0" stroke="var(--on-sea)" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg>`;

const S = {
  events: [
    { id:'e1', title:'Llamada semanal con Acme',               client:'acme',  s:T(9,30),  e:T(10,15) },
    { id:'e2', title:'Almuerzo',                                client:null,    s:T(12,30), e:T(13,30), personal:true },
    { id:'e3', title:'Reunión de estrategia con Estudio Norte', client:'norte', s:T(16,30), e:T(17,30) },
  ],
  blocks: [
    { id:'b1', title:'Responder consultas de Luna',        client:'luna',  s:T(8,45),  e:T(9,30),  kind:'shallow', pri:3, done:true,  why:'Prioridad alta y cabía antes de la llamada con Acme.' },
    { id:'b2', title:'Informe trimestral de Acme',         client:'acme',  s:T(10,30), e:T(12,30), kind:'deep',    pri:1, done:false, why:'Vence el jueves y es tu bloque de concentración más largo de la semana. Lo protegí de reuniones y mensajes.' },
    { id:'b3', title:'Borrador de contestación para Beta', client:'beta',  s:T(13,30), e:T(15,0),  kind:'deep',    pri:1, done:false, why:'Vence el miércoles y todavía necesita 4,5 h. Es la tarea con menos holgura de la semana.' },
    { id:'b4', title:'Revisar factura de Estudio Norte',   client:'norte', s:T(15,0),  e:T(16,0),  kind:'shallow', pri:3, done:false, why:'Es corta y no tiene fecha límite esta semana. Llena el hueco antes de la reunión con Norte.' },
    { id:'b5', title:'Preparar briefing de Luna Legal',    client:'luna',  s:T(17,30), e:T(18,15), kind:'shallow', pri:2, done:false, why:'Mañana tienes comité con Luna. Lo dejo después de la reunión con Norte para que llegues con contexto fresco.' },
  ],
  margin: [{ s:T(16,0), e:T(16,30) }],
  moved: [],
  unscheduled: [],
  risks: [
    { id:'r1', title:'El borrador para Beta vence el miércoles', detail:'Necesitas 4,5 h y solo te quedan 3 h de holgura.', client:'beta', fix:'reorganize' },
    { id:'r2', title:'El briefing de Luna depende de un documento que no llega', detail:'Marta Díaz aún no envía el poder notarial firmado.', client:'luna', fix:'followup', cid:'c5' },
  ],
  proposals: [
    { id:'p1', kind:'explicit',  dir:'owed_to_me', client:'acme',  who:'Ana Ruiz',    action:'Enviar el contrato firmado',           due:'miércoles 21 oct', conf:.94, evidence:'te envío el contrato firmado el miércoles',   source:'RE: Contrato de servicios 2026' },
    { id:'p2', kind:'inferred',  dir:'owed_by_me', client:'beta',  who:'Pablo Soto',  action:'Revisar el presupuesto de transporte', due:'sin fecha',        conf:.71, evidence:'¿Podrías mirar el presupuesto cuando puedas?', source:'Presupuesto transporte Q4' },
    { id:'p3', kind:'suggested', dir:'owed_by_me', client:'norte', who:'Laura Vidal', action:'Agendar la reunión de cierre',         due:'fin de mes',       conf:.55, evidence:'Quizá podríamos vernos a fin de mes',          source:'Cierre de proyecto' },
  ],
  commitments: [
    { id:'c1', dir:'owed_by_me', client:'acme',  action:'Entregar el informe trimestral',          who:'Ana Ruiz',      due:'jueves 22 oct',    status:'confirmed' },
    { id:'c2', dir:'owed_by_me', client:'acme',  action:'Enviar la propuesta revisada',            who:'Ana Ruiz',      due:'mañana',           status:'confirmed' },
    { id:'c3', dir:'owed_by_me', client:'luna',  action:'Confirmar la fecha de audiencia',         who:'Marta Díaz',    due:'viernes 23 oct',   status:'confirmed' },
    { id:'c4', dir:'owed_to_me', client:'acme',  action:'Datos de ventas del tercer trimestre',    who:'Carlos Ibáñez', due:'ayer',             status:'overdue' },
    { id:'c5', dir:'owed_to_me', client:'luna',  action:'Poder notarial firmado',                  who:'Marta Díaz',    due:'miércoles 21 oct', status:'confirmed' },
    { id:'c6', dir:'owed_to_me', client:'beta',  action:'Aprobación del presupuesto',              who:'Pablo Soto',    due:'viernes 23 oct',   status:'confirmed' },
  ],
  time: [
    { id:'t1', day:'Lun 19', client:'luna',  desc:'Consultas de Luna',                   min:45,  src:'Bloque completado',   status:'suggested' },
    { id:'t2', day:'Lun 19', client:'acme',  desc:'Llamada semanal con Acme',            min:45,  src:'Evento de calendario', status:'suggested' },
    { id:'t3', day:'Jue 15', client:'beta',  desc:'Llamada con Beta Logística',          min:60,  src:'Evento sin tiempo registrado', status:'suggested' },
    { id:'t4', day:'Vie 16', client:'norte', desc:'Reunión de cierre trimestral',        min:90,  src:'Evento de calendario', status:'approved' },
    { id:'t5', day:'Vie 16', client:'beta',  desc:'Revisión de cláusulas de transporte', min:120, src:'Bloque completado',   status:'approved' },
    { id:'t6', day:'Jue 15', client:'acme',  desc:'Redacción del informe',               min:150, src:'Bloque completado',   status:'approved' },
  ],
  audit: [
    { id:'a0', who:'sistema', time:'08:00', text:'Meri generó el plan de hoy con 20 % de margen para imprevistos.' },
    { id:'a00', who:'ia',     time:'08:12', text:'Detectó 3 posibles compromisos en tu correo y los dejó como propuestas.' },
  ],
  autonomy: 'suggest',
};

const BRIEFS = {
  acme:  [['Entregas el informe trimestral el jueves. Hoy tienes 2 h reservadas.','Tarea','Informe trimestral de Acme'],['Carlos Ibáñez debía enviar los datos de ventas y lleva 1 día de retraso.','Compromiso','Datos de ventas del tercer trimestre'],['Ana Ruiz enviará el contrato firmado el miércoles.','Correo','RE: Contrato de servicios 2026'],['Hoy a las 9:30 tuviste la llamada semanal.','Evento','Llamada semanal con Acme']],
  beta:  [['El borrador de contestación vence el miércoles y está en riesgo.','Tarea','Borrador de contestación para Beta'],['Pablo Soto pidió revisar el presupuesto de transporte, sin fecha.','Correo','Presupuesto transporte Q4'],['Pablo Soto prometió aprobar el presupuesto el viernes.','Compromiso','Aprobación del presupuesto']],
  luna:  [['Falta el poder notarial firmado de Marta Díaz. Bloquea el briefing.','Compromiso','Poder notarial firmado'],['Debes confirmar la fecha de audiencia el viernes.','Compromiso','Confirmar la fecha de audiencia'],['Hoy respondiste las consultas de Luna (45 min).','Tarea','Responder consultas de Luna']],
  norte: [['Hoy a las 16:30 tienes la reunión de estrategia.','Evento','Reunión de estrategia con Estudio Norte'],['Queda por revisar la factura del mes.','Tarea','Revisar factura de Estudio Norte'],['Laura Vidal sugirió reunirse a fin de mes. Aún sin confirmar.','Correo','Cierre de proyecto']],
};

const DAYS = ['Lun 19', 'Mar 20', 'Mié 21', 'Jue 22', 'Vie 23'];
const WEEK = [
  null,
  { events:[{ id:'w1', title:'Comité con Luna Legal', client:'luna', s:T(11), e:T(12) }],
    blocks:[{ id:'w2', title:'Enviar la propuesta revisada a Acme', client:'acme', s:T(14), e:T(15), kind:'shallow' }] },
  { events:[], blocks:[{ id:'w3', title:'Cierre del borrador para Beta', client:'beta', s:T(9,30), e:T(11,30), kind:'deep' }] },
  { events:[{ id:'w4', title:'Entrega del informe a Acme', client:'acme', s:T(16), e:T(16,30) }],
    blocks:[{ id:'w5', title:'Revisión final del informe', client:'acme', s:T(10), e:T(12), kind:'deep' }] },
  { events:[], blocks:[{ id:'w6', title:'Confirmar la fecha de audiencia', client:'luna', s:T(9), e:T(9,30), kind:'shallow' },
                       { id:'w7', title:'Bloque de concentración libre', client:null, s:T(10), e:T(12), kind:'deep' }] },
];
function dayItems(i) {
  if (i === 0) return { events: S.events, blocks: S.blocks };
  return { events: WEEK[i].events, blocks: i === 1 ? [...WEEK[1].blocks, ...S.moved] : WEEK[i].blocks };
}

/* ---- Captura en lenguaje natural (reglas; en producto: reglas + IA) ---- */
const WD = [['domingo'], ['lunes'], ['martes'], ['miércoles','miercoles'], ['jueves'], ['viernes'], ['sábado','sabado']];
const fmtDay = d => d.toLocaleDateString('es', { weekday:'long', day:'numeric', month:'short' }).replace('.', '');
function parseCapture(raw) {
  const t = raw.trim(), low = t.toLowerCase();
  const out = { title: t, client: null, due: null, est: null };
  for (const k in CLIENTS) { if (low.includes(CLIENTS[k].name.split(' ')[0].toLowerCase())) { out.client = k; break; } }
  let d = null, word = null;
  if (/\bhoy\b/.test(low)) { d = new Date(BASE); word = 'hoy'; }
  else if (/\bmañana\b|\bmanana\b/.test(low)) { d = new Date(BASE); d.setDate(d.getDate() + 1); word = /\bmañana\b/.test(low) ? 'mañana' : 'manana'; }
  else {
    for (let i = 0; i < 7 && !d; i++) for (const w of WD[i]) {
      if (new RegExp('\\b' + w + '\\b').test(low)) { d = new Date(BASE); d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7)); word = w; break; }
    }
  }
  if (d) out.due = fmtDay(d);
  const m = low.match(/(\d+(?:[.,]\d+)?)\s*(h|hs|hr|hrs|horas?|min|minutos?)\b/);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); out.est = /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n); }
  let title = t;
  if (m) title = title.replace(m[0], '');
  if (word) title = title.replace(new RegExp('\\b(el |para el |para )?' + word + '\\b', 'i'), '');
  out.title = title.replace(/\s{2,}/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '') || t;
  return out;
}

function followupDraft(c) {
  const first = c.who.split(' ')[0];
  return {
    to: c.who,
    subject: 'Seguimiento: ' + c.action.charAt(0).toLowerCase() + c.action.slice(1),
    body: `Hola ${first},\n\nTe escribo por "${c.action.toLowerCase()}", que quedamos en tener para ${c.due}. ¿Podrías enviármelo hoy o mañana? Lo necesito para avanzar con el resto del trabajo.\n\nGracias de antemano.\nUn saludo`,
  };
}
function csvOf(entries) {
  const rows = [['dia','cliente','descripcion','minutos','origen','estado']];
  entries.forEach(e => rows.push([e.day, CLIENTS[e.client].name, e.desc, e.min, e.src, e.status]));
  return rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
}
function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
