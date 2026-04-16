const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

// =============================================
// CONFIGURACION — Railway lee estas variables de entorno
// =============================================
const CONFIG = {
  shopifyShop: process.env.SHOP_NAME || 'mi-tienda',
  shopifyApiKey: process.env.SHOPIFY_API_KEY || '',
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  dolibarrUrl: process.env.DOLIBARR_URL || '',
  dolibarrApiKey: process.env.DOLIBARR_API_KEY || '',
  dolibarrPayMethod: parseInt(process.env.PAY_METHOD || '2'),
  alertEmail: process.env.ALERT_EMAIL || '',
  integrationActive: true,
};

// =============================================
// LOGS EN MEMORIA (simple, sin base de datos)
// =============================================
const syncLogs = [];
const syncErrors = [];

function addLog(tipo, titulo, detalle, orderNum) {
  syncLogs.unshift({
    id: syncLogs.length + 1,
    tipo, titulo, detalle, orderNum: orderNum || '',
    fecha: new Date().toISOString()
  });
  if (syncLogs.length > 500) syncLogs.pop();
}

function addError(orderNum, tipo, mensaje) {
  syncErrors.unshift({
    id: syncErrors.length + 1,
    orderNum, tipo, mensaje,
    resuelto: false,
    fecha: new Date().toISOString()
  });
}

// =============================================
// VERIFICAR QUE EL WEBHOOK VIENE DE SHOPIFY
// =============================================
function verifyShopifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !CONFIG.shopifyWebhookSecret) return false;
  try {
    const body = JSON.stringify(req.body);
    const generated = crypto
      .createHmac('sha256', CONFIG.shopifyWebhookSecret)
      .update(body, 'utf8')
      .digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'base64'),
      Buffer.from(generated, 'base64')
    );
  } catch (e) {
    return false;
  }
}

