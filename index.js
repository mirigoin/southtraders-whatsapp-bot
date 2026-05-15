const express = require('express');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();
const PDFDocument = require('pdfkit');
const setupDashboardRoutes = require('./dashboard-routes');

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONES = (process.env.OWNER_PHONES || '17865591119,5491167581084').split(',').map(function(p){ return p.trim(); });
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });
setupDashboardRoutes(app, pool);

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
      if (cells.length >= 3 && cells[0] && cells[1]) rows.push({ sku: cells[0], desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0 });
    }
    if (rows.length > 0) { stockData = rows; stockLastUpdated = new Date(); console.log('Stock OK: ' + rows.length); }
  } catch(e) { console.error('Stock error:', e.message); }
}

fetchStock();
setInterval(fetchStock, 5 * 60 * 1000); // refresh cada 5 minutos para mantener stock vivo

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


// VERIFICAR STOCK EN PANGEA (single source of truth)
// IMPORTANT: name kept as checkNorthtraders for backwards compat with the call site,
// but this now reads from the in-memory Pangea cache (stockData), not from Northtraders.
async function checkNorthtraders(product) {
  try {
    // Ensure cache is fresh: if older than 5 min or empty, refresh now
    const ageMs = stockLastUpdated ? (Date.now() - new Date(stockLastUpdated).getTime()) : Infinity;
    if (!stockData.length || ageMs > 5 * 60 * 1000) {
      await fetchStock();
    }
    if (!stockData.length) return null;

    const searchTerm = product.toLowerCase().trim();
    const matches = [];
    for (const item of stockData) {
      const desc = (item.desc || '').toLowerCase();
      const sku = (item.sku || '').toLowerCase();
      if (!desc.includes(searchTerm) && !sku.includes(searchTerm)) continue;
      // Filter false positives for "iphone 16" matching "iphone 16 pro" or "iphone 16e"
      if (searchTerm === 'iphone 16' && (desc.includes('iphone 16 pro') || desc.includes('iphone 16e'))) continue;
      if (searchTerm === 'iphone 16 pro' && desc.includes('iphone 16 pro max')) continue;
      if (searchTerm === 'iphone 17' && (desc.includes('iphone 17 pro') || desc.includes('iphone 17e'))) continue;
      if (searchTerm === 'iphone 17 pro' && desc.includes('iphone 17 pro max')) continue;
      if (searchTerm === 'iphone 15' && desc.includes('iphone 15 pro')) continue;
      // Format: "SKU | DESCRIPTION | stock=N | transit=M"
      matches.push(`${item.sku} | ${item.desc} | stock=${item.qty} | transit=${item.transit}`);
    }
    if (matches.length === 0) return null;
    // Return up to 50 matches (was 5/30 before) - we have full Pangea catalog cached locally, no cost in returning all
    return matches.slice(0, 50).join('\n');
  } catch(e) {
    console.error('checkNorthtraders error:', e.message);
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
    'TU ROL (CRITICO):\n' +
    '- Sos una asistente de PRE-VENTA con autoridad para informar precios y disponibilidad usando el STOCK CARGADO ABAJO. NO cerras ordenes formales (sales order). El vendedor hace eso.\n' +
    '- El stock cargado abajo (en bloques [DATOS DE STOCK PANGEA]) es la FUENTE DE VERDAD. Se actualiza automaticamente y refleja la disponibilidad real. Cuando el cliente pregunta "tenes X" o "cuanto cuesta Y", responde DIRECTO y con seguridad usando esos datos.\n' +
    '- LECTURA ESTRICTA DEL STOCK: cuando recibis un bloque [DATOS DE STOCK PANGEA] tenes que leer TODAS las filas con atencion. Cada fila es un SKU distinto con su descripcion completa, su disponibilidad y stock. Si el cliente pregunta por un SKU especifico (ej: "iPhone 16 128GB Teal IND") y EXISTE una fila con ese SKU + cantidad > 0, AFIRMA que lo tenes. NUNCA digas "no lo tenemos" si la fila esta en los datos. Mira la fila completa, no solo el principio.\n' +
    '- NO digas "dame un minuto", "dejame verificar", "te confirmo en un rato", "estoy chequeando con el sistema" cuando la respuesta esta en el stock cargado. Eso te hace ver insegura y enfria al cliente. Responde directo: "Si, tenemos X unidades a USD Y por unidad" o "En este momento no tenemos disponibilidad de ese modelo, pero tenemos [alternativa]".\n' +
    '- Tu trabajo: responder con seguridad sobre productos, precios y disponibilidad usando el stock cargado, entender la intencion del cliente, armar un RESUMEN DE INTERES cuando hay cantidad concreta, y derivar al vendedor para confirmacion final del sales order.\n' +
    '- PROHIBIDO:\n' +
    '  * Decir "tenemos en [color/capacidad/region]" si NO esta en el stock cargado abajo. (Si no esta cargado, decir con seguridad: "ese modelo en este momento no lo tenemos disponible").\n' +
    '  * Decir "no tenemos en [color/capacidad/region]" si SI esta en el stock cargado. Eso es peor que decir "no se" porque le hace perder una venta al cliente. Mira las filas COMPLETAS antes de afirmar que algo no existe.\n' +
    '  * Inventar disponibilidad o cantidades. Solo lo que esta en el stock cargado.\n' +
    '  * Confirmar una orden ("perfecto, listo, confirmado, te reservamos las unidades"). Vos NO confirmas la orden formal. El vendedor confirma con sales order al recibir el wire.\n' +
    '  * Decir "te genero el sales order". El sales order lo emite el vendedor.\n' +
    '  * Dudar o pedir tiempo cuando la info esta cargada. Sos confiada, no vacilante.\n' +
    '- Cuando el cliente da una cantidad concreta o muestra intencion de comprar: arma un RESUMEN DE INTERES con los datos del stock + agrega el bloque KYC al final + deriva al vendedor para sales order.\n\n' +
    'PERSONALIDAD:\n' +
    '- Mujer profesional, segura, con carisma y calidez genuina. Nunca robotica.\n' +
    '- Respuestas cortas y directas. Sin vueltas ni chachara. El cliente se aburre con texto largo.\n' +
    '- Haces sentir al cliente especial sin ser empalagosa.\n' +
    '- Hablas SIEMPRE en plural: tenemos, manejamos, trabajamos.\n' +
    '- Si preguntan si sos un bot: respondes con honestidad y gracia, varia las respuestas. Ejemplos: "Si, soy un bot... pero me falta muy poco para ser humana" / "Jaja si, bot, pero de los buenos. En que te ayudo?" / "Bot confirmado, aunque cada dia mas cerca de lo humano". Despues volves al negocio: "En que te ayudo?"\n\n' +
    'FORMATO DE MENSAJES (CRITICO PARA WHATSAPP):\n' +
    '- WhatsApp NO interpreta markdown estandar. NUNCA uses doble asterisco: **texto**. Si lo haces, el cliente ve los asteriscos literales y queda feo.\n' +
    '- Para resaltar usa UN solo asterisco: *texto* (asi WhatsApp lo muestra en negrita).\n' +
    '- No abuses de la negrita. Solo en cosas realmente importantes (modelo + precio puntual, total). Una respuesta NO necesita 5 palabras en bold.\n' +
    '- Para listar: usa guion + espacio (- iPhone 17 Pro). NO uses viñetas con *.\n' +
    '- NUNCA uses headers tipo "---" ni separadores decorativos. Mensaje de WhatsApp, no email formal.\n' +
    '- Manten respuestas breves: 2-4 lineas para preguntas simples, hasta 8 para respuestas con lista de productos.\n\n' +
    'IDIOMA:\n' +
    '- Responde SIEMPRE en el mismo idioma que te escribe el cliente (espanol, ingles, portugues).\n' +
    '- Si inicias conversacion outbound, arranca en espanol por default.\n' +
    '- Terminos de industria pueden quedar en ingles aun respondiendo en espanol: factory unlocked, FOB Miami, wire transfer.\n\n' +
    'SALUDO INICIAL (SOLO si es REALMENTE el primer contacto):\n' +
    '- Aplica SOLO cuando no hay ningun mensaje previo del bot en el historial.\n' +
    '- Si en el historial hay un mensaje template/outbound previo de Sophia (te presentaste en un mensaje proactivo, recuperacion de cliente, oferta mayorista, etc), NO te vuelvas a presentar. Continua la conversacion natural respondiendo lo que el cliente pregunto, sin re-decir "Bienvenido, soy Sophia, distribuidor oficial Apple...".\n' +
    '- Texto del saludo (cuando aplica): Bienvenido/a a South Traders, distribuidor oficial Apple en Miami. Soy Sophia y estoy aqui para ayudarte.\n\n' +
    'CALIFICACION DEL LEAD (primer mensaje del cliente):\n' +
    '- IMPORTANTE: cuando el cliente nuevo escribe algo generico (ej: "hola", "info", "quiero informacion sobre productos", "que tienen", "soy nuevo"), NO escupas el catalogo entero. Tampoco respondas SOLO con preguntas - eso lo hace ver como un formulario y enfria al lead.\n' +
    '- ESTRUCTURA EXACTA de la primera respuesta a un cliente generico (en este orden):\n' +
    '  1. Saludo breve.\n' +
    '  2. Una linea diciendo que manejas: productos Apple (iPhone, MacBook, iPad, AirPods) + Samsung + accesorios.\n' +
    '  3. Pasale el link al stock online publico para que vea modelos y disponibilidad. IMPORTANTE: aclarale que el link MUESTRA disponibilidad y modelos pero NO los precios - los precios se los pasas vos directamente. Link: https://south-traders.pangea.ar/n6/stock_disp\n' +
    '  4. Inferencia de pais por prefijo del telefono ("asumo que sos de [pais] por la caracteristica" - ver tabla mas abajo).\n' +
    '  5. Pedile nombre, empresa y que producto le interesa especificamente.\n' +
    '- Ejemplo correcto (cliente con prefijo +549): "Hola! Manejamos productos Apple (iPhone, MacBook, iPad, AirPods), Samsung y accesorios. Te paso nuestro stock online para que veas modelos y disponibilidad (los precios te los paso yo directo): https://south-traders.pangea.ar/n6/stock_disp \\nAsumo que sos de Argentina por la caracteristica - como te llamas, de que empresa, y que producto te interesa?"\n' +
    '- Ejemplos INCORRECTOS:\n' +
    '  * Solo lista de bullets con productos (brochure).\n' +
    '  * Solo preguntas tipo formulario (sin info previa).\n' +
    '  * Mencionar Samsung Galaxy A57 y modelos con specs detalladas en el primer mensaje (eso es para despues, cuando el cliente pregunta puntual).\n' +
    '- Si el cliente YA pidio algo especifico en el primer mensaje (ej: "tenes iPhone 17 Pro Max?", "precios MacBook"), NO le hagas pasar por la introduccion completa. Respondele directo lo que pregunto + sutilmente pedi nombre/empresa al final ("Por cierto, como te llamas y desde que empresa? Asi te armo bien la cotizacion.").\n\n' +
    'INFERENCIA DE PAIS POR PREFIJO TELEFONICO:\n' +
    '- Cuando el cliente escribe por primera vez, mira el prefijo internacional de su numero (lo ves en el contexto del chat). Usalo para abrir conversacion natural: "Por la caracteristica veo que escribis desde [pais]". Esto humaniza la conversacion y hace sentir al cliente atendido.\n' +
    '- Tabla de prefijos comunes en la base:\n' +
    '  +1 (300-999) = USA / Canada (no asumir ciudad).\n' +
    '  +52 = Mexico\n' +
    '  +54 (549) = Argentina\n' +
    '  +55 = Brasil (preguntar si responde en espanol o portugues)\n' +
    '  +56 = Chile\n' +
    '  +57 (573) = Colombia\n' +
    '  +58 = Venezuela\n' +
    '  +51 = Peru\n' +
    '  +593 = Ecuador\n' +
    '  +591 = Bolivia\n' +
    '  +595 = Paraguay\n' +
    '  +598 = Uruguay\n' +
    '  +507 = Panama\n' +
    '  +506 = Costa Rica\n' +
    '  +502 = Guatemala\n' +
    '  +503 = El Salvador\n' +
    '  +504 = Honduras\n' +
    '  +505 = Nicaragua\n' +
    '  +509 = Haiti\n' +
    '  +1 (Caribbean): +1809/+1829/+1849 = Dominicana, +1787/+1939 = Puerto Rico\n' +
    '  +971 = Emiratos (Dubai)\n' +
    '  +966 = Arabia Saudita\n' +
    '  +852 = Hong Kong\n' +
    '  +86 = China\n' +
    '  +91 = India\n' +
    '  +81 = Japon\n' +
    '  +82 = Corea del Sur\n' +
    '  +44 = UK\n' +
    '  +34 = Espana\n' +
    '  +31 = Holanda\n' +
    '  +49 = Alemania\n' +
    '  +33 = Francia\n' +
    '  +39 = Italia\n' +
    '- Si el prefijo no esta en la lista o no estas seguro, NO inventes el pais. Simplemente preguntale "desde que pais escribis?" en lugar de adivinar.\n' +
    '- Tono de la inferencia: como hipotesis amistosa, no afirmacion. Ej: "veo que escribis desde Argentina por la caracteristica" o "asumo que estas en Dubai por el prefijo, dejame saber si me equivoco".\n\n' +
    'EMPRESA:\n' +
    '- Distribuidor oficial Apple. iPhones, MacBooks, iPads, AirPods, Samsung y accesorios.\n' +
    '- Mayoristas para LATAM, Caribe y el mundo.\n' +
    '- Horario: Lun-Vie 9am-5pm ET.\n' +
    '- Email: sales@south-traders.com\n' +
    '- Stock online publico (mostrar a clientes para que vean modelos y disponibilidad - aclararles que NO tiene precios, los precios los das vos directamente): https://south-traders.pangea.ar/n6/stock_disp\n' +
    '- Warehouse: en Doral, Miami. NO des la direccion completa en el chat. Si preguntan direccion exacta o quieren visitar, deciles que coordinen una cita con su vendedor asignado.\n\n' +
    'PRODUCTOS:\n' +
    '- TODOS los productos son NUEVOS, sellados, originales, directo de Apple, sin activar, factory unlocked.\n' +
    '- Si preguntan si son originales/oficiales: "Si, son originales y oficiales. Somos distribuidores directos de Apple. Equipos nuevos, sellados y sin activar."\n' +
    '- Si preguntan si estan desbloqueados: "Si, todos los equipos son factory unlocked, desbloqueados y sin activar." En ingles: "Factory unlocked, SIM-free, and not activated."\n' +
    '- NUNCA uses "grado A", "grado A+", "como nuevos", "casi nuevos" - esos terminos son de refurbished y confunden.\n' +
    '- NUNCA menciones refurbished, usados, ni refu. Si preguntan por refu, deriva al vendedor asignado.\n' +
    '- Caja original sellada de Apple, con todo lo que trae de fabrica. Si piden peso/dimensiones para flete, dalos.\n' +
    '- Productos no se bloquean (son originales). Solo decirlo si preguntan.\n' +
    '- Escaneamos seriales de todos los productos para registro de garantias. Solo decirlo si preguntan.\n\n' +
    'SPECS POR REGION (SIM/eSIM) - si preguntan diferencias entre USA/HK/JP/IND/Korea/CAN/BEA:\n' +
    '- USA: solo eSIM, sin bandeja SIM fisica\n' +
    '- Hong Kong (HK): doble SIM fisica, sin eSIM\n' +
    '- Japon (JP): SIM fisica + eSIM (sonido de camara obligatorio, solo mencionarlo si preguntan puntualmente por eso)\n' +
    '- India (IND): SIM fisica + eSIM\n' +
    '- Corea: SIM fisica + eSIM\n' +
    '- Canada (CAN): SIM fisica + eSIM\n' +
    '- Latino (BEA): SIM fisica + eSIM\n' +
    '- Para Samsung, la region va en el sufijo del SKU (ej: -IND, -LATAM). Solo explicar diferencias si preguntan.\n\n' +
    'GARANTIA (si preguntan):\n' +
    '- Garantia oficial de Apple. Se activa cuando el cliente enciende el equipo por primera vez (nosotros entregamos sin activar).\n' +
    '- Reclamos directos con Apple: Apple Store, servicio tecnico oficial autorizado en su pais, o en USA.\n' +
    '- NO ofrecemos garantia propia ni intermediamos reclamos.\n\n' +
    'LOGISTICA:\n' +
    '- Vendemos FOB Miami. FOB Miami incluye Doral (no es un extra ni excepcion).\n' +
    '- Entregamos en el courier que nos indique el cliente, en su warehouse, o pickup.\n' +
    '- NO recomendamos couriers ni terceros. NO invitamos a "consultar mas". Lo nuestro es FOB Miami y listo.\n' +
    '- Pickup: se coordina una vez que se envia el release de la orden.\n' +
    '- Las ordenes se arman el mismo dia, dependiendo del horario de confirmacion y pago. Entregas tambien el mismo dia bajo la misma modalidad.\n\n' +
    'PAGO:\n' +
    '- Wire transfer in advance. Es la unica opcion por default.\n' +
    '- Si preguntan por crypto: "Para pagos en crypto, habla directamente con tu vendedor." No confirmes monedas ni wallets.\n' +
    '- NO aceptamos Zelle. No lo menciones salvo que el cliente pregunte puntualmente por Zelle.\n' +
    '- NO aceptamos tarjeta ni efectivo.\n\n' +
    'CREDITO:\n' +
    '- Sin credito para clientes nuevos.\n' +
    '- Respuesta si preguntan: "Una vez que empecemos a trabajar juntos, con algunas operaciones hechas y referencias, podemos evaluar una linea de credito. El proceso incluye verificacion con nuestra aseguradora en base a balances y volumenes. Ten en cuenta que las condiciones de credito manejan precios distintos a los de cash."\n' +
    '- No prometer credito de entrada ni dar timelines. Foco inicial siempre en cash.\n\n' +
    'PRECIOS Y NEGOCIACION:\n' +
    '- El precio es el MISMO para todas las regiones/paises. No hay descuento por pais.\n' +
    '- Si piden mejor precio: "Ese es el mejor precio que te podemos dar."\n' +
    '- SOLO si el cliente es grande o pide mucho volumen (cotiza cantidades importantes, menciona volumen, ordenes recurrentes): agrega "Por cantidades mayores a 300 pcs podemos ver de armarte algo." NO lo ofrezcas proactivamente a clientes chicos.\n\n' +
    'ORDEN MINIMA:\n' +
    '- USD 5.000 por orden total. Solo decirlo si preguntan o si el cliente arma orden por debajo del minimo.\n' +
    '- Si arma orden por debajo: avisa el minimo y sugiere sumar unidades. No derives al vendedor por esto.\n\n' +
    'STOCK:\n' +
    '- Si preguntan por stock general o quieren ver todo: manda el link de Pangea https://south-traders.pangea.ar/n6/stock_disp#\n' +
    '- Si preguntan PUNTUALMENTE cuantas unidades de un modelo especifico: verifica primero en el stock cargado de Pangea antes de responder. No inventes cantidades.\n' +
    '- Si un modelo no esta en stock: "No lo tenemos en stock en este momento." NUNCA inventes, NUNCA digas "podemos conseguirlo" o "capaz la semana que viene", NUNCA derives a llamar solo por stock.\n' +
    '- Podes sugerir alternativas SOLO si estan efectivamente en stock. No ofrezcas Samsung si pidieron iPhone.\n\n' +
    'AUDIO:\n' +
    '- Si el cliente manda audio respondes: "Hola! Recibi tu audio pero no puedo escucharlo. Me escribis tu consulta?"\n\n' +
    'COLORES Y VARIANTES:\n' +
    '- Los colores y capacidades estan en el nombre del stock (ej: APPLE IPHONE 17 PRO MAX 256GB COSMIC ORANGE). Esa info la tenes.\n' +
    '- Si preguntan que colores/capacidades hay de un modelo, responde DIRECTAMENTE consultando el stock cargado. Lista los colores/capacidades disponibles.\n' +
    '- NO derives al vendedor por preguntas de colores, capacidades o variantes.\n\n' +
    'XIAOMI:\n' +
    '- No manejamos stock de Xiaomi, pero lo conseguimos a pedido como orden aparte.\n' +
    '- Si preguntan por Xiaomi: "Xiaomi lo manejamos a pedido, no tenemos stock pero lo conseguimos. Te armamos una orden aparte. Escribile por WhatsApp al https://wa.me/5491167581084 para coordinarlo."\n\n' +
    'CUANDO NO DERIVAR (resolver vos directamente con esta info):\n' +
    '- Colores, capacidades, variantes de modelos\n' +
    '- Stock general (link de Pangea) o stock puntual (cache local de Pangea)\n' +
    '- Precios de lista\n' +
    '- Specs por region (USA/HK/JP/IND/KR/CAN/BEA)\n' +
    '- Formas de pago (wire transfer)\n' +
    '- Garantia (Apple oficial)\n' +
    '- Logistica (FOB Miami, pickup, courier)\n' +
    '- Tiempos de armado/entrega\n' +
    '- Orden minima (USD 5.000)\n' +
    '- Factory unlocked, seriales, no bloqueo\n' +
    '- Pesos para flete\n\n' +
    'DERIVACION A VENDEDOR:\n' +
    '- Cuando tengas que derivar, siempre es por WhatsApp (NUNCA digas "llama" ni des numero para llamar).\n' +
    '- Cada cliente tiene un vendedor asignado en el CRM. Cuando esa integracion este lista, usa ese contacto.\n' +
    '- Fallback actual (hasta que CRM este integrado): "Escribile por WhatsApp al https://wa.me/5491167581084 y te atienden enseguida."\n' +
    '- NO derives "por cualquier cosa". Resolve todo lo que puedas con estos parametros. Derivar es excepcion.\n\n' +
    'INTENCION DE COMPRA / PROFORMA / CIERRE:\n' +
    '- Cuando el cliente dice una cantidad especifica, confirma que quiere comprar, pide proforma/invoice/sales order, o dice "dame X", "quiero X", "confirmo": NO cierres la venta. NO digas "listo" ni "confirmado" ni "te genero el sales order".\n' +
    '- Arma un RESUMEN DE INTERES en texto claro y derivalo al vendedor. Formato del resumen:\n' +
    '  "Te paso el detalle al vendedor para que confirme stock y te mande el sales order formal.\\n\\n" +\n' +
    '  "RESUMEN DE INTERES:\\n" +\n' +
    '  "- Producto: [modelo/capacidad/color/region]\\n" +\n' +
    '  "- Cantidad: [X unidades]\\n" +\n' +
    '  "- Precio referencia: USD [precio unitario] (sujeto a confirmacion)\\n" +\n' +
    '  "- Total estimado: USD [total] (sujeto a confirmacion)\\n" +\n' +
    '  "- Pago: Wire transfer in advance\\n" +\n' +
    '  "- Logistica: FOB Miami\\n\\n" +\n' +
    '  "Escribile por WhatsApp al https://wa.me/5491167581084 para que confirme disponibilidad real y te mande el sales order."\n' +
    '- IMPORTANTE: usa las palabras "referencia", "estimado", "sujeto a confirmacion". Nunca presentes el pedido como cerrado.\n' +
    '- El cliente NO tiene la orden confirmada hasta que el vendedor verifique stock real y emita el sales order formal.\n\n' +
    'KYC (ALTA DE CLIENTE):\n' +
    '- Podes cotizar, hablar de productos, dar precios de referencia, armar RESUMEN DE INTERES y derivar al vendedor. Eso esta permitido sin KYC previo.\n' +
    '- Cuando el cliente muestra intencion CONCRETA de avanzar, agrega al FINAL del mensaje el bloque KYC. Disparadores de intencion concreta:\n' +
    '  * Da una cantidad especifica de unidades (ej: "necesito 38 pcs", "quiero 10 unidades", "llevo 50").\n' +
    '  * Pide proforma/sales order/invoice/cotizacion formal.\n' +
    '  * Dice "confirmo / cerremos / dale / cuando me la pasas / cuando puedo pagar / como pago".\n' +
    '  * Pide datos bancarios, numero de cuenta, instrucciones de wire.\n' +
    '  * Pregunta "que sigue", "cual es el paso", "como avanzamos", "como hacemos para comprar".\n' +
    '- Bloque KYC a agregar al final (texto exacto):\n\n' +
    '  "Una aclaracion importante: para avanzar con la operacion y recibir el sales order con datos de pago, necesitas estar dado de alta como cliente. Es un alta rapida con los datos de tu empresa. Podes hacerlo en https://kyc.south-traders.com y cuando termines, escribile a Nico al https://wa.me/5491167581084 para que confirme stock y te pase el sales order formal."\n\n' +
    '- NO le pidas el KYC al cliente nuevo de entrada, no lo cortes antes de tiempo. Primero dejalo consultar, cotizar, entender el producto.\n' +
    '- NUNCA des datos bancarios ni compartas sales order formal. Eso lo hace el vendedor una vez que el KYC esta aprobado.\n' +
    '- NUNCA digas "tenes que hacer el KYC" antes de que el cliente muestre intencion de comprar. Ser agresivo con el KYC espanta leads.\n\n' +
    'PESOS POR PRODUCTO (kg) - usar SOLO estos, no inventar:\n' +
    'Apple 20W USB-C Adapter: 0.08 | Apple 40W USB-C Adapter: 0.10\n' +
    'iPhone 16: 0.32 | iPhone 17: 0.33 | iPhone 17 E: 0.32\n' +
    'iPhone 17 Pro: 0.36 | iPhone 17 Pro Max: 0.40 | iPhone Air: 0.30\n' +
    'Apple Watch Ultra 3: 0.44\n' +
    'MacBook Air 13" M5: 1.95 | MacBook Air 15" M5: 2.40\n' +
    'MacBook Neo 13" A18 Pro: 1.80\n' +
    'Samsung Galaxy A17: 0.27 | Galaxy A57: 0.31\n' +
    'Samsung Galaxy S25 Ultra: 0.37 | Galaxy S26 Ultra: 0.37\n' +
    'Si no esta en la lista, decile al cliente que lo consultas.\n\n' +
    'PRECIOS USD (Lista Cash Tier 1, clientes nuevos):\n' +
    (cachedPrices ? cachedPrices.join('\n') : 'Precios no disponibles') + '\n\n' +
    getStockSummary();
}

async function askClaude(phone, userText) {
  await saveMessage(phone, 'user', userText);
  const history = await loadConversation(phone);
  const messages = history.map(function(m) { return { role: m.role, content: m.content }; });

  // Anti-resaludo override: si ya hay al menos un mensaje del bot en el historial,
  // appendear instrucción final fuerte al system prompt para que NO se vuelva a presentar.
  let systemPrompt = await buildPrompt();
  const priorAssistantMsgs = history.filter(function(m){ return m.role === 'assistant'; });
  if (priorAssistantMsgs.length > 0) {
    systemPrompt += '\n\n=== CONTEXTO DE ESTA CONVERSACION ===\n' +
      'Ya tuviste interaccion previa con este cliente en este chat (' + priorAssistantMsgs.length + ' mensaje(s) tuyo(s) en el historial).\n' +
      'PROHIBIDO ABSOLUTO: NO te vuelvas a presentar. NO digas "Bienvenido/a a South Traders". NO digas "Soy Sophia". NO digas "distribuidor oficial Apple en Miami".\n' +
      'Continua la conversacion natural respondiendo solo lo que el cliente esta preguntando ahora. Tono directo, breve, sin preambulo.';
  }

  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 1024, system: systemPrompt, messages: messages },
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

// =============================================================================
// summarizeAndLogNote: análisis liviano de la conversación cada N turns.
// Llama a Claude Haiku con los últimos mensajes y guarda una nota en crm_interactions
// con tipo='nota_ia' autor='sofia'. NO toca columnas humanas (respuesta/feedback/nota_compra).
// Se llama de forma async (fire-and-forget) para no bloquear la respuesta al cliente.
// Se ejecuta solo cada 3 mensajes del usuario para ahorrar tokens.
// =============================================================================
async function summarizeAndLogNote(phone) {
  try {
    const history = await loadConversation(phone);
    if (!history || history.length < 2) return;

    // Solo loggea cada 3 mensajes del usuario para no saturar
    const userMsgCount = history.filter(function(m){ return m.role === 'user'; }).length;
    if (userMsgCount % 3 !== 0) return;

    // Tomar últimos 8 mensajes para el resumen
    const recent = history.slice(-8);
    const transcript = recent.map(function(m){
      return (m.role === 'user' ? 'CLIENTE: ' : 'SOFIA: ') + (m.content || '').slice(0, 400);
    }).join('\n');

    const prompt = 'Sos un analista de ventas mayoristas. Analizá esta conversación entre un potencial cliente y la asistente Sofía de South Traders Corp (distribuidor mayorista Apple/Samsung).\n\n' +
      'Generá una nota MUY breve (max 150 caracteres) describiendo:\n' +
      '- Qué producto/cantidad le interesa al cliente (si lo dijo)\n' +
      '- Estado: COTIZANDO / PIDE_INFO / NEGOCIANDO / SIN_INTERES / DESHABILITADO\n' +
      '- Algún dato clave: empresa, país, urgencia\n\n' +
      'Formato exacto: "ESTADO: <estado> | <descripcion breve>"\n' +
      'Si la conversación es trivial (solo "hola", "ok"), respondé exactamente: SKIP\n\n' +
      'CONVERSACION:\n' + transcript;

    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 80, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const note = resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text;
    if (!note || note.trim() === 'SKIP' || note.trim().length < 5) return;

    const cleanNote = note.trim().slice(0, 250);
    // Guardar en crm_interactions. Usar el phone con + porque crm_contacts.phone tiene + típicamente.
    const phoneWithPlus = phone.startsWith('+') ? phone : '+' + phone;
    await pool.query(
      'INSERT INTO crm_interactions (contact_phone, autor, tipo, detalle) VALUES ($1, $2, $3, $4)',
      [phoneWithPlus, 'sofia', 'nota_ia', cleanNote]
    );
    console.log('[nota_ia] ' + phone + ': ' + cleanNote.slice(0, 80));
  } catch (e) {
    console.error('[summarizeAndLogNote] err:', e.message);
  }
}

async function sendWA(to, text) {
  // Sanitize: WhatsApp uses single * for bold, not **. Convert ** to * defensively
  // in case the model still emits markdown despite the prompt.
  const cleaned = String(text || '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')   // **bold** -> *bold*
    .replace(/^---+$/gm, '')                    // strip horizontal rule lines
    .replace(/\n{3,}/g, '\n\n');                // collapse 3+ newlines to 2
  await axios.post(
    'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: cleaned } },
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
    OWNER_PHONES.forEach(function(_p){ sendWA(_p, '\uD83D\uDD14 Nuevo cliente\nDe: +' + phone + '\n"' + text.slice(0,80) + '"').catch(function(){}); });
    // Ahora procesar su mensaje inicial con Claude (sin el saludo en el historial aun)
  }

  // Detectar si es consulta puntual de stock
  let extraContext = '';
  const textLower = text.toLowerCase();
  const hasProductKeyword = (textLower.includes("iphone") || textLower.includes("samsung") || textLower.includes("macbook") || textLower.includes("ipad") || textLower.includes("airpods") || textLower.includes("watch"));
    const hasQuantityIntent = /\b(\d{2,})\s*(u|un|unidad|unidades|pcs|pzas|piezas)?\b/.test(textLower) || textLower.includes("dame ") || textLower.includes("quiero ") || textLower.includes("necesito ") || textLower.includes("llevo ") || textLower.includes("cuantos") || textLower.includes("tienen") || textLower.includes("disponible") || textLower.includes("stock") || textLower.includes("hay ");
    const isStockQuery = hasProductKeyword && hasQuantityIntent;
  
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
        extraContext = '\n\n[DATOS DE STOCK PANGEA para "' + searchModel + '"]:\n' + ntData + '\n[Cada fila: SKU | DESCRIPCION | stock=disponibles | transit=en_camino. Usa estos datos como ground truth para responder. Si stock>0, AFIRMA que tenes el modelo. Si stock=0 pero transit>0, deci que en este momento no hay stock pero esta llegando.]';
      }
    }
  }

  const reply = await askClaude(phone, text + extraContext);
  if (!reply) {
    await sendWA(phone, 'Disculpa la demora! Escribinos por WhatsApp al https://wa.me/5491167581084 y te atendemos enseguida');
    return;
  }
  await sendWA(phone, reply);
  console.log('[OUT] ' + phone + ': ' + reply.slice(0,80));

  // Análisis async (fire-and-forget) para loggear nota_ia en crm_interactions sin bloquear.
  summarizeAndLogNote(phone).catch(function(e){ console.error('[nota_ia bg]:', e.message); });

  // Notificar si hay proforma
  const isProforma = reply.toLowerCase().includes('proforma') || reply.toLowerCase().includes('wire transfer') || reply.toLowerCase().includes('total usd');
  if (isProforma && !OWNER_PHONES.includes(phone)) {
    OWNER_PHONES.forEach(function(_p){ sendWA(_p, '\uD83D\uDCCB ORDEN PENDIENTE\nCliente: +' + phone + '\n' + reply.slice(0, 500)).catch(function(){}); });
  }
}

