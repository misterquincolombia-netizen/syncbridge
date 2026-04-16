const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
// Servir el archivo HTML
app.use(express.static(path.join(__dirname)));

// =============================================
// CONFIGURACION (Railway inyecta esto automaticamente)
// =============================================
const CONFIG = {
  shopifyShop: process.env.SHOP_NAME || '',
  shopifyApiKey: process.env.SHOPIFY_API_KEY || '',
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  dolibarrUrl: process.env.DOLIBARR_URL || '',
  dolibarrApiKey: process.env.DOLIBARR_API_KEY || '',
  dolibarrPayMethod: parseInt(process.env.DOLIBARR_PAY_METHOD || '2', 10),
  integrationActive: true,
};

// =============================================
// LOGS EN MEMORIA
// =============================================
const syncLogs = [];
const syncErrors = [];
let logId = 0;
let errId = 0;

function addLog(tipo, titulo, detalle, orderNum) {
  logId++;
  syncLogs.unshift({ id: logId, tipo, titulo, detalle, orderNum: orderNum || '', fecha: new Date().toISOString() });
  if (syncLogs.length > 500) syncLogs.pop();
  console.log(`[${tipo.toUpperCase()}] ${titulo} — ${detalle}`);
}

function addError(orderNum, tipo, mensaje) {
  errId++;
  syncErrors.unshift({ id: errId, orderNum, tipo, mensaje, resuelto: false, fecha: new Date().toISOString() });
  console.error(`[ERROR] ${orderNum}: ${mensaje}`);
}

// =============================================
// SEGURIDAD: VERIFICAR QUE VIENE DE SHOPIFY
// =============================================
function verifyShopifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !CONFIG.shopifyWebhookSecret) return false;
  try {
    const body = JSON.stringify(req.body);
    const gen = crypto.createHmac('sha256', CONFIG.shopifyWebhookSecret).update(body, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(hmac, 'base64'), Buffer.from(gen, 'base64'));
  } catch (e) { return false; }
}

// =============================================
// CONECTAR CON DOLIBARR (Sin instalar axios)
// =============================================
function dolibarrApi(endpoint, method, data) {
  return new Promise((resolve) => {
    let urlStr = CONFIG.dolibarrUrl + '/' + endpoint;
    let parsedUrl;
    try { parsedUrl = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'URL mala' }); }

    const postData = data ? JSON.stringify(data) : null;
    const mod = parsedUrl.protocol === 'https:' ? https : http;

    const opts = {
      hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search, method: method || 'GET',
      headers: { 'DOLAPIKEY': CONFIG.dolibarrApiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);

    const r = mod.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, data: JSON.parse(body), status: res.statusCode }); }
        catch (e) { resolve({ ok: res.statusCode < 400, data: body, status: res.statusCode }); }
      });
    });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    if (postData) r.write(postData);
    r.end();
  });
}

