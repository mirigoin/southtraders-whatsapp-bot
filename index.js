const express = require('express');
const path = require('path');
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

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS conversations (phone TEXT, role TEXT, content TEXT, ts TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS crm_contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, country TEXT, company TEXT, interest TEXT, tier TEXT DEFAULT \'tier1\', status TEXT DEFAULT \'new\', notes TEXT, last_contact TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS registered BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS logistics TEXT');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS pending_order BOOLEAN DEFAULT FALSE');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_campaigns (id SERIAL PRIMARY KEY, name TEXT, message TEXT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW(), total_sent INT DEFAULT 0, total_failed INT DEFAULT 0)');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_logs (id SERIAL PRIMARY KEY, campaign_id INT, phone TEXT, status TEXT DEFAULT \'pending\', sent_at TIMESTAMPTZ, error TEXT)');
  console.log('DB OK');
}

async function loadConversation(phone) {
  try {
    const r = await pool.query('SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts DESC LIMIT 10', [phone]);
    return r.rows.reverse();
  } catch(e) { return []; }
}

async function saveMessage(phone, role, content) {
  try { await pool.query('INSERT INTO conversations (phone, role, content) VALUES ($1,$2,$3)', [phone, role, content]); } catch(e) {}
}

function detectCountry(phone) {
  if (phone.startsWith('549') || phone.startsWith('54')) return 'Argentina';
  if (phone.startsWith('521') || phone.startsWith('52')) return 'Mexico';
  if (phone.startsWith('571') || phone.startsWith('57')) return 'Colombia';
  if (phone.startsWith('511') || phone.startsWith('51')) return 'Peru';
  if (phone.startsWith('593')) return 'Ecuador';
  if (phone.startsWith('56')) return 'Chile';
  if (phone.startsWith('598')) return 'Uruguay';
  if (phone.startsWith('595')) return 'Paraguay';
  if (phone.startsWith('591')) return 'Bolivia';
  if (phone.startsWith('507')) return 'Panama';
  if (phone.startsWith('1')) return 'EEUU/Canada';
  if (phone.startsWith('55')) return 'Brasil';
  if (phone.startsWith('58')) return 'Venezuela';
  return 'Otro';
}

async function upsertContact(phone) {
  try {
    const country = detectCountry(phone);
    await pool.query(
      'INSERT INTO crm_contacts (phone, country) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()',
      [phone, country]
    );
  } catch(e) {}
}

// STOCK
let stockData = [];
let stockLastUpdated = null;