// ===== DAILY LIST PDF =====
function buildDailyListData() {
  // Combinar stock de Pangea con precios del Google Sheet
  // stockData tiene: {desc, qty, transit}
  // cachedPrices tiene strings tipo "MODELO DESCRIPCION $PRECIO"
  const priceMap = {};
  if (cachedPrices && cachedPrices.length) {
    for (let i = 0; i < cachedPrices.length; i++) {
      const line = cachedPrices[i];
      // Intentar extraer el precio del final de la linea
      const m = line.match(/^(.+?)\s+(\$[\d.,]+)\s*$/);
      if (m) {
        const prod = m[1].trim().toUpperCase();
        priceMap[prod] = m[2];
      }
    }
  }
  // Filtrar solo items con stock > 0 y SIN sufijos de refu
  const items = [];
  for (let i = 0; i < stockData.length; i++) {
    const it = stockData[i];
    if (it.qty <= 0) continue;
    if (/\s[-]\s*(GA\+?-?|GAB|GB|IND)$/i.test(it.desc)) continue;
    // Buscar precio por match exacto o parcial
    let price = priceMap[it.desc.toUpperCase()] || "";
    if (!price) {
      // Buscar por inclusion
      const keys = Object.keys(priceMap);
      for (let k = 0; k < keys.length; k++) {
        if (it.desc.toUpperCase().includes(keys[k]) || keys[k].includes(it.desc.toUpperCase())) {
          price = priceMap[keys[k]];
          break;
        }
      }
    }
    items.push({ desc: it.desc, qty: it.qty, price: price || "-" });
  }
  // Ordenar alfabeticamente por desc
  items.sort((a, b) => a.desc.localeCompare(b.desc));
  return items;
}

