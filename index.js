const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PANGEA_URL = 'https://south-traders.pangea.ar/n6/stock_disp';

let stockData = [];
let stockLastUpdated = null;

const CONDITION_LABELS = {
  'GA+':      { emoji: 'S+', label: 'GA+' },
  'GA':       { emoji: 'ok', label: 'GA' },
  'GA-':      { emoji: 'A-', label: 'GA-' },
  'GAB':      { emoji: 'AB', label: 'GAB' },
  'GB':       { emoji: 'B ', label: 'GB' },
  'IND':      { emoji: 'IN', label: 'IND' },
  'USA ESIM': { emoji: 'US', label: 'USA eSIM' },
  'JP ESIM':  { emoji: 'JP', label: 'JP eSIM' },
  'BES':      { emoji: 'BE', label: 'BES' },
};

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

function parseStockFromRows(rows) {
  return rows
    .filter(r => r[0] && r[0] !== 'MFR')
    .map(r => ({
      mfr: String(r[0]).trim(),
      desc: String(r[1] || '').trim(),
      qty: Number(r[2]) || 0,
      transit: Number(r[3]) || 0,
      condition: extractCondition(String(r[1] || '')),
    }));
}

// Parsear HTML de Pangea sin jsdom - regex sobre las celdas <td>
function parseStockFromHTML(html) {
  const rows = [];
  const trRegex = /<tr[^>]*>([sS]*?)</tr>/gi;
  const tdRegex = /<td[^>]*>([sS]*?)</td>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [];
    let tdMatch;
    const tdRe = /<td[^>]*>([sS]*?)</td>/gi;
    while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 3 && cells[0] && cells[1]) {
      rows.push([cells[0], cells[1], parseInt(cells[2]) || 0, parseInt(cells[3]) || 0]);
    }
  }
  return rows;
}

async function fetchStockFromPangea() {
  try {
    console.log('Actualizando stock desde Pangea...');
    const resp = await axios.get(PANGEA_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SouthTradersBot/1.0)' }
    });
    const rows = parseStockFromHTML(resp.data);
    if (rows.length > 0) {
      stockData = parseStockFromRows(rows);
      stockLastUpdated = new Date();
      console.log('Stock OK: ' + stockData.length + ' items de Pangea');
    } else {
      console.log('Pangea: 0 filas parseadas');
    }
  } catch (err) {
    console.error('Error Pangea:', err.message);
  }
}

fetchStockFromPangea();
setInterval(fetchStockFromPangea, 6 * 60 * 60 * 1000);

function searchStock(query) {
  if (stockData.length === 0) return null;
  const q = query.toUpperCase();
  const modelMap = [
    ['IPHONE 17 PRO MAX'],['IPHONE 17 PRO'],['IPHONE 17'],
    ['IPHONE 16 PRO MAX'],['IPHONE 16 PRO'],['IPHONE 16'],
    ['IPHONE 15 PRO MAX'],['IPHONE 15 PRO'],['IPHONE 15'],
    ['IPHONE 14'],['IPHONE 13'],['S26 ULTRA'],['S25 ULTRA'],
    ['SAMSUNG','GALAXY'],['MACBOOK'],['AIRPODS PRO'],['AIRPODS'],
    ['IPAD'],['APPLE WATCH','WATCH ULTRA'],
  ];
  let matched = [];
  for (const kws of modelMap) {
    if (kws.some(k => q.includes(k))) {
      matched = stockData.filter(i => kws.some(k => i.desc.toUpperCase().includes(k)));
      break;
    }
  }
  if (!matched.length) {
    const words = q.split(/\s+/).filter(w => w.length > 2);
    matched = stockData.filter(i => words.some(w => i.desc.toUpperCase().includes(w)));
  }
  const sm = q.match(/(\d{2,4})\s*GB/);
  if (sm) { const f = matched.filter(i => i.desc.toUpperCase().includes(sm[1]+'GB')); if(f.length) matched=f; }
  for (const c of ['BLACK','WHITE','BLUE','SILVER','NATURAL','DESERT','MIDNIGHT','PURPLE','RED','PINK','TEAL','YELLOW','ULTRAMARINE','ORANGE','VIOLET','GRAY','STARLIGHT']) {
    if (q.includes(c)) { const f = matched.filter(i => i.desc.toUpperCase().includes(c)); if(f.length) matched=f; }
  }
  return matched;
}

function formatStockResponse(items) {
  if (items === null) return 'El stock se esta cargando, intenta en 1 minuto.';
  const av = items.filter(i => i.qty > 0 || i.transit > 0);
  if (!av.length) return 'Sin stock para ese modelo ahora. Dejame tu contacto y te aviso cuando entre.';
  const date = stockLastUpdated ? stockLastUpdated.toLocaleDateString('es-AR') : '';
  const lines = ['*STOCK DISPONIBLE*\n'];
  for (const item of av.slice(0,12)) {
    const cond = CONDITION_LABELS[item.condition] || { label: item.condition };
    const t = item.transit > 0 ? ' (+'+item.transit+' transito)' : '';
    lines.push('*'+item.desc+'*');
    lines.push('  '+cond.label+' - '+(item.qty||0)+' u'+t+'\n');
  }
  if (av.length > 12) lines.push('...'+(av.length-12)+' variantes mas. Especifica modelo/color.');
  lines.push('Stock al '+date);
  return lines.join('\n');
}