async function fetchStock() {
  try {
    const resp = await axios.get('https://south-traders.pangea.ar/n6/stock_disp', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(resp.data)) !== null) {
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
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
  const nuevos = stockData.filter(function(i) { return i.qty > 0 && !/\s[-]\s*(GA\+?-?|GAB|GB|IND)$/i.test(i.desc); });
  const grupos = {};
  for (let i = 0; i < nuevos.length; i++) {
    const item = nuevos[i];
    const base = item.desc.replace(/\s+(BLACK|BLUE|PINK|WHITE|GREEN|YELLOW|RED|PURPLE|SILVER|GOLD|STARLIGHT|MIDNIGHT|NATURAL|DESERT|TEAL|CREAM|SAND|STORM|TITANIUM|ULTRAMARINE|BURGUNDY|GRAPHITE)(\s.*)?$/i,'').trim();
    if (!grupos[base]) grupos[base] = 0;
    grupos[base] += item.qty;
  }
  const lines = ['STOCK DISPONIBLE:'];
  const keys = Object.keys(grupos);
  for (let i = 0; i < keys.length; i++) lines.push('- ' + keys[i] + ': ' + grupos[keys[i]] + 'u');
  const totalRefu = stockData.filter(function(i) { return i.qty > 0 && /\s[-]\s*(GA\+?-?|GAB|GB)$/i.test(i.desc); }).reduce(function(s,i) { return s+i.qty; }, 0);
  if (totalRefu > 0) lines.push('REFU/USADOS: ' + totalRefu + 'u disponibles');
  lines.push('Ver stock completo: https://south-traders.pangea.ar/n6/stock_disp#');
  return lines.join('\n');
}


// VERIFICAR STOCK EN NORTHTRADERS
async function checkNorthtraders(product) {
  try {
    const resp = await axios.get('https://northtraders.oppen.io/report/shared?shared=fe0f1305-3a71-4b78-be99-e54e3396cbdd', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = resp.data;
    // Buscar filas que contengan el producto
    const lines = html.split('\n');
    const matches = [];
    const searchTerm = product.toLowerCase();
    for (const line of lines) {
      const clean = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.toLowerCase().includes(searchTerm) && clean.match(/\d+/)) {
        matches.push(clean.slice(0, 150));
      }
    }
    return matches.slice(0, 5).join('\n') || null;
  } catch(e) {
    console.error('Northtraders error:', e.message);
    return null;
  }
}

// --- Live prices from Google Sheets ---
const PRICES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQJnHEwjzr2DODFe50HiG4g1ARBm8kLRFkSj2mP7pI26ymYrN-5q-M4R9S_mhapc0Ip9jQt6ZT9vREd/pub?gid=0&single=true&output=csv';
let cachedPrices = null;
let lastPriceFetch = 0;

async function fetchPrices() {
  const now = Date.now();
  if (cachedPrices && now - lastPriceFetch < 5 * 60 * 1000) return cachedPrices;
  try {
    const resp = await fetch(PRICES_CSV_URL);
    const text = await resp.text();
    const lines = text.split('\n').filter(l => l.trim());
    const prices = [];
    for (const line of lines.slice(1)) {
      const cols = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
      const product = (cols[6] || '').replace(/"/g, '').trim();
      const price = (cols[7] || '').replace(/"/g, '').trim();
      if (product && price && price !== '/' && !product.startsWith('*')) {
        prices.push(product + ' ' + price);
      }
    }
    cachedPrices = prices;
    lastPriceFetch = now;
    console.log('Prices fetched:', prices.length, 'products');
    return prices;
  } catch (e) {
    console.error('Error fetching prices:', e);
    return cachedPrices || [];
  }
}

async function buildPrompt() {
  await fetchPrices();
  return 'Sos Sophia, agente comercial de South Traders, distribuidor oficial Apple en Miami.\n\n' +
    'PERSONALIDAD:\n' +
    '- Mujer profesional, segura, con carisma y calidez genuina. Nunca robotica.\n' +
    '- Haces sentir al cliente especial.\n\n' +
    'SALUDO INICIAL:\n' +
    '- Cuando alguien escribe por primera vez, saludÃ¡ EXACTAMENTE asi: Bienvenido/a a South Traders, distribuidor oficial Apple en Miami. Soy Sophia y estoy aqui para ayudarte.\n' +
    '- Nunca uses asteriscos para tu nombre ni el de la empresa.\n\n' +
    'SALUDO INICIAL (cuando alguien escribe por primera vez):\n' +
    'UsÃ¡ exactamente este formato: Bienvenido/a a South Traders, distribuidor oficial Apple en Miami. Soy Sophia y estoy aqui para ayudarte.\n\n' +
    'EMPRESA:\n' +
    '- Somos distribuidor oficial Apple. Tenemos iPhones, MacBooks, Samsung y accesorios.\n' +
    '- Mayoristas para LATAM, El Caribe y el mundo.\n' +
    '- Pago: Wire transfer in advance\n' +
    '- Horario: Lun-Vie 9am-6pm ET\n' +
    '- Contacto: +1 786 559 1119 | sales@south-traders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'LOGISTICA:\n' +
    '- FOB Miami (el cliente coordina el flete)\n' +
    '- Delivery GRATIS en Doral para ordenes mayores a $30,000 USD\n' +
    '- Pickup en warehouse disponible\n' +
    '- Pueden enviar a alguien a verificar mercaderia al warehouse si lo solicitan\n\n' +
    'PRODUCTOS:\n' +
    '- Articulos SIN sufijo de grado son nuevos. Solo aclararlo si preguntan.\n' +
    '- USADOS/REFU: sufijo GA, GA-, GAB, GB. Precios a consultar.\n' +
    '- Stock general: https://south-traders.pangea.ar/n6/stock_disp#\n' +
    '- Si preguntan por stock en general o quieren ver todo el stock, manda el link de Pangea.\n' +
    '- Si preguntan PUNTUALMENTE cuantas unidades hay de un modelo especifico (ej: cuantos iPhone 16 tienen), SIEMPRE verifica primero en Northtraders antes de responder. No inventes cantidades.\n' +
    '- Si el stock de Pangea no alcanza para el pedido, busca disponibilidad adicional en Northtraders.\n\n' +
    'PRECIOS USD (Lista Cash Tier 1, clientes nuevos):\n' +
    (cachedPrices ? cachedPrices.join('\n') : 'Precios no disponibles') + '\n\n' +
    'CREDITO:\n' +
    '- Sin credito para clientes nuevos.\n' +
    '- Luego de trabajar juntos pueden aplicar. Los precios a credito son distintos.\n\n' +
    'PROCESO DE COMPRA:\n' +
    '- Minimo 10 unidades (solo decirlo si preguntan)\n' +
    '- Entender que busca, dar precio, confirmar logistica (pickup / inspeccion / delivery)\n' +
    '- Armar proforma clara: productos, cantidades, precio unitario, total USD\n' +
    '  Condicion de pago: Wire transfer in advance | Terminos: FOB Miami\n' +
    '- Indicar que un agente del equipo confirmara la orden al +1 786 559 1119\n\n' +
    'ESTILO:\n' +
    '- Habla SIEMPRE en plural: tenemos, manejamos, trabajamos\n' +
    '- NO menciones nuevos/sin activar ni minimos salvo que pregunten\n' +
    '- Mismo idioma que el cliente (espanol o ingles)\n' +
    '- Conciso y directo, con calidez\n' +
    '- Si quieren hablar con alguien: +1 786 559 1119 | sales@south-traders.com\n\n' +
    getStockSummary();
}

async function askClaude(phone, userText) {
  await saveMessage(phone, 'user', userText);
  const history = await loadConversation(phone);
  const messages = history.map(function(m) { return { role: m.role, content: m.content }; });
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 1024, system: await buildPrompt(), messages: messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const text = resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text;
    if (!text) { console.error('Claude empty'); return null; }
    await saveMessage(phone, 'assistant', text);
    return text;
  } catch(e) {
    console.error('Claude error:', e.response && e.response.data || e.message);
    return null;
  }
}

async function sendWA(to, text) {
  await axios.post(
    'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } },
    { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function handleMessage(phone, text) {
  console.log('[IN] ' + phone + ': ' + text.slice(0, 80));
  await upsertContact(phone);

  // Audio
  if (text === '__AUDIO__') {
    await sendWA(phone, 'Hola! Recibi tu audio pero no puedo escucharlo \uD83C\uDFA7 \u00bfPodes escribirme tu consulta? Con gusto te ayudo \uD83D\uDE0A');
    return;
  }

  // Chequear si el contacto esta pausado
  try {
    const pauseCheck = await pool.query('SELECT paused FROM crm_contacts WHERE phone=$1', [phone]);
    if (pauseCheck.rows.length > 0 && pauseCheck.rows[0].paused) {
      console.log('[PAUSED] ' + phone);
      return;
    }
  } catch(e) {}

  const history = await loadConversation(phone);
  const isNew = history.length === 0;

  if (isNew) {
    // Primer mensaje: saludo fijo + notificacion a Chelo
    const greeting = 'Bienvenido/a a South Traders, distribuidor oficial Apple en Miami. Soy Sophia y estoy aqui para ayudarte \uD83D\uDE0A';
    await sendWA(phone, greeting);
    await saveMessage(phone, 'assistant', greeting);
    sendWA(OWNER_PHONE, '\uD83D\uDD14 Nuevo cliente\nDe: +' + phone + '\n"' + text.slice(0,80) + '"').catch(function(){});
    // Ahora procesar su mensaje inicial con Claude (sin el saludo en el historial aun)
  }

  // Detectar si es consulta puntual de stock
  let extraContext = '';
  const textLower = text.toLowerCase();
  const isStockQuery = (textLower.includes('cuantos') || textLower.includes('cuÃ¡ntos') || 
    textLower.includes('tienen') || textLower.includes('disponible') || 
    textLower.includes('stock') || textLower.includes('hay')) &&
    (textLower.includes('iphone') || textLower.includes('samsung') || 
     textLower.includes('macbook') || textLower.includes('ipad'));
  
  if (isStockQuery) {
    // Extraer el modelo del mensaje
    const models = ['iphone 17 pro max', 'iphone 17 pro', 'iphone 17', 'iphone 16 pro', 'iphone 16', 'iphone 15 pro', 'iphone 15', 's26 ultra', 's25 ultra', 'macbook air', 'macbook pro', 'ipad'];
    let searchModel = null;
    for (const m of models) {
      if (textLower.includes(m)) { searchModel = m; break; }
    }
    if (searchModel) {
      const ntData = await checkNorthtraders(searchModel);
      if (ntData) {
        extraContext = '\n\n[DATOS DE STOCK NORTHTRADERS para "' + searchModel + '"]:\n' + ntData + '\n[Usa estos datos para responder con precision sobre disponibilidad]';
      }
    }
  }

  const reply = await askClaude(phone, text + extraContext);
  if (!reply) {
    await sendWA(phone, 'Disculpa la demora! Escribinos al +1 786 559 1119 o a sales@south-traders.com y te atendemos enseguida');
    return;
  }
  await sendWA(phone, reply);
  console.log('[OUT] ' + phone + ': ' + reply.slice(0,80));

  // Notificar si hay proforma
  const isProforma = reply.toLowerCase().includes('proforma') || reply.toLowerCase().includes('wire transfer') || reply.toLowerCase().includes('total usd');
  if (isProforma && phone !== OWNER_PHONE) {
    sendWA(OWNER_PHONE, '\uD83D\uDCCB ORDEN PENDIENTE\nCliente: +' + phone + '\n' + reply.slice(0, 500)).catch(function(){});
  }
}

// WEBHOOK
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  const msgs = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value && req.body.entry[0].changes[0].value.messages;
  if (!msgs || !msgs.length) return;
  const m = msgs[0];
  if (m.type === 'text') handleMessage(m.from, m.text && m.text.body || '').catch(console.error);
  if (m.type === 'audio' || m.type === 'voice') handleMessage(m.from, '__AUDIO__').catch(console.error);
});

// SEND (Chelo escribe desde dashboard)
app.post('/send', async function(req, res) {
  const b = req.body;
  if (!b.phone || !b.message) return res.status(400).json({error: 'faltan datos'});
  try {
    await sendWA(b.phone, b.message);
    await saveMessage(b.phone, 'assistant', '[Chelo] ' + b.message);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// DASHBOARD
app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// CONVERSACIONES
app.get('/conversations', async function(req, res) {
  try {
    const r = await pool.query('SELECT phone, role, content, ts FROM conversations ORDER BY phone, ts ASC');
    const grouped = {};
    for (let i = 0; i < r.rows.length; i++) {
      const row = r.rows[i];
      if (!grouped[row.phone]) grouped[row.phone] = { messages: [] };
      grouped[row.phone].messages.push({ role: row.role, content: row.content, ts: row.ts });
    }
    res.json({ ok: true, conversations: grouped, total: Object.keys(grouped).length });
  } catch(e) { res.json({ ok: true, conversations: {}, total: 0 }); }
});

app.post('/conversations/clear', async function(req, res) {
  const phone = req.body && req.body.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await pool.query('DELETE FROM conversations WHERE phone=$1', [phone]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PAUSA
app.post('/crm/pause', async function(req, res) {
  const { phone, paused } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await pool.query('UPDATE crm_contacts SET paused=$1 WHERE phone=$2', [paused, phone]);
    res.json({ ok: true, phone, paused });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRM
app.get('/crm/contacts', async function(req, res) {
  try {
    const r = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM conversations WHERE phone=c.phone) as msg_count FROM crm_contacts c ORDER BY last_contact DESC');
    res.json({ ok: true, contacts: r.rows, total: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/crm/contacts', async function(req, res) {
  const b = req.body;
  if (!b.phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await pool.query(
      'INSERT INTO crm_contacts (phone,name,country,company,interest,tier,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (phone) DO UPDATE SET name=COALESCE($2,crm_contacts.name), country=COALESCE($3,crm_contacts.country), company=COALESCE($4,crm_contacts.company), interest=COALESCE($5,crm_contacts.interest), tier=COALESCE($6,crm_contacts.tier), status=COALESCE($7,crm_contacts.status), notes=COALESCE($8,crm_contacts.notes), last_contact=NOW() RETURNING *',
      [b.phone, b.name, b.country, b.company, b.interest, b.tier||'tier1', b.status||'new', b.notes]
    );
    res.json({ ok: true, contact: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// LEGAL
app.get('/privacy', function(req, res) { res.send('<h1>Privacy Policy</h1><p>South Traders Bot collects phone numbers and messages to provide wholesale sales assistance. Data is never sold. Contact: sales@south-traders.com</p>'); });
app.get('/terms', function(req, res) { res.send('<h1>Terms of Service</h1><p>By messaging this bot you agree to receive wholesale electronics information. Contact: sales@south-traders.com</p>'); });

// HEALTH
app.get('/', function(req, res) { res.json({ status: 'ok', stock: { items: stockData.length, updated: stockLastUpdated } }); });

const PORT = process.env.PORT || 3000;
initDB().then(function() { app.listen(PORT, function() { console.log('Sophia online port ' + PORT); }); }).catch(console.error);