// =============================================
// LLAMAR A LA API DE DOLIBARR
// =============================================
function dolibarrApi(endpoint, method, data) {
  return new Promise((resolve) => {
    const urlStr = CONFIG.dolibarrUrl + '/' + endpoint;
    const url = new URL(urlStr);
    const postData = data ? JSON.stringify(data) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: {
        'DOLAPIKEY': CONFIG.dolibarrApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ success: true, data: parsed, status: res.statusCode });
        } catch (e) {
          resolve({ success: res.statusCode < 400, data: body, status: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message, status: 0 });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout', status: 0 });
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// =============================================
// LOGICA PRINCIPAL — PROCESAR UN PEDIDO
// =============================================
async function procesarPedido(shopifyOrder) {
  const orderNum = '#' + (shopifyOrder.order_number || shopifyOrder.id);
  const inicio = Date.now();

  addLog('info', 'Webhook recibido: ' + orderNum, 'Topic: orders/paid', orderNum);

  // --- EXTRAER DATOS ---
  const email = shopifyOrder.email || '';
  const shipping = shopifyOrder.shipping_address || {};
  const billing = shopifyOrder.billing_address || {};
  const lineItems = shopifyOrder.line_items || [];

  // Validar email
  if (!email) {
    const msg = 'Pedido sin email de cliente — imposible identificar';
    addLog('error', 'Error en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  // Validar direccion
  if (!shipping.address1 && !billing.address1) {
    addLog('warning', 'Sin direccion en ' + orderNum, 'Se procesa igualmente', orderNum);
  }

  const nombre = (shipping.first_name || billing.first_name || '') + ' ' +
                 (shipping.last_name || billing.last_name || '');
  const dir = shipping.address1 || billing.address1 || '';
  const ciudad = shipping.city || billing.city || '';
  const provincia = shipping.province || billing.province || '';
  const pais = shipping.country || billing.country || '';
  const cp = shipping.zip || billing.zip || '';

  // --- PASO A: BUSCAR O CREAR CLIENTE ---
  addLog('info', 'Buscando cliente: ' + email, '', orderNum);

  let clientId;

  const busqueda = await dolibarrApi(
    'thirdparties?sortfield=t.ref&sortorder=ASC&limit=100&filter=' +
    encodeURIComponent('email=\'' + email + '\''),
    'GET'
  );

  if (busqueda.success && Array.isArray(busqueda.data) && busqueda.data.length > 0) {
    clientId = busqueda.data[0].id;
    addLog('info', 'Cliente encontrado: ' + email, 'Dolibarr ID: ' + clientId, orderNum);
  } else {
    addLog('info', 'Creando cliente: ' + email, '', orderNum);

    const nuevoCliente = await dolibarrApi('thirdparties', 'POST', {
      name: nombre.trim() || email.split('@')[0],
      email: email,
      address: dir,
      town: ciudad,
      state: provincia,
      country: pais,
      zip: cp,
      client: 1,
      status: 1,
    });

    if (nuevoCliente.success) {
      clientId = nuevoCliente.data;
      addLog('success', 'Cliente creado: ' + email, 'Dolibarr ID: ' + clientId, orderNum);
    } else {
      const msg = 'No se pudo crear cliente: ' + (nuevoCliente.error || 'error desconocido');
      addLog('error', 'Error cliente en ' + orderNum, msg, orderNum);
      addError(orderNum, 'critical', msg);
      return { ok: false, error: msg };
    }
  }

  // --- PASO B: CREAR PEDIDO CON LINEAS ---
  addLog('info', 'Creando pedido en Dolibarr: ' + orderNum, 'Cliente: ' + clientId, orderNum);

  const lineas = [];
  let skusFaltantes = [];

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const sku = item.sku || '';
    const qty = item.quantity || 1;
    const precio = parseFloat(item.price) || 0;

    if (!sku) {
      skusFaltantes.push('(sin SKU) ' + item.title);
      continue;
    }

    const buscarProd = await dolibarrApi(
      'products?sortfield=t.ref&sortorder=ASC&limit=100&filter=' +
      encodeURIComponent('t.ref=\'' + sku + '\''),
      'GET'
    );

    if (buscarProd.success && Array.isArray(buscarProd.data) && buscarProd.data.length > 0) {
      lineas.push({
        fk_product: buscarProd.data[0].id,
        qty: qty,
        subprice: precio,
        desc: item.title,
        product_type: 0,
      });
    } else {
      skusFaltantes.push(sku + ' — ' + item.title);
      addLog('warning', 'SKU no encontrado: ' + sku, item.title, orderNum);
    }
  }

  if (lineas.length === 0) {
    const msg = 'Ningun SKU existe en Dolibarr. Faltantes: ' + skusFaltantes.join(', ');
    addLog('error', 'Error en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  const crearPedido = await dolibarrApi('orders', 'POST', {
    socid: clientId,
    date: Math.floor(new Date(shopifyOrder.created_at).getTime() / 1000),
    lines: lineas,
    note_private: 'Shopify ' + orderNum + ' — Pago: ' + (shopifyOrder.payment_gateway || ''),
    fk_cond_reglement: CONFIG.dolibarrPayMethod,
  });

  if (!crearPedido.success) {
    const msg = 'Error creando pedido: ' + (crearPedido.error || 'desconocido');
    addLog('error', 'Error en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  const pedidoId = crearPedido.data;
  addLog('success', 'Pedido creado: ' + orderNum, 'Dolibarr ID: ' + pedidoId, orderNum);

  // --- PASO C: VALIDAR Y CREAR FACTURA ---
  await dolibarrApi('orders/' + pedidoId + '/validate', 'POST', {});

  const factura = await dolibarrApi(
    'orders/' + pedidoId + '/createinvoicewithdelayedlines', 'POST', {}
  );

  let facturaId = null;
  if (factura.success) {
    facturaId = factura.data;
    addLog('success', 'Factura creada: ' + orderNum, 'Dolibarr ID: ' + facturaId, orderNum);

    const total = parseFloat(shopifyOrder.total_price) || 0;
    await dolibarrApi('invoices/' + facturaId + '/pay', 'POST', {
      amount: total,
      fk_typepayment: CONFIG.dolibarrPayMethod,
      datepay: Math.floor(Date.now() / 1000),
      note: 'Pago auto Shopify ' + orderNum,
    });
    addLog('success', 'Factura pagada: ' + facturaId, '$' + total, orderNum);
  }

  // --- RESULTADO ---
  const duracion = Date.now() - inicio;

  if (skusFaltantes.length > 0) {
    const msg = 'Parcial. SKUs faltantes: ' + skusFaltantes.join(', ');
    addLog('warning', orderNum + ' parcial', msg, orderNum);
    addError(orderNum, 'warning', msg);
    return { ok: 'partial', pedidoId, facturaId, duracion };
  }

  addLog('success', orderNum + ' completado', pedidoId + ' / ' + facturaId + ' — ' + duracion + 'ms', orderNum);
  return { ok: true, pedidoId, facturaId, duracion };
}

// =============================================
// WEBHOOK — LO QUE SHOPIFY LLAMA
// =============================================
app.post('/webhook/shopify/orders-paid', (req, res) => {
  if (!CONFIG.integrationActive) return res.status(200).send('Off');
  if (!verifyShopifyHmac(req)) {
    addLog('error', 'HMAC invalido', 'Webhook rechazado — posible falsificacion', '');
    return res.status(401).send('HMAC invalid');
  }
  res.status(200).send('OK');
  procesarPedido(req.body).catch((err) => {
    addLog('error', 'Excepcion', err.message, '');
  });
});

// =============================================
// SERVIR EL PANEL HTML
// =============================================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.get('/index.html', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// =============================================
// API PARA EL PANEL
// =============================================
app.get('/api/stats', (req, res) => {
  const pedidos = syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('completado')).length;
  const facturas = syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('Factura')).length;
  const clientes = syncLogs.filter(l => l.tipo === 'success' && l.titulo.includes('Cliente creado')).length;
  const errores = syncErrors.filter(e => !e.resuelto).length;
  res.json({ pedidos, facturas, clientes, errores });
});

app.get('/api/logs', (req, res) => {
  res.json(syncLogs.slice(0, 200));
});

app.get('/api/errors', (req, res) => {
  res.json(syncErrors.filter(e => !e.resuelto));
});

app.put('/api/errors/:id/resolve', (req, res) => {
  const err = syncErrors.find(e => e.id == req.params.id);
  if (err) err.resuelto = true;
  res.json({ ok: true });
});

app.post('/api/sync/manual', (req, res) => {
  res.json({ ok: true, message: 'No hay pedidos pendientes' });
});

app.delete('/api/logs', (req, res) => {
  syncLogs.length = 0;
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({
    shopifyShop: CONFIG.shopifyShop,
    dolibarrUrl: CONFIG.dolibarrUrl.replace(/\/api.*$/, ''),
    integrationActive: CONFIG.integrationActive,
  });
});

app.post('/api/toggle', (req, res) => {
  CONFIG.integrationActive = !CONFIG.integrationActive;
  res.json({ active: CONFIG.integrationActive });
});

// =============================================
// INICIAR
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('SyncBridge corriendo en puerto ' + PORT);
});