const PRICE_LIST = 'LISTA SOUTH TRADERS\n\niPhone Air 256GB: $850\niPhone 17e: $545\niPhone 17 256GB: $780\niPhone 17 Pro 256GB: $1,050\niPhone 17 Pro Max 256GB: $1,150\niPhone 17 Pro Max 512GB: $1,260\niPhone 17 Pro Max 1TB: $1,420\n\niPhone 16 128GB: $640\niPhone 16 Pro 128GB: $850\niPhone 16 Pro 256GB: $960\n\niPhone 15 128GB: $530\niPhone 15 Pro 128GB: $720\n\nSamsung S25 Ultra 512GB: $1,070\nSamsung S26 Ultra 512GB: $1,170\n\nMacBook Air M5 13": $1,060\n\nAirPods 4: $145 | AirPods Pro 3: $210\n\nPrecios USD - Minimo 5 unidades';

const MENU = 'SOUTH TRADERS - Mayorista electronica Miami\n\n1 - Precios\n2 - Stock\n3 - Modelos\n4 - Como comprar\n5 - Ubicacion\n6 - Contacto\n\nO preguntame directamente por cualquier modelo.';

async function sendMessage(to, text) {
  try {
    await axios.post('https://graph.facebook.com/v19.0/'+PHONE_NUMBER_ID+'/messages',
      { messaging_product:'whatsapp', to, type:'text', text:{body:text} },
      { headers:{ Authorization:'Bearer '+WHATSAPP_TOKEN, 'Content-Type':'application/json' } }
    );
  } catch(e) { console.error('Send error:', e.response?.data||e.message); }
}

async function handleMessage(from, text) {
  const msg = text.trim().toLowerCase();
  const greetings = ['hola','hello','hi','hey','buenos dias','buenas','good morning','start','inicio','menu'];
  if (greetings.some(g => msg === g || msg.startsWith(g+' '))) { await sendMessage(from, MENU); return; }
  if (msg==='1'||msg.includes('precio')||msg.includes('price')||msg.includes('lista')) { await sendMessage(from, PRICE_LIST); return; }
  if (msg==='2'||msg==='stock'||msg==='disponible') { await sendMessage(from, 'Que modelo buscas?\n\nEjemplos:\n- iphone 17 pro max\n- samsung s26 ultra\n- macbook m5'); return; }
  const stockKw = ['iphone','samsung','galaxy','macbook','airpods','ipad','apple watch','s26','s25'];
  if (stockKw.some(k => msg.includes(k))) { await sendMessage(from, formatStockResponse(searchStock(msg))); return; }
  if (msg==='3'||msg.includes('modelo')||msg.includes('spec')) { await sendMessage(from, 'iPhone 13/14/15/16/17 - Samsung S25/S26 Ultra - MacBook Air M5 - AirPods 4/Pro 3 - iPad - Apple Watch Ultra 3'); return; }
  if (msg==='4'||msg.includes('comprar')||msg.includes('minimo')) { await sendMessage(from, 'Minimo 5 unidades por modelo\nPago: Wire / Zelle / Crypto\nEnvio desde Miami\n\nDecime modelo, cantidad y destino.'); return; }
  if (msg==='5'||msg.includes('ubicacion')||msg.includes('address')) { await sendMessage(from, '10850 NW 21st St Suite 140\nMiami FL 33172\nLun-Vie 9am-6pm ET'); return; }
  if (msg==='6'||msg.includes('contacto')||msg.includes('hablar')) { await sendMessage(from, 'WhatsApp: +1 786 909 0198\nEmail: info@southtraders.com'); return; }
  await sendMessage(from, 'No entendi. Preguntame por un modelo o escribe menu.');
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!msgs?.length) return;
  const m = msgs[0];
  if (m.type==='text') { console.log('[MSG] '+m.from+': '+m.text?.body); await handleMessage(m.from, m.text?.body||''); }
});

app.post('/update-stock', (req, res) => {
  const { rows } = req.body;
  if (!rows||!Array.isArray(rows)) return res.status(400).json({error:'rows required'});
  stockData = parseStockFromRows(rows);
  stockLastUpdated = new Date();
  console.log('Stock manual: '+stockData.length+' items');
  res.json({ ok:true, items:stockData.length, updated:stockLastUpdated });
});

app.get('/', (req, res) => res.json({ status:'ok', stock:{ loaded:stockData.length>0, items:stockData.length, lastUpdated:stockLastUpdated } }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('South Traders WhatsApp Bot running on port '+PORT));
