require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'southtraders_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Session storage
const sessions = {};

// Business info
const BUSINESS_INFO = {
        name: 'South Traders',
        address: '10850 NW 21st St, Suite 140, Miami FL 33172',
        hours: 'Monday to Friday, 9:00 AM - 5:00 PM EST',
        type: 'Wholesale only (minimum order required)',
        minOrder: 'Minimum 5 units per model',
        email: 'info@southtraders.com'
};

// Price list (hardcoded)
const PRICE_LIST = {
        'IPHONE 17': [
            { model: 'Apple iPhone Air 256GB US Specs', price: '$850.00' },
            { model: 'Apple iPhone 17e 256GB US Specs', price: '$545.00' },
            { model: 'Apple iPhone 17 256GB US/JP Specs', price: '$745.00' },
            { model: 'Apple iPhone 17 Pro 256GB US Specs', price: '$1,170.00' },
            { model: 'Apple iPhone 17 Pro Max 256GB US Specs', price: '$1,305.00' },
            { model: 'Apple iPhone 17 Pro Max 512GB US/JP Specs', price: '$1,480.00' },
            { model: 'Apple iPhone 17 Pro Max 1TB US Specs', price: '$1,680.00' },
                ],
        'IPHONE': [
            { model: 'iPhone 15 128GB IND Specs', price: '$548.00' },
            { model: 'iPhone 16 128GB IND Specs', price: '$662.00' },
                ],
        'SAMSUNG': [
            { model: 'Samsung Galaxy S26 Ultra 12GB + 512GB', price: '$1,170.00' },
            { model: 'Samsung Galaxy S25 Ultra 12GB + 512GB', price: '$895.00' },
                ],
        'MACBOOK': [
            { model: 'MacBook Air 13" M5 16GB/512GB', price: '$1,060.00' },
            { model: 'MacBook Air 15" M5 16GB/512GB', price: '$1,260.00' },
            { model: 'MacBook Neo 13" A18 Pro 8GB/256GB', price: '$620.00' },
            { model: 'MacBook Neo 13" A18 Pro 8GB/512GB', price: '$720.00' },
                ],
        'ACCESORIOS': [
            { model: 'Apple 20W USB-C Power Adapter USA', price: '$13.50' },
            { model: 'Apple 40W USB-C Power Adapter USA', price: '$17.50' },
            { model: 'Apple iPad (11th Gen) A16 WiFi 128GB', price: '$307.00' },
            { model: 'Apple Watch Ultra 3 GPS + Cellular 49mm', price: '$690.00' },
            { model: 'AirPods Pro 3 Gen', price: '$210.00' },
            { model: 'Apple AirPods 4', price: '$100.00' },
                ],
};

const MODELS = ['iPhone 15', 'iPhone 16', 'iPhone 17', 'iPhone 17e', 'iPhone 17 Pro', 'iPhone 17 Pro Max'];

// Webhook verification
app.get('/webhook', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                    console.log('Webhook verified');
                    res.status(200).send(challenge);
        } else {
                    res.sendStatus(403);
        }
});

// Receive messages
app.post('/webhook', async (req, res) => {
        try {
                    const body = req.body;
                    if (body.object === 'whatsapp_business_account') {
                                    for (const entry of body.entry || []) {
                                                        for (const change of entry.changes || []) {
                                                                                const value = change.value;
                                                                                if (value.messages) {
                                                                                                            for (const msg of value.messages) {
                                                                                                                                            const from = msg.from;
                                                                                                                                            const text = msg.type === 'text' ? msg.text.body.trim() : '';
                                                                                                                                            await handleMessage(from, text);
                                                                                                                }
                                                                                    }
                                                        }
                                    }
                    }
                    res.sendStatus(200);
        } catch (err) {
                    console.error(err);
                    res.sendStatus(500);
        }
});

function getPriceListText() {
        let text = '*📋 Price List / Lista de Precios*\n';
        text += '_Wholesale prices - Precios mayoristas_\n';
        text += '_Min. 5 units per model / Min. 5 unidades por modelo_\n\n';
        for (const [category, items] of Object.entries(PRICE_LIST)) {
                    text += `*── ${category} ──*\n`;
                    for (const item of items) {
                                    text += `• ${item.model}: *${item.price}*\n`;
                    }
                    text += '\n';
        }
        text += '💬 To place an order reply *3* or type *ORDER*\n';
        text += '💬 Para hacer un pedido respondé *3* o escribí *ORDEN*';
        return text;
}