// =============================================
// LOGICA PRINCIPAL: PROCESAR PEDIDO
// =============================================
async function procesarPedido(order) {
  const num = '#' + (order.order_number || order.id || '?');
  const inicio = Date.now();
  addLog('info', 'Webhook recibido: ' + num, 'Procesando...', num);

  const email = order.email || '';
  const ship = order.shipping_address || {};
  const bill = order.billing_address || {};
  const items = order.line_items || [];
  const total = parseFloat(order.total_price) || 0;
  const pago = order.payment_gateway || '';

  if (!email) { addLog('error', 'Error ' + num, 'Sin email', num); addError(num, 'critical', 'Sin email'); return; }
  if (!items.length) { addLog('error', 'Error ' + num, 'Sin productos', num); addError(num, 'critical', 'Sin productos'); return; }

  const nombre = ((ship.first_name || bill.first_name || '') + ' ' + (ship.last_name || bill.last_name || '')).trim();
  const dir = ship.address1 || bill.address1 || '';
  const city = ship.city || bill.city || '';
  const state = ship.province || bill.province || '';
  const country = ship.country || bill.country || '';
  const zip = ship.zip || bill.zip || '';

  // PASO A: BUSCAR O CREAR CLIENTE
  let clientId;
  const filtroEmail = encodeURIComponent("email='" + email + "'");
  const busq = await dolibarrApi('thirdparties?sortfield=t.ref&sortorder=ASC&limit=100&filter=' + filtroEmail);

  if (busq.ok && Array.isArray(busq.data) && busq.data.length > 0) {
    clientId = busq.data[0].id;
    addLog('info', 'Cliente encontrado: ' + email, 'ID: ' + clientId, num);
  } else {
    addLog('info', 'Creando cliente: ' + email, '', num);
    const crear = await dolibarrApi('thirdparties', 'POST', { name: nombre || email.split('@')[0], email, address: dir, town: city, state, country, zip, client: 1, status: 1 });
    if (crear.ok) { clientId = crear.data; addLog('success', 'Cliente creado: ' + email, 'ID: ' + clientId, num); }
    else { addLog('error', 'Error cliente ' + num, crear.error || 'Desconocido', num); addError(num, 'critical', 'No se pudo crear cliente'); return; }
  }

  // PASO B: MAPEAR PRODUCTOS
  const lineas = [];
  const faltantes = [];
  for (const item of items) {
    const sku = (item.sku || '').trim();
    const qty = parseInt(item.quantity, 10) || 1;
    const precio = parseFloat(item.price) || 0;
    const desc = item.title || 'Sin nombre';

    if (!sku) { faltantes.push('(sin SKU) ' + desc); continue; }

    const filtroSku = encodeURIComponent("t.ref='" + sku + "'");
    const prod = await dolibarrApi('products?sortfield=t.ref&sortorder=ASC&limit=100&filter=' + filtroSku);
    if (prod.ok && Array.isArray(prod.data) && prod.data.length > 0) {
      lineas.push({ fk_product: prod.data[0].id, qty, subprice: precio, desc, product_type: 0 });
    } else {
      faltantes.push(sku + ' — ' + desc);
      addLog('warning', 'SKU no encontrado: ' + sku, desc, num);
    }
  }

  if (lineas.length === 0) { addLog('error', 'Error ' + num, 'Ningun SKU valido', num); addError(num, 'critical', 'Sin SKUs validos'); return; }

  // PASO B2: CREAR PEDIDO
  addLog('info', 'Creando pedido Dolibarr: ' + num, '', num);
  const pedidoRes = await dolibarrApi('orders', 'POST', { socid: clientId, date: Math.floor(new Date(order.created_at).getTime() / 1000), lines: lineas, note_private: 'Shopify ' + num + ' — ' + pago, fk_cond_reglement: CONFIG.dolibarrPayMethod });
  
  if (!pedidoRes.ok) { addLog('error', 'Error pedido ' + num, pedidoRes.error || 'Desconocido', num); addError(num, 'critical', 'No se creo pedido'); return; }
  const pedidoId = pedidoRes.data;
  addLog('success', 'Pedido creado: ' + num, 'ID: ' + pedidoId, num);

  // PASO C: VALIDAR, FACTURAR, PAGAR
  await dolibarrApi('orders/' + pedidoId + '/validate', 'POST', {});
  const factRes = await dolibarrApi('orders/' + pedidoId + '/createinvoicewithdelayedlines', 'POST', {});
  let factId = null;

  if (factRes.ok) {
    factId = factRes.data;
    addLog('success', 'Factura creada: ' + num, 'ID: ' + factId, num);
    await dolibarrApi('invoices/' + factId + '/pay', 'POST', { amount: total, fk_typepayment: CONFIG.dolibarrPayMethod, datepay: Math.floor(Date.now() / 1000), closepaid: 'yes' });
    addLog('success', 'Factura pagada', '$' + total, num);
  } else {
    addLog('warning', 'No se creo factura ' + num, '', num);
  }

  const duracion = Date.now() - inicio;
  if (faltantes.length > 0) { addLog('warning', num + ' Parcial', faltantes.join(', '), num); addError(num, 'warning', 'Parcial: ' + faltantes.join(', ')); }
  else { addLog('success', num + ' COMPLETADO', pedidoId + '/' + factId + ' — ' + duracion + 'ms', num); }
}

// =============================================
// ENDPOINTS
// =============================================
// Webhook de Shopify
app.post('/webhook/shopify/orders-paid', (req, res) => {
  if (!CONFIG.integrationActive) return res.status(200).send('Off');
  if (!verifyShopifyHmac(req)) return res.status(401).send('HMAC invalid');
  res.status(200).send('OK');
  procesarPedido(req.body).catch(e => addLog('error', 'Excepcion', e.message, ''));
});

// APIs para el panel
app.get('/api/stats', (req, res) => res.json({
  pedidos: syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('COMPLETADO')).length,
  facturas: syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('Factura')).length,
  clientes: syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('Cliente creado')).length,
  errores: syncErrors.filter(e => !e.resuelto).length,
}));
app.get('/api/logs', (req, res) => res.json(syncLogs.slice(0, 200)));
app.get('/api/errors', (req, res) => res.json(syncErrors.filter(e => !e.resuelto)));
app.put('/api/errors/:id/resolve', (req, res) => { const e = syncErrors.find(x => x.id == req.params.id); if (e) e.resuelto = true; res.json({ ok: true }); });
app.post('/api/errors/resolve-all', (req, res) => { syncErrors.forEach(e => e.resuelto = true); res.json({ ok: true }); });
app.post('/api/sync/manual', (req, res) => res.json({ ok: true, message: 'Sync manual' }));
app.delete('/api/logs', (req, res) => { syncLogs.length = 0; res.json({ ok: true }); });
app.get('/api/config', (req, res) => res.json({ shopifyShop: CONFIG.shopifyShop, dolibarrUrl: CONFIG.dolibarrUrl.replace(/\/api.*$/, ''), integrationActive: CONFIG.integrationActive }));
app.post('/api/toggle', (req, res) => { CONFIG.integrationActive = !CONFIG.integrationActive; res.json({ active: CONFIG.integrationActive }); });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Puerto dinamico de Railway
const PORT = process.env.PORT || 3099;
app.listen(PORT, () => console.log('SyncBridge corriendo en puerto ' + PORT));