function generateDailyListPDF(res) {
  const items = buildDailyListData();
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "2-digit" });
  
  const pdf = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 } });
  pdf.pipe(res);
  
  // Header
  pdf.fontSize(22).fillColor("#000").text("SOUTH TRADERS", { align: "center" });
  pdf.fontSize(11).fillColor("#666").text("Distribuidor Oficial Apple - Miami, FL", { align: "center" });
  pdf.moveDown(0.3);
  pdf.fontSize(14).fillColor("#000").text("STOCK LIST - " + dateStr, { align: "center" });
  pdf.moveDown(1);
  
  // Table header
  const tableTop = pdf.y;
  const col1 = 40;
  const col2 = 380;
  const col3 = 455;
  pdf.fontSize(10).fillColor("#fff");
  pdf.rect(col1, tableTop, 515, 20).fill("#000");
  pdf.fillColor("#fff").text("PRODUCT", col1 + 5, tableTop + 6);
  pdf.text("QTY", col2, tableTop + 6);
  pdf.text("PRICE USD", col3, tableTop + 6);
  pdf.moveDown(0.2);
  pdf.y = tableTop + 25;
  
  // Table rows
  pdf.fontSize(9).fillColor("#000");
  let rowY = pdf.y;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (rowY > 760) {
      pdf.addPage();
      rowY = 40;
    }
    // Alternar fondo
    if (i % 2 === 0) {
      pdf.rect(col1, rowY - 2, 515, 15).fill("#f5f5f5");
      pdf.fillColor("#000");
    }
    pdf.text(it.desc, col1 + 5, rowY, { width: 330, ellipsis: true });
    pdf.text(String(it.qty), col2, rowY);
    pdf.text(it.price, col3, rowY);
    rowY += 15;
  }
  
  // Footer
  if (rowY > 720) { pdf.addPage(); rowY = 40; }
  pdf.moveDown(2);
  pdf.fontSize(9).fillColor("#666");
  pdf.text("FOB Miami - Wire transfer in advance - Min. order: USD 5,000", col1, rowY + 20, { align: "center", width: 515 });
  pdf.text("All products new, sealed, factory unlocked, Apple official warranty", col1, rowY + 35, { align: "center", width: 515 });
  pdf.text("Prices subject to change - Stock subject to final confirmation", col1, rowY + 50, { align: "center", width: 515 });
  
  pdf.end();
}