async function handleMessage(from, text) {
        if (!sessions[from]) sessions[from] = { step: 'menu' };
        const session = sessions[from];
        const lower = text.toLowerCase();

    // Greeting triggers - only show menu for greetings, not for every message
    const isGreeting = ['hola', 'hello', 'hi', 'buenas', 'hey', 'start', 'menu', 'inicio'].some(w => lower === w || lower.startsWith(w));
        if (isGreeting) {
                    sessions[from] = { step: 'menu' };
                    await sendMessage(from, getMainMenu());
                    return;
        }

    // Order flow takes priority when in order steps
    if (session.step === 'order_model') {
                const modelIndex = parseInt(lower) - 1;
                let selectedModel = null;
                if (modelIndex >= 0 && modelIndex < MODELS.length) {
                                selectedModel = MODELS[modelIndex];
                } else {
                                selectedModel = MODELS.find(m => lower.includes(m.toLowerCase()));
                }
                if (selectedModel) {
                                sessions[from] = { step: 'order_quantity', model: selectedModel };
                                await sendMessage(from, `Great choice! / ¡Buena elección!\n\n📱 *${selectedModel}*\n\nHow many units do you need?\n¿Cuántas unidades necesitás?\n\n⚠️ Minimum order is 5 units.\nEl pedido mínimo es 5 unidades.\n\nPlease enter a quantity of 5 or more:`);
                } else {
                                await sendMessage(from, `I didn't recognize that model. Please choose from the list:\nNo reconocí ese modelo. Por favor elegí de la lista:\n\n${MODELS.map((m, i) => `${i + 1}. ${m}`).join('\n')}`);
                }
                return;
    }

    if (session.step === 'order_quantity') {
                const qty = parseInt(text);
                if (qty >= 5) {
                                sessions[from] = { step: 'order_color', model: session.model, quantity: qty };
                                await sendMessage(from, `Perfect! ${qty} units of ${session.model}\n\nWhat color(s) do you prefer?\nPerfecto! ${qty} unidades de ${session.model}\n\n¿Qué color/es preferís?\n\n🎨 Available colors / Colores disponibles:\nBlack, White, Blue, Natural Titanium, Desert Titanium, White Titanium, Black Titanium`);
                } else {
                                await sendMessage(from, `Minimum order is 5 units.\nEl pedido mínimo es 5 unidades.\n\nPlease enter a quantity of 5 or more:`);
                }
                return;
    }

    if (session.step === 'order_color') {
                sessions[from] = { step: 'order_confirm', model: session.model, quantity: session.quantity, color: text };
                await sendMessage(from, `*📋 Order Summary / Resumen del Pedido:*\n\n📱 Model: ${session.model}\n📦 Quantity: ${session.quantity} units\n🎨 Color: ${text}\n\nTo confirm your order, please reply *CONFIRM*\nTo cancel, reply *CANCEL*\n\nPara confirmar tu pedido respondé *CONFIRMAR*\nPara cancelar respondé *CANCELAR*`);
                return;
    }

    if (session.step === 'order_confirm') {
                if (['confirm', 'confirmar', 'yes', 'si', 'sí'].some(w => lower === w)) {
                                await sendMessage(from, `✅ *Order Received! / ¡Pedido Recibido!*\n\n📱 ${session.model} x${session.quantity} - ${session.color}\n\nOur team will contact you shortly to finalize pricing and payment details.\nNuestro equipo se comunicará con vos pronto para finalizar el precio y los detalles de pago.\n\n📍 Warehouse: ${BUSINESS_INFO.address}\n🕐 Hours: ${BUSINESS_INFO.hours}`);
                                sessions[from] = { step: 'menu' };
                } else if (['cancel', 'cancelar', 'no'].some(w => lower === w)) {
                                sessions[from] = { step: 'menu' };
                                await sendMessage(from, `Order cancelled. / Pedido cancelado.\n\n${getMainMenu()}`);
                } else {
                                await sendMessage(from, `Please reply CONFIRM to confirm or CANCEL to cancel.\nPor favor respondé CONFIRMAR para confirmar o CANCELAR para cancelar.`);
                }
                return;
    }

    // Menu options (work from any state including 'menu')
    // Prices
    if (['1', 'precio', 'precios', 'price', 'prices', 'lista', 'list'].some(w => lower === w || lower.includes(w))) {
                await sendMessage(from, getPriceListText());
                return;
    }

    // Models / Specs
    if (['2', 'modelo', 'modelos', 'spec', 'specs', 'especificaciones'].some(w => lower === w || lower.includes(w))) {
                await sendMessage(from, getModelsInfo());
                return;
    }

    // Place order
    if (['3', 'orden', 'order', 'pedido', 'comprar', 'buy'].some(w => lower === w || lower.includes(w))) {
                sessions[from] = { step: 'order_model' };
                await sendMessage(from, `*🛒 Place an Order / Hacer un Pedido*\n\nWhich model are you interested in?\n¿Qué modelo te interesa?\n\n${MODELS.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nReply with the model name or number.\nRespondé con el nombre o número del modelo.`);
                return;
    }

    // Inventory
    if (['4', 'inventario', 'inventory', 'stock', 'disponible', 'available'].some(w => lower === w || lower.includes(w))) {
                await sendMessage(from, getInventoryInfo());
                return;
    }

    // Location
    if (['5', 'ubicacion', 'ubicación', 'location', 'address', 'dirección', 'direccion', 'warehouse', 'miami'].some(w => lower === w || lower.includes(w))) {
                await sendMessage(from, getLocationInfo());
                return;
    }

    // FAQ
    if (['6', 'faq', 'preguntas', 'questions', 'info', 'informacion', 'información'].some(w => lower === w || lower.includes(w))) {
                await sendMessage(from, getFAQ());
                return;
    }

    // Default - show menu
    await sendMessage(from, `I didn't understand that. Here's the main menu:\nNo entendí eso. Aquí está el menú principal:\n\n${getMainMenu()}`);
}

