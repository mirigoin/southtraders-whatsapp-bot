const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;

// DB
const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (phone TEXT, role TEXT, content TEXT, ts TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, country TEXT, company TEXT, interest TEXT, tier TEXT DEFAULT 'lead', status TEXT DEFAULT 'new', notes TEXT, last_contact TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS outbound_campaigns (id SERIAL PRIMARY KEY, name TEXT, message TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), total_sent INT DEFAULT 0, total_failed INT DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS outbound_logs (id SERIAL PRIMARY KEY, campaign_id INT, phone TEXT, status TEXT DEFAULT 'pending', sent_at TIMESTAMPTZ, error TEXT)`);
  console.log('DB OK');
}

async function loadConversation(phone) {
  try {
    const r = await pool.query('SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts ASC LIMIT 20', [phone]);
    return r.rows;
  } catch(e) { return []; }
}

async function saveMessage(phone, role, content) {
  try { await pool.query('INSERT INTO conversations (phone, role, content) VALUES ($1,$2,$3)', [phone, role, content]); } catch(e) {}
}

async function upsertContact(phone) {
  try { await pool.query(`INSERT INTO crm_contacts (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()`, [phone]); } catch(e) {}
}

// STOCK — sin activar desde Pangea
let stockData = [];
let stockLastUpdated = null;

async function fetchStock() {
  try {
    const resp = await axios.get('https://south-traders.pangea.ar/n6/stock_disp', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = [];
    const trRe = /<tr[^>]*>([sS]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(resp.data)) !== null) {
      const cells = [];
      const tdRe = /<td[^>]*>([sS]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(td[1].replace(/<[^>]+>/g,'').trim());
      if (cells.length >= 3 && cells[0] && cells[1]) rows.push({ desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0 });
    }
    if (rows.length > 0) { stockData = rows; stockLastUpdated = new Date(); console.log('Stock OK: ' + rows.length); }
  } catch(e) { console.error('Stock error:', e.message); }
}

fetchStock();
setInterval(fetchStock, 6 * 3600 * 1000);

function getStockSummary() {
  if (!stockData.length) return 'Stock actualizandose.';
  // Solo nuevos (sin sufijo de grado al final)
  const nuevos = stockData.filter(i => i.qty > 0 && !/\s[-–]\s*(GA\+?-?|GAB|GB|IND)$/i.test(i.desc));
  // Agrupar por modelo base (sin color)
  const grupos = {};
  for (const item of nuevos) {
    const base = item.desc.replace(/\s+(BLACK|BLUE|PINK|WHITE|GREEN|YELLOW|RED|PURPLE|SILVER|GOLD|STARLIGHT|MIDNIGHT|NATURAL|DESERT|TEAL|CREAM|SAND|STORM|TITANIUM|ULTRAMARINE|BURGUNDY|GRAPHITE)(\s.*)?$/i, '').trim();
    if (!grupos[base]) grupos[base] = 0;
    grupos[base] += item.qty;
  }
  const lines = ['STOCK NUEVOS SIN ACTIVAR:'];
  for (const [desc, qty] of Object.entries(grupos)) lines.push('  ' + desc + ': ' + qty + 'u');
  const totalRefu = stockData.filter(i => i.qty > 0 && /\s[-–]\s*(GA\+?-?|GAB|GB)$/i.test(i.desc)).reduce((s,i) => s+i.qty, 0);
  if (totalRefu > 0) lines.push('REFU/USADOS: ' + totalRefu + 'u disponibles (precios a consultar)');
  return lines.join('\n');
}

// SYSTEM PROMPT
function buildPrompt() {
  return `Sos Sophia, agente comercial de South Traders — distribuidor OFICIAL de Apple en Miami, Florida.

PERSONALIDAD:
- Mujer profesional, segura, con carisma y una chispa de seduccion sutil
- Encantadora pero sin pasarte. Calidez genuina, nunca robotica.
- Haces sentir al cliente especial. Cuando hace un buen pedido, se lo reconocés.

EMPRESA:
- Distribuidor OFICIAL Apple. iPhones nuevos, sin activar, directo de Apple.
- También Samsung y MacBooks. Mayorista para LATAM, Caribe y el mundo.
- Minimo: 5 unidades por modelo
- Pagos: Wire transfer, Zelle, crypto
- Horario: Lun-Vie 9am-6pm ET
- Tel: +1 786 909 0198 | info@southtraders.com
- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172

LOGISTICA:
- FOB Miami (el cliente coordina el flete)
- Delivery GRATIS en Doral para ordenes +$30,000 USD
- Pickup en warehouse disponible

PRODUCTOS:
- NUEVOS SIN ACTIVAR: articulos SIN sufijo de grado. Son oficiales Apple, caja sellada.
- USADOS/REFU: articulos con sufijo GA, GA-, GAB, GB al final. Precios a consultar.
- Si preguntan por stock, compartiles el portal: https://south-traders.pangea.ar/n6/stock_disp#

PRECIOS NUEVOS (USD, min 5u):
iPhone Air 256GB $850 | 17e $545 | 17 256GB $780
iPhone 17 Pro: 256GB $1050 | 512GB $1160 | 1TB $1300
iPhone 17 Pro Max: 256GB $1150 | 512GB $1260 | 1TB $1420
iPhone 16 128GB $640 | 16 Pro 128GB $850 | 256GB $960
iPhone 15 128GB $530 | 15 Pro 128GB $720
Samsung S25 Ultra 512GB $1070 | S26 Ultra 512GB $1170
MacBook Air 13 M5 $1060 | 15 M4 $1200
AirPods 4 $145 | AirPods Pro 3 $210

ESTILO:
- Mismo idioma que el cliente (espanol o ingles)
- Respuestas concisas y directas, con calidez
- Para cerrar pedido pedi: modelo, cantidad, pais destino, datos de contacto
- Pedidos grandes: invitalos a llamar al +1 786 909 0198

` + getStockSummary();
}

// CLAUDE
async function askClaude(phone, userText) {
  await saveMessage(phone, 'user', userText);
  const history = await loadConversation(phone);
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 1024, system: buildPrompt(), messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const text = resp.data?.content?.[0]?.text;
    if (!text) { console.error('Claude empty:', JSON.stringify(resp.data?.usage)); return null; }
    await saveMessage(phone, 'assistant', text);
    return text;
  } catch(e) {
    console.error('Claude error:', e.response?.data || e.message);
    return null;
  }
}

// WHATSAPP
async function sendWA(to, text) {
  await axios.post(
    'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function handleMessage(phone, text) {
  console.log('[IN] ' + phone + ': ' + text);
  await upsertContact(phone);
  const history = await loadConversation(phone);
  if (history.length === 0) {
    sendWA(OWNER_PHONE, '🔔 Nuevo mensaje\nDe: +' + phone + '\n"' + text.slice(0,80) + '"').catch(()=>{});
  }
  const reply = await askClaude(phone, text);
  if (!reply) {
    await sendWA(phone, 'Disculpa la demora! Escribinos al +1 786 909 0198 y te atendemos enseguida 😊');
    return;
  }
  await sendWA(phone, reply);
  console.log('[OUT] ' + phone + ': ' + reply.slice(0,80));
}

// WEBHOOK
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!msgs?.length) return;
  const m = msgs[0];
  if (m.type === 'text') handleMessage(m.from, m.text?.body || '').catch(console.error);
});

// CONVERSACIONES
app.get('/conversations', async (req, res) => {
  try {
    const r = await pool.query('SELECT phone, role, content, ts FROM conversations ORDER BY phone, ts ASC');
    const grouped = {};
    for (const row of r.rows) {
      if (!grouped[row.phone]) grouped[row.phone] = { messages: [] };
      grouped[row.phone].messages.push({ role: row.role, content: row.content, ts: row.ts });
    }
    res.json({ ok: true, conversations: grouped, total: Object.keys(grouped).length });
  } catch(e) { res.json({ ok: true, conversations: {}, total: 0 }); }
});

// CRM
app.get('/crm/contacts', async (req, res) => {
  try {
    const r = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM conversations WHERE phone=c.phone) as msg_count FROM crm_contacts c ORDER BY last_contact DESC');
    res.json({ ok: true, contacts: r.rows, total: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/crm/contacts', async (req, res) => {
  const { phone, name, country, company, interest, tier, status, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await pool.query(
      `INSERT INTO crm_contacts (phone,name,country,company,interest,tier,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (phone) DO UPDATE SET name=COALESCE($2,crm_contacts.name), country=COALESCE($3,crm_contacts.country),
       company=COALESCE($4,crm_contacts.company), interest=COALESCE($5,crm_contacts.interest),
       tier=COALESCE($6,crm_contacts.tier), status=COALESCE($7,crm_contacts.status),
       notes=COALESCE($8,crm_contacts.notes), last_contact=NOW() RETURNING *`,
      [phone, name, country, company, interest, tier||'lead', status||'new', notes]
    );
    res.json({ ok: true, contact: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// OUTBOUND
app.post('/outbound/campaign', async (req, res) => {
  const { name, message, phones } = req.body;
  if (!name || !message || !phones?.length) return res.status(400).json({ error: 'name, message, phones[] requeridos' });
  try {
    const c = await pool.query('INSERT INTO outbound_campaigns (name,message) VALUES ($1,$2) RETURNING *', [name, message]);
    const campId = c.rows[0].id;
    for (const p of phones) await pool.query('INSERT INTO outbound_logs (campaign_id,phone) VALUES ($1,$2)', [campId, p]);
    res.json({ ok: true, campaign_id: campId, total: phones.length });
    runCampaign(campId, message, phones);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function runCampaign(campId, message, phones) {
  let sent = 0, failed = 0;
  for (const phone of phones) {
    await new Promise(r => setTimeout(r, 1200));
    try {
      await sendWA(phone, message);
      await upsertContact(phone);
      sent++;
    } catch(e) { failed++; }
  }
  await pool.query('UPDATE outbound_campaigns SET status=$1,total_sent=$2,total_failed=$3 WHERE id=$4', ['done', sent, failed, campId]);
  console.log('Campaign ' + campId + ': ' + sent + ' sent, ' + failed + ' failed');
}

app.get('/outbound/campaigns', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM outbound_campaigns ORDER BY created_at DESC'); res.json({ ok: true, campaigns: r.rows }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// LEGAL
app.get('/privacy', (req, res) => res.send('<h1>Privacy Policy</h1><p>South Traders Bot collects phone numbers and messages to provide wholesale sales assistance. Data is never sold. Contact: info@southtraders.com</p>'));
app.get('/terms', (req, res) => res.send('<h1>Terms of Service</h1><p>By messaging this bot you agree to receive wholesale electronics information. Min order 5 units. Contact: info@southtraders.com</p>'));

// HEALTH
app.get('/', (req, res) => res.json({ status: 'ok', stock: { items: stockData.length, updated: stockLastUpdated } }));

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sophia Dashboard - South Traders</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,sans-serif}
body{background:#f5f5f5;color:#111;padding:16px}
h1{font-size:18px;font-weight:600;margin-bottom:16px;color:#111}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.stat{background:#fff;border-radius:10px;padding:12px;border:1px solid #e5e5e5}
.stat-lbl{font-size:11px;color:#888;margin-bottom:4px}
.stat-val{font-size:22px;font-weight:600}
.layout{display:grid;grid-template-columns:220px 1fr;gap:10px}
.sidebar{background:#fff;border-radius:10px;border:1px solid #e5e5e5;overflow-y:auto;max-height:500px}
.sidebar-hdr{padding:8px 12px;font-size:11px;color:#888;border-bottom:1px solid #eee;text-transform:uppercase;letter-spacing:.05em;background:#fafafa}
.contact{padding:10px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0}
.contact:hover{background:#f5f5f5}
.contact.active{background:#e8f0fe}
.contact-phone{font-size:13px;font-weight:600;margin-bottom:2px}
.contact-preview{font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.contact-time{font-size:10px;color:#bbb;margin-top:2px}
.chat{background:#fff;border-radius:10px;border:1px solid #e5e5e5;display:flex;flex-direction:column}
.chat-hdr{padding:10px 14px;border-bottom:1px solid #eee;font-size:13px;font-weight:600;background:#fafafa;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center}
.chat-body{overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:350px;max-height:450px}
.msg-wrap{display:flex;flex-direction:column}
.msg-wrap.user{align-items:flex-end}
.msg-wrap.assistant{align-items:flex-start}
.msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.msg.user{background:#e8f0fe;color:#1a56c4;border-bottom-right-radius:3px}
.msg.assistant{background:#f0f0f0;color:#111;border-bottom-left-radius:3px}
.msg-time{font-size:10px;color:#bbb;margin-top:2px;padding:0 2px}
.empty{display:flex;align-items:center;justify-content:center;height:200px;color:#bbb;font-size:13px}
.badge{display:inline-block;font-size:11px;padding:3px 8px;border-radius:10px;background:#d1fae5;color:#065f46;font-weight:500}
.badge.off{background:#fee2e2;color:#991b1b}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.refresh-btn{font-size:12px;padding:5px 12px;border:1px solid #ddd;border-radius:6px;cursor:pointer;background:#fff}
.clear-btn{font-size:11px;padding:3px 8px;border:1px solid #fca5a5;border-radius:5px;cursor:pointer;background:#fff;color:#dc2626}
@media(max-width:600px){.layout{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="hdr">
  <h1>Sophia — South Traders</h1>
  <div style="display:flex;gap:8px;align-items:center">
    <span id="badge" class="badge off">conectando...</span>
    <button class="refresh-btn" onclick="load()">Actualizar</button>
  </div>
</div>
<div class="stats">
  <div class="stat"><div class="stat-lbl">Conversaciones</div><div class="stat-val" id="s-total">—</div></div>
  <div class="stat"><div class="stat-lbl">Mensajes totales</div><div class="stat-val" id="s-msgs">—</div></div>
  <div class="stat"><div class="stat-lbl">Actualizado</div><div class="stat-val" style="font-size:13px;padding-top:5px" id="s-time">—</div></div>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-hdr">Contactos</div>
    <div id="contacts"></div>
  </div>
  <div class="chat">
    <div class="chat-hdr">
      <span id="chat-title">Seleccioná un contacto</span>
      <button class="clear-btn" id="clear-btn" style="display:none" onclick="clearHistory()">Borrar historial</button>
    </div>
    <div class="chat-body" id="chat-body"><div class="empty">Elegí un contacto</div></div>
  </div>
</div>
<script>
const BOT='';
let convs={},selected=null;
function fmt(p){if(p.startsWith('549'))return'+54 9 '+p.slice(3,5)+' '+p.slice(5,9)+'-'+p.slice(9);if(p.startsWith('1')&&p.length===11)return'+1 ('+p.slice(1,4)+') '+p.slice(4,7)+'-'+p.slice(7);return'+'+p;}
function ft(ts){if(!ts)return'';try{return new Date(ts).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});}catch(e){return'';}}
function fd(ts){if(!ts)return'';try{const d=new Date(ts);return d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});}catch(e){return'';}}
function renderContacts(){const phones=Object.keys(convs).sort((a,b)=>{const al=convs[a].messages?.slice(-1)[0]?.ts||'';const bl=convs[b].messages?.slice(-1)[0]?.ts||'';return bl.localeCompare(al);});const el=document.getElementById('contacts');if(!phones.length){el.innerHTML='<div class="empty" style="height:80px;font-size:12px">Sin conversaciones</div>';return;}el.innerHTML=phones.map(p=>{const msgs=convs[p].messages||[];const last=msgs[msgs.length-1];const preview=last?last.content.slice(0,40)+'...':'';return `<div class="contact ${p===selected?'active':''}" onclick="selectContact('${p}')"><div class="contact-phone">${fmt(p)}</div><div class="contact-preview">${preview}</div><div class="contact-time">${msgs.length} msgs · ${last?fd(last.ts):''}</div></div>`;}).join('');}
function selectContact(phone){selected=phone;renderContacts();const msgs=(convs[phone]&&convs[phone].messages)||[];document.getElementById('chat-title').textContent=fmt(phone)+' — '+msgs.length+' mensajes';document.getElementById('clear-btn').style.display='block';const body=document.getElementById('chat-body');if(!msgs.length){body.innerHTML='<div class="empty">Sin mensajes</div>';return;}body.innerHTML=msgs.map(m=>`<div class="msg-wrap ${m.role}"><div class="msg ${m.role}">${m.content.replace(/</g,'&lt;')}</div><div class="msg-time">${m.role==='assistant'?'Sophia · ':''}${ft(m.ts)}</div></div>`).join('');body.scrollTop=body.scrollHeight;}
async function clearHistory(){if(!selected)return;if(!confirm('¿Borrar historial de '+fmt(selected)+'?'))return;try{await fetch(BOT+'/conversations/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selected})});await load();document.getElementById('chat-body').innerHTML='<div class="empty">Historial borrado</div>';}catch(e){alert('Error al borrar');}}
async function load(){const badge=document.getElementById('badge');try{const r=await fetch(BOT+'/conversations');const data=await r.json();convs=data.conversations||{};const phones=Object.keys(convs);const totalMsgs=phones.reduce((s,p)=>s+(convs[p].messages||[]).length,0);document.getElementById('s-total').textContent=phones.length;document.getElementById('s-msgs').textContent=totalMsgs;document.getElementById('s-time').textContent=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});badge.textContent='en vivo';badge.className='badge';renderContacts();if(selected&&convs[selected])selectContact(selected);else if(phones.length&&!selected)selectContact(phones[0]);}catch(e){badge.textContent='sin conexión';badge.className='badge off';}}
load();setInterval(load,10000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log('Sophia online port ' + PORT))).catch(console.error);
