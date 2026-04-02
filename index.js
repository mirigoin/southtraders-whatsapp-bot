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
const PANGEA_URL = 'https://south-traders.pangea.ar/n6/stock_disp';
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        phone TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_contacts (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        country TEXT,
        company TEXT,
        interest TEXT,
        tier TEXT DEFAULT 'lead',
        status TEXT DEFAULT 'new',
        notes TEXT,
        last_contact TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_crm_phone ON crm_contacts(phone)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbound_campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        total_sent INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbound_logs (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES outbound_campaigns(id),
        phone TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        error TEXT
      )
    `);

    console.log('DB inicializada con CRM y outbound');
  } catch(e) {
    console.error('Error initDB:', e.message);
  }
}

async function upsertContact(phone) {
  try {
    await pool.query(`
      INSERT INTO crm_contacts (phone, last_contact)
      VALUES ($1, NOW())
      ON CONFLICT (phone) DO UPDATE SET last_contact = NOW()
    `, [phone]);
  } catch(e) {
    console.error('Error upsertContact:', e.message);
  }
}

async function updateContactStatus(phone, status) {
  try {
    await pool.query(
      'UPDATE crm_contacts SET status = $1, last_contact = NOW() WHERE phone = $2',
      [status, phone]
    );
  } catch(e) {}
}

async function loadConversation(phone) {
  try {
    const res = await pool.query(
      'SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts ASC LIMIT 20',
      [phone]
    );
    return res.rows;
  } catch(e) {
    console.error('Error loadConversation:', e.message);
    return [];
  }
}

async function saveMessage(phone, role, content) {
  try {
    await pool.query(
      'INSERT INTO conversations (phone, role, content) VALUES ($1, $2, $3)',
      [phone, role, content]
    );
  } catch(e) {
    console.error('Error saveMessage:', e.message);
  }
}

async function getAllConversations() {
  try {
    const res = await pool.query(
      'SELECT phone, role, content, ts FROM conversations ORDER BY phone, ts ASC'
    );
    const grouped = {};
    for (const row of res.rows) {
      if (!grouped[row.phone]) grouped[row.phone] = [];
      grouped[row.phone].push({ role: row.role, content: row.content, ts: row.ts });
    }
    return grouped;
  } catch(e) {
    return {};
  }
}

let stockData = [];
let stockLastUpdated = null;

function extractCondition(desc) {
  const d = desc.toUpperCase();
  if (d.includes('BES SIM'))                               return 'BES';
  if (d.includes('USA ESIM') || d.includes('USA - ESIM')) return 'USA ESIM';
  if (d.includes('JP ESIM')  || d.includes('JP- ESIM'))   return 'JP ESIM';
  if (d.includes('IND') && d.includes('SIM'))              return 'IND';
  if (d.includes('GA+'))                                   return 'GA+';
  if (d.includes('- GA-') || d.includes('-GA-'))           return 'GA-';
  if (d.includes('- GA')  || d.includes('-GA'))            return 'GA';
  if (d.includes('GAB'))                                   return 'GAB';
  if (d.includes('- GB')  || d.includes('-GB'))            return 'GB';
  return 'GA';
}

function parseStockFromHTML(html) {
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 3 && cells[0] && cells[1]) {
      rows.push({ mfr: cells[0], desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0, condition: extractCondition(cells[1]) });
    }
  }
  return rows;
}

async function fetchStockFromPangea() {
  try {
    const resp = await axios.get(PANGEA_URL, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = parseStockFromHTML(resp.data);
    if (rows.length > 0) {
      stockData = rows;
      stockLastUpdated = new Date();
      console.log('Stock OK: ' + stockData.length + ' items');
    }
  } catch (err) {
    console.error('Error Pangea:', err.message);
  }
}

fetchStockFromPangea();
setInterval(fetchStockFromPangea, 6 * 60 * 60 * 1000);

function buildStockContext() {
  if (stockData.length === 0) return 'Stock cargando.';
  const date = stockLastUpdated ? stockLastUpdated.toLocaleDateString('es-AR') : '';
  const available = stockData.filter(i => i.qty > 0 || i.transit > 0);
  const lines = ['STOCK AL ' + date + ':'];
  for (const item of available) {
    const t = item.transit > 0 ? ' (+' + item.transit + ' transito)' : '';
    lines.push(item.desc + ' | ' + item.condition + ' | ' + item.qty + ' u' + t);
  }
  return lines.join('\n');
}

function buildSystemPrompt() {
  return 'Sos un agente comercial de South Traders, mayorista de electronica en Miami, Florida. Tu nombre es Alex.\n\n' +
    'SOBRE SOUTH TRADERS:\n' +
    '- Mayorista Apple y Samsung para Latinoamerica, El Caribe y el mundo\n' +
    '- Minimo: 5 unidades por modelo\n' +
    '- Pagos: Wire transfer, Zelle, crypto\n' +
    '- Horario: Lun-Vie 9am-6pm ET | Tel: +1 786 909 0198 | info@southtraders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'LOGISTICA:\n' +
    '- Todos los envios son FOB Miami\n' +
    '- Delivery sin cargo en area Doral para ordenes mayores a $30,000 USD\n' +
    '- Pickup en warehouse disponible para cualquier orden\n' +
    '- No hacemos envios internacionales directos\n\n' +
    'CONDICIONES:\n' +
    '- GA/GA+: Como nuevo | GA-: Grado A menos | GAB: A/B | GB: Grado B\n' +
    '- IND/SIM CARD: Nuevo India | USA/JP/BES ESIM: Nuevo con eSIM\n\n' +
    'ESTILO:\n' +
    '- Vendedor profesional y cercano, NO un bot\n' +
    '- Mismo idioma que el cliente (espanol/ingles)\n' +
    '- Directo: si hay stock lo decis, si no hay ofrecés alternativas\n' +
    '- Para pedidos pedi: modelo, cantidad, pais destino, datos de contacto\n' +
    '- Emojis con moderacion. Respuestas concisas.\n' +
    '- Pedidos grandes: invita a llamar al +1 786 909 0198\n\n' +
    'PRECIOS (USD, min 5 u):\n' +
    'iPhone Air 256GB $850 | 17e $545 | 17 256GB $780\n' +
    'iPhone 17 Pro 256GB $1050 | 512GB $1160 | 1TB $1300\n' +
    'iPhone 17 Pro Max 256GB $1150 | 512GB $1260 | 1TB $1420\n' +
    'iPhone 16 128GB $640 | 16 Pro 128GB $850 | 256GB $960\n' +
    'iPhone 15 128GB $530 | 15 Pro 128GB $720\n' +
    'Samsung S25 Ultra 512GB $1070 | S26 Ultra 512GB $1170\n' +
    'MacBook Air 13 M5 $1060 | 15 M4 $1200\n' +
    'AirPods 4 $145 | AirPods Pro 3 $210\n\n' +
    buildStockContext();
}

async function askClaude(phone, userMessage) {
  await saveMessage(phone, 'user', userMessage);
  const history = await loadConversation(phone);
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 600, system: buildSystemPrompt(), messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    const reply = response.data.content[0].text;
    await saveMessage(phone, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('Claude error:', err.response?.data || err.message);
    return 'Disculpa, tuve un problema tecnico. Escribinos al +1 786 909 0198.';
  }
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
    throw err;
  }
}

async function notifyOwner(phone, text) {
  try {
    const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
    const formatted = phone.startsWith('549') ? '+54 9 ' + phone.slice(3) : '+' + phone;
    await sendMessage(OWNER_PHONE, '🔔 Nuevo cliente\nDe: ' + formatted + '\nDice: "' + preview + '"');
  } catch(e) {}
}

async function handleMessage(phone, text) {
  console.log('[MSG] ' + phone + ': ' + text);
  await upsertContact(phone);
  const history = await loadConversation(phone);
  if (history.length === 0) notifyOwner(phone, text);
  const reply = await askClaude(phone, text);
  await sendMessage(phone, reply);
  if (text.toLowerCase().includes('pedido') || text.toLowerCase().includes('order') || text.toLowerCase().includes('comprar')) {
    await updateContactStatus(phone, 'interested');
  }
}

// WEBHOOK
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!msgs?.length) return;
  const m = msgs[0];
  if (m.type === 'text') await handleMessage(m.from, m.text?.body || '');
});

// CRM ENDPOINTS
app.get('/crm/contacts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT c.*, (SELECT COUNT(*) FROM conversations WHERE phone = c.phone) as msg_count FROM crm_contacts c ORDER BY last_contact DESC'
    );
    res.json({ ok: true, contacts: result.rows, total: result.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/crm/contacts', async (req, res) => {
  const { phone, name, country, company, interest, tier, status, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const result = await pool.query(`
      INSERT INTO crm_contacts (phone, name, country, company, interest, tier, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (phone) DO UPDATE SET
        name=COALESCE($2,crm_contacts.name),
        country=COALESCE($3,crm_contacts.country),
        company=COALESCE($4,crm_contacts.company),
        interest=COALESCE($5,crm_contacts.interest),
        tier=COALESCE($6,crm_contacts.tier),
        status=COALESCE($7,crm_contacts.status),
        notes=COALESCE($8,crm_contacts.notes),
        last_contact=NOW()
      RETURNING *
    `, [phone, name, country, company, interest, tier||'lead', status||'new', notes]);
    res.json({ ok: true, contact: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/crm/contacts/:phone', async (req, res) => {
  const { phone } = req.params;
  const fields = req.body;
  const allowed = ['name','country','company','interest','tier','status','notes'];
  const updates = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      updates.push(k + '=$' + i);
      values.push(v);
      i++;
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  values.push(phone);
  try {
    const result = await pool.query(
      'UPDATE crm_contacts SET ' + updates.join(', ') + ', last_contact=NOW() WHERE phone=$' + i + ' RETURNING *',
      values
    );
    res.json({ ok: true, contact: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// OUTBOUND ENDPOINTS
app.post('/outbound/campaign', async (req, res) => {
  const { name, message, phones } = req.body;
  if (!name || !message || !phones?.length) {
    return res.status(400).json({ error: 'name, message y phones[] requeridos' });
  }
  try {
    const camp = await pool.query(
      'INSERT INTO outbound_campaigns (name, message) VALUES ($1,$2) RETURNING *',
      [name, message]
    );
    const campId = camp.rows[0].id;
    for (const phone of phones) {
      await pool.query(
        'INSERT INTO outbound_logs (campaign_id, phone) VALUES ($1,$2)',
        [campId, phone]
      );
    }
    res.json({ ok: true, campaign_id: campId, total: phones.length });
    sendCampaign(campId);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function sendCampaign(campId) {
  try {
    const logs = await pool.query(
      'SELECT * FROM outbound_logs WHERE campaign_id=$1 AND status=\'pending\'',
      [campId]
    );
    let sent = 0, failed = 0;
    for (const log of logs.rows) {
      await new Promise(r => setTimeout(r, 1200));
      try {
        await sendMessage(log.phone, (await pool.query('SELECT message FROM outbound_campaigns WHERE id=$1', [campId])).rows[0].message);
        await pool.query('UPDATE outbound_logs SET status=\'sent\', sent_at=NOW() WHERE id=$1', [log.id]);
        await upsertContact(log.phone);
        sent++;
      } catch(e) {
        await pool.query('UPDATE outbound_logs SET status=\'failed\', error=$1 WHERE id=$2', [e.message, log.id]);
        failed++;
      }
    }
    await pool.query(
      'UPDATE outbound_campaigns SET status=\'done\', sent_at=NOW(), total_sent=$1, total_failed=$2 WHERE id=$3',
      [sent, failed, campId]
    );
    console.log('Campaign ' + campId + ': ' + sent + ' sent, ' + failed + ' failed');
  } catch(e) {
    console.error('Campaign error:', e.message);
  }
}

app.get('/outbound/campaigns', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM outbound_campaigns ORDER BY created_at DESC');
    res.json({ ok: true, campaigns: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// CONVERSACIONES
app.get('/conversations', async (req, res) => {
  const convs = await getAllConversations();
  res.json({ ok: true, conversations: convs, total: Object.keys(convs).length });
});

// UPDATE STOCK MANUAL
app.post('/update-stock', (req, res) => {
  const { rows } = req.body;
  if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  stockData = rows.filter(r => r[0]).map(r => ({
    mfr: r[0], desc: r[1]||'', qty: Number(r[2])||0, transit: Number(r[3])||0, condition: extractCondition(r[1]||'')
  }));
  stockLastUpdated = new Date();
  res.json({ ok: true, items: stockData.length });
});

// PAGINAS LEGALES (requeridas por Meta)
app.get('/privacy', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>Privacy Policy - South Traders Bot</h1>
    <p>South Traders WhatsApp Bot collects and processes phone numbers and conversation messages solely for the purpose of providing wholesale electronics sales assistance.</p>
    <h2>Data we collect</h2>
    <ul><li>Phone number</li><li>Messages sent to our bot</li></ul>
    <h2>How we use data</h2>
    <p>Data is used exclusively to respond to wholesale inquiries and is never sold to third parties.</p>
    <h2>Contact</h2>
    <p>info@southtraders.com | +1 786 909 0198</p>
  </body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>Terms of Service - South Traders Bot</h1>
    <p>By messaging South Traders WhatsApp Bot you agree to receive wholesale electronics pricing and availability information.</p>
    <h2>Service</h2>
    <p>This bot provides automated responses about product availability and pricing for wholesale buyers only. Minimum order: 5 units per model.</p>
    <h2>Contact</h2>
    <p>info@southtraders.com | +1 786 909 0198</p>
  </body></html>`);
});

// HEALTH
app.get('/', (req, res) => res.json({
  status: 'ok',
  stock: { loaded: stockData.length > 0, items: stockData.length, lastUpdated: stockLastUpdated }
}));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('South Traders Bot running on port ' + PORT));
});