function getMainMenu() {
        return `👋 *Welcome to South Traders! / ¡Bienvenido a South Traders!*\n_Wholesale iPhones & Tech - Miami_\n\nHow can we help you?\n¿En qué podemos ayudarte?\n\n1️⃣ Price List / Lista de Precios\n2️⃣ Models & Specs / Modelos y Especificaciones\n3️⃣ Place an Order / Hacer un Pedido\n4️⃣ Inventory / Inventario\n5️⃣ Location & Hours / Ubicación y Horarios\n6️⃣ FAQ / Preguntas Frecuentes\n\nReply with a number or keyword.\nRespondé con un número o palabra clave.`;
}

function getModelsInfo() {
        return `📱 *Models & Specs / Modelos y Especificaciones*\n\nCurrently stocking / Actualmente en stock:\n${MODELS.map(m => `• ${m}`).join('\n')}\n\n🔓 For real-time availability and quantities, contact our sales team or visit our warehouse.\nPara disponibilidad en tiempo real, contactá a nuestro equipo de ventas o visitá el warehouse.\n\n📍 ${BUSINESS_INFO.address}\n🕐 ${BUSINESS_INFO.hours}\n\n⚠️ *Wholesale only - Minimum 5 units per model*\n*Solo mayorista - Mínimo 5 unidades por modelo*`;
}

function getInventoryInfo() {
        return `📦 *Inventory / Inventario*\n\nWe maintain live inventory updated daily.\nMantenemos inventario actualizado diariamente.\n\n✅ *Currently stocking / Actualmente en stock:*\n${MODELS.map(m => `• ${m}`).join('\n')}\n\n🔎 For real-time availability and quantities, contact our sales team or visit our warehouse.\nPara disponibilidad en tiempo real, contactá a nuestro equipo de ventas o visitá el warehouse.\n\n📍 ${BUSINESS_INFO.address}\n🕐 ${BUSINESS_INFO.hours}\n\n⚠️ *Wholesale only - Minimum 5 units per model*\n*Solo mayorista - Mínimo 5 unidades por modelo*`;
}

function getLocationInfo() {
        return `📍 *Location & Hours / Ubicación y Horarios*\n\n🏢 *South Traders Warehouse*\n${BUSINESS_INFO.address}\n\n🕐 *Hours / Horarios:*\n${BUSINESS_INFO.hours}\n\n🚗 *We are located in the Doral/Miami area*\n*Estamos ubicados en el área de Doral/Miami*\n\n✅ Walk-ins welcome during business hours\n✅ Se aceptan visitas durante el horario de atención\n\n🛒 *Wholesale buyers only*\n*Solo compradores mayoristas*`;
}

function getFAQ() {
        return `❓ *FAQ / Preguntas Frecuentes*\n\n*Q: Do you sell retail? / ¿Venden al por menor?*\nA: No, wholesale only. Min 5 units. / No, solo mayorista. Mín 5 unidades.\n\n*Q: Are phones unlocked? / ¿Los teléfonos están desbloqueados?*\nA: Yes, all units are factory unlocked. / Sí, todas las unidades están desbloqueadas de fábrica.\n\n*Q: Do you ship? / ¿Hacen envíos?*\nA: Yes, domestic & international. / Sí, nacional e internacional.\n\n*Q: What payment methods? / ¿Qué métodos de pago?*\nA: Wire transfer, Zelle, Cash. / Transferencia bancaria, Zelle, Efectivo.\n\n*Q: Are prices negotiable? / ¿Los precios son negociables?*\nA: For large orders, yes. / Para pedidos grandes, sí.\n\n*Q: Location? / ¿Dónde están?*\nA: ${BUSINESS_INFO.address}\n\nMore questions? Reply with your question!\n¿Más preguntas? ¡Respondé con tu pregunta!`;
}

async function sendMessage(to, message) {
        try {
                    await axios.post(
                                    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                        {
                                            messaging_product: 'whatsapp',
                                            to,
                                            type: 'text',
                                            text: { body: message }
                        },
                        {
                                            headers: {
                                                                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                                                                    'Content-Type': 'application/json'
                                            }
                        }
                                );
        } catch (err) {
                    console.error('Error sending message:', err.response?.data || err.message);
        }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`South Traders WhatsApp Bot running on port ${PORT}`));
