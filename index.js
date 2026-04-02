const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PANGEA_URL = 'https://south-traders.pangea.ar/n6/stock_disp';

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
    console.log('Actualizando stock desde Pangea...');
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
  if (stockData.length === 0) return 'Stock cargando, disponible en 1 minuto.';
  const date = stockLastUpdated ? stockLastUpdated.toLocaleDateString('es-AR') : '';
  const available = stockData.filter(i => i.qty > 0 || i.transit > 0);
  const lines = ['STOCK DISPONIBLE AL ' + date + ':'];
  for (const item of available) {
    const t = item.transit > 0 ? ' (+' + item.transit + ' transito)' : '';
    lines.push(item.desc + ' | ' + item.condition + ' | ' + item.qty + ' u' + t);
  }
  return lines.join('\n');
}

function buildSystemPrompt() {
  const stockCtx = buildStockContext();
  return 'Sos un agente comercial de South Traders, mayorista de electronica con sede en Miami, Florida. Tu nombre es Alex.\n\n' +
    'SOBRE SOUTH TRADERS:\n' +
    '- Mayorista de electronica Apple y Samsung para clientes en Latinoamerica, El Caribe y el mundo\n' +
    '- Minimo de compra: 5 unidades por modelo\n' +
    '- Pagos: Wire transfer, Zelle, crypto\n' +
    '- Envio desde Miami, coordinamos logistica con el cliente\n' +
    '- Horario: Lunes a Viernes 9am-6pm ET\n' +
    '- Numero: +1 786 909 0198 | Email: info@southtraders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'CONDICIONES DEL PRODUCTO:\n' +
    '- GA / GA+: Como nuevo, sin uso o caja abierta de alta calidad\n' +
    '- GA-: Grado A menos, leves marcas, funciona perfecto\n' +
    '- GAB: Entre A y B, puede tener marcas visibles\n' +
    '- GB: Grado B, marcas notorias pero funcional\n' +
    '- IND / SIM CARD: Nuevo de India, trae SIM Card incluida\n' +
    '- USA ESIM / JP ESIM / BES: Nuevo con eSIM de ese pais\n\n' +
    'TU ESTILO:\n' +
    '- Hablás como un vendedor profesional y cercano, no como un bot\n' +
    '- Respondés en el mismo idioma que el cliente (espanol o ingles)\n' +
    '- Sos directo: si hay stock lo decis, si no hay lo decis y ofrecés alternativas\n' +
    '- Nunca inventas precios ni stock que no este en el contexto\n' +
    '- Si el cliente quiere hacer un pedido, pedi: modelo, cantidad, pais de destino y datos de contacto\n' +
    '- Usas emojis con moderacion, no en cada oracion\n' +
    '- No sos verbose: respondés lo necesario, claro y concreto\n' +
    '- Para pedidos grandes o negociaciones, invitas a llamar directo al +1 786 909 0198\n\n' +
    'PRECIOS SOUTH TRADERS (USD, minimo 5 unidades):\n' +
    'iPhone Air 256GB: $850 | iPhone 17e 256GB: $545 | iPhone 17 256GB: $780\n' +
    'iPhone 17 Pro 256GB: $1,050 | iPhone 17 Pro 512GB: $1,160 | iPhone 17 Pro 1TB: $1,300\n' +
    'iPhone 17 Pro Max 256GB: $1,150 | iPhone 17 Pro Max 512GB: $1,260 | iPhone 17 Pro Max 1TB: $1,420\n' +
    'iPhone 16 128GB: $640 | iPhone 16 Pro 128GB: $850 | iPhone 16 Pro 256GB: $960\n' +
    'iPhone 15 128GB: $530 | iPhone 15 Pro 128GB: $720\n' +
    'Samsung S25 Ultra 512GB: $1,070 | Samsung S26 Ultra 512GB: $1,170\n' +
    'MacBook Air 13 M5 512GB: $1,060 | MacBook Air 15 M4: $1,200\n' +
    'AirPods 4: $145 | AirPods Pro 3: $210 | Apple Watch Ultra 3: consultar\n\n' +
    stockCtx;
}

const conversations = {};
const MAX_HISTORY = 10;

function getConversation(from) {
  if (!conversations[from]) conversations[from] = [];
  return conversations[from];
}

function addMessage(from, role, content) {
  const conv = getConversation(from);
  conv.push({ role, content });
  if (conv.length > MAX_HISTORY * 2) conv.splice(0, 2);
}

async function askClaude(from, userMessage) {
  addMessage(from, 'user', userMessage);
  const history = getConversation(from);
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        system: buildSystemPrompt(),
        messages: history,
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );
    const reply = response.data.content[0].text;
    addMessage(from, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('Claude API error:', err.response?.data || err.message);
    return 'Disculpa, tuve un problema tecnico. Escribinos directo al +1 786 909 0198.';
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
  }
}

async function handleMessage(from, text) {
  console.log('[MSG] ' + from + ': ' + text);
  const reply = await askClaude(from, text);
  await sendMessage(from, reply);
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!msgs?.length) return;
  const m = msgs[0];
  if (m.type === 'text') await handleMessage(m.from, m.text?.body || '');
});

app.post('/update-stock', (req, res) => {
  const { rows } = req.body;
  if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  stockData = rows.filter(r => r[0]).map(r => ({
    mfr: r[0], desc: r[1]||'', qty: Number(r[2])||0, transit: Number(r[3])||0, condition: extractCondition(r[1]||'')
  }));
  stockLastUpdated = new Date();
  res.json({ ok: true, items: stockData.length, updated: stockLastUpdated });
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  stock: { loaded: stockData.length > 0, items: stockData.length, lastUpdated: stockLastUpdated }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('South Traders WhatsApp Bot running on port ' + PORT));