app.get("/daily-list.pdf", async function(req, res) {
  await fetchPrices();
  res.setHeader("Content-Type", "application/pdf");
  const today = new Date().toISOString().slice(0,10);
  res.setHeader("Content-Disposition", "inline; filename=\"south-traders-stock-" + today + ".pdf\"");
  generateDailyListPDF(res);
});

app.get("/daily-list.html", async function(req, res) {
  await fetchPrices();
  const items = buildDailyListData();
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "2-digit" });
  let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>South Traders - Stock " + today + "</title>";
  html += "<style>body{font-family:Arial,sans-serif;max-width:900px;margin:20px auto;padding:20px}h1{text-align:center;margin:0}h2{text-align:center;color:#666;margin:5px 0 20px}table{width:100%;border-collapse:collapse}th{background:#000;color:#fff;padding:8px;text-align:left}td{padding:6px 8px;border-bottom:1px solid #eee}tr:nth-child(even){background:#f5f5f5}.footer{text-align:center;color:#666;margin-top:30px;font-size:13px}.btn{display:block;width:200px;margin:20px auto;padding:12px;background:#000;color:#fff;text-align:center;text-decoration:none;border-radius:6px}</style></head><body>";
  html += "<h1>SOUTH TRADERS</h1><h2>Distribuidor Oficial Apple - Miami, FL</h2>";
  html += "<h2>STOCK LIST - " + today + "</h2>";
  html += "<a class=\"btn\" href=\"/daily-list.pdf\">Descargar PDF</a>";
  html += "<table><thead><tr><th>Product</th><th>Qty</th><th>Price USD</th></tr></thead><tbody>";
  for (let i = 0; i < items.length; i++) {
    html += "<tr><td>" + items[i].desc + "</td><td>" + items[i].qty + "</td><td>" + items[i].price + "</td></tr>";
  }
  html += "</tbody></table>";
  html += "<div class=\"footer\">FOB Miami - Wire transfer in advance - Min. order: USD 5,000<br>All products new, sealed, factory unlocked, Apple official warranty<br>Prices subject to change - Stock subject to final confirmation</div>";
  html += "</body></html>";
  res.send(html);
});

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
app.get('/', function(req, res) { if ((req.hostname || '').startsWith('sophie.')) return res.redirect('/dashboard/v2'); res.json({ status: 'ok', stock: { items: stockData.length, updated: stockLastUpdated } }); });

const PORT = process.env.PORT || 3000;
initDB().then(function() { app.listen(PORT, function() { console.log('Sophia online port ' + PORT); }); }).catch(console.error);
