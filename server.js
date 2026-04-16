const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// =============================================
// LEER CONFIGURACION DESDE .env SIN DEPENDENCIAS
// =============================================
function loadEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equal = trimmed.indexOf('=');
      if (equal > 0) {
        const key = trimmed.substring(0, equal).trim();
        let val = trimmed.substring(equal + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        env[key] = val;
      }
    }
  } catch (err) {
    console.log('[AVISO] No se encontro .env — usando valores por defecto');
  }
  return env;
}

const ENV = loadEnv();

const CONFIG = {
  shopifyShop: ENV.SHOP_NAME || 'mi-tienda',
  shopifyApiKey: ENV.SHOPIFY_API_KEY || '',
  shopifyWebhookSecret: ENV.SHOPIFY_WEBHOOK_SECRET || '',
  dolibarrUrl: ENV.DOLIBARR_URL || '',
  dolibarrApiKey: ENV.DOLIBARR_API_KEY || '',
  dolibarrPayMethod: parseInt(ENV.DOLIBARR_PAY_METHOD || '2', 10),
  alertEmail: ENV.ALERT_EMAIL || '',
  integrationActive: true,
};

// =============================================
// ALMACENAMIENTO DE LOGS Y ERRORES EN MEMORIA
// =============================================
const syncLogs = [];
const syncErrors = [];
let syncCounter = 0;
let errorCounter = 0;

function addLog(tipo, titulo, detalle, orderNum) {
  syncCounter++;
  syncLogs.unshift({
    id: syncCounter,
    tipo: tipo,
    titulo: titulo,
    detalle: detalle,
    orderNum: orderNum || '',
    fecha: new Date().toISOString(),
  });
  if (syncLogs.length > 1000) syncLogs.pop();

  const timestamp = new Date().toLocaleTimeString('es-ES');
  console.log(`[${timestamp}] [${tipo.toUpperCase()}] ${titulo} — ${detalle}`);
}

function addError(orderNum, tipo, mensaje) {
  errorCounter++;
  syncErrors.unshift({
    id: errorCounter,
    orderNum: orderNum,
    tipo: tipo,
    mensaje: mensaje,
    resuelto: false,
    fecha: new Date().toISOString(),
  });
  console.error(`[ERROR] ${orderNum}: ${mensaje}`);
}

// =============================================
// VERIFICAR HMAC DE SHOPIFY (SEGURIDAD)
// =============================================
function verifyShopifyHmac(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !CONFIG.shopifyWebhookSecret) {
    return false;
  }
  try {
    const bodyStr = JSON.stringify(req.body);
    const hmacCalculado = crypto
      .createHmac('sha256', CONFIG.shopifyWebhookSecret)
      .update(bodyStr, 'utf8')
      .digest('base64');

    return crypto.timingSafeEqual(
      Buffer.from(hmacHeader, 'base64'),
      Buffer.from(hmacCalculado, 'base64')
    );
  } catch (err) {
    return false;
  }
}

// =============================================
// LLAMAR A LA API DE DOLIBARR (SIN AXIOS)
// =============================================
function dolibarrApi(endpoint, method, data) {
  return new Promise(function (resolve) {
    let fullUrl = CONFIG.dolibarrUrl + '/' + endpoint;
    let parsedUrl;
    try {
      parsedUrl = new URL(fullUrl);
    } catch (e) {
      return resolve({ ok: false, error: 'URL invalida: ' + fullUrl, status: 0 });
    }

    const postData = data ? JSON.stringify(data) : null;
    const useHttps = parsedUrl.protocol === 'https:';
    const httpModule = useHttps ? https : http;

    const opciones = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (useHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method || 'GET',
      headers: {
        'DOLAPIKEY': CONFIG.dolibarrApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };

    if (postData) {
      opciones.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const reqApi = httpModule.request(opciones, function (res) {
      let cuerpo = '';
      res.on('data', function (chunk) {
        cuerpo += chunk;
      });
      res.on('end', function () {
        try {
          const parseado = JSON.parse(cuerpo);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            data: parseado,
            status: res.statusCode,
          });
        } catch (e) {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            data: cuerpo,
            status: res.statusCode,
          });
        }
      });
    });

    reqApi.on('error', function (err) {
      resolve({ ok: false, error: err.message, status: 0 });
    });

    reqApi.on('timeout', function () {
      reqApi.destroy();
      resolve({ ok: false, error: 'Timeout de conexion (30s)', status: 0 });
    });

    if (postData) reqApi.write(postData);
    reqApi.end();
  });
}

// =============================================
// LOGICA PRINCIPAL: PROCESAR UN PEDIDO COMPLETO
// =============================================
async function procesarPedido(shopifyOrder) {
  const orderNum = '#' + (shopifyOrder.order_number || shopifyOrder.id || 'DESCONOCIDO');
  const tiempoInicio = Date.now();

  addLog('info', 'Webhook recibido: ' + orderNum, 'Topic: orders/paid — Iniciando procesamiento', orderNum);

  // ------------------------------------------
  // EXTRAER DATOS DEL PEDIDO DE SHOPIFY
  // ------------------------------------------
  const email = shopifyOrder.email || '';
  const shipping = shopifyOrder.shipping_address || {};
  const billing = shopifyOrder.billing_address || {};
  const lineItems = shopifyOrder.line_items || [];
  const totalPrecio = parseFloat(shopifyOrder.total_price) || 0;
  const gatewayPago = shopifyOrder.payment_gateway || shopifyOrder.processing_method || 'No especificado';

  // Nombre completo
  const firstName = shipping.first_name || billing.first_name || '';
  const lastName = shipping.last_name || billing.last_name || '';
  const nombreCompleto = (firstName + ' ' + lastName).trim();

  // Direccion de envio (preferida) o facturacion
  const direccion = shipping.address1 || billing.address1 || '';
  const direccion2 = shipping.address2 || billing.address2 || '';
  const ciudad = shipping.city || billing.city || '';
  const provincia = shipping.province || billing.province || '';
  const pais = shipping.country || billing.country || '';
  const codigoPostal = shipping.zip || billing.zip || '';
  const telefono = shopifyOrder.phone || shipping.phone || '';

  // ------------------------------------------
  // VALIDACIONES OBLIGATORIAS
  // ------------------------------------------

  if (!email) {
    const msg = 'El pedido no contiene email de cliente. Imposible identificar al comprador.';
    addLog('error', 'Error critico en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  if (!direccion && !direccion2) {
    const msg = 'El pedido no tiene direccion de envio ni de facturacion. Se procesa con datos incompletos.';
    addLog('warning', 'Datos incompletos en ' + orderNum, msg, orderNum);
    addError(orderNum, 'warning', msg);
  }

  if (!lineItems || lineItems.length === 0) {
    const msg = 'El pedido no tiene lineas de productos.';
    addLog('error', 'Error en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  // ------------------------------------------
  // PASO A: BUSCAR O CREAR CLIENTE EN DOLIBARR
  // ------------------------------------------
  addLog('info', 'Buscando cliente en Dolibarr: ' + email, 'Identificador unico: email', orderNum);

  let dolibarrClientId = null;

  const filtroEmail = encodeURIComponent("email='" + email + "'");
  const resultadoBusqueda = await dolibarrApi(
    'thirdparties?sortfield=t.ref&sortorder=ASC&limit=100&filter=' + filtroEmail,
    'GET'
  );

  if (resultadoBusqueda.ok && Array.isArray(resultadoBusqueda.data) && resultadoBusqueda.data.length > 0) {
    // CLIENTE ENCONTRADO — usar su ID existente
    dolibarrClientId = resultadoBusqueda.data[0].id;
    addLog('info', 'Cliente encontrado: ' + email, 'Dolibarr ThirdParty ID: ' + dolibarrClientId + ' — No se modifica el contacto', orderNum);

  } else {
    // CLIENTE NO ENCONTRADO — crear nuevo
    addLog('info', 'Cliente no encontrado. Creando: ' + email, 'POST /api/index.php/thirdparties', orderNum);

    const datosNuevoCliente = {
      name: nombreCompleto || email.split('@')[0],
      email: email,
      phone: telefono,
      address: (direccion + (direccion2 ? ' ' + direccion2 : '')).trim(),
      town: ciudad,
      state: provincia,
      country: pais,
      zip: codigoPostal,
      client: 1,
      status: 1,
    };

    const resultadoCreacion = await dolibarrApi('thirdparties', 'POST', datosNuevoCliente);

    if (resultadoCreacion.ok) {
      dolibarrClientId = resultadoCreacion.data;
      addLog('success', 'Nuevo cliente creado en Dolibarr', 'ID: ' + dolibarrClientId + ' — ' + nombreCompleto, orderNum);
    } else {
      const msg = 'No se pudo crear el cliente en Dolibarr. Error: ' + (resultadoCreacion.error || resultadoCreacion.data || 'desconocido');
      addLog('error', 'Error creando cliente para ' + orderNum, msg, orderNum);
      addError(orderNum, 'critical', msg);
      return { ok: false, error: msg };
    }
  }

  if (!dolibarrClientId) {
    const msg = 'No se pudo obtener un ID de cliente valido para Dolibarr.';
    addLog('error', 'Error en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  // ------------------------------------------
  // PASO B: MAPEAR PRODUCTOS POR SKU
  // ------------------------------------------
  addLog('info', 'Mapeando productos por SKU: ' + orderNum, lineItems.length + ' linea(s) de producto', orderNum);

  const lineasPedido = [];
  const skusFaltantes = [];

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const sku = (item.sku || '').trim();
    const cantidad = parseInt(item.quantity, 10) || 1;
    const precioUnitario = parseFloat(item.price) || 0;
    const nombreProducto = item.title || item.name || 'Sin nombre';
    const variantTitle = item.variant_title || '';

    const descripcionCompleta = variantTitle ? nombreProducto + ' — ' + variantTitle : nombreProducto;

    // Validar que tenga SKU
    if (!sku) {
      skusFaltantes.push('(sin SKU) ' + descripcionCompleta);
      addLog('warning', 'Item sin SKU omitido', descripcionCompleta, orderNum);
      continue;
    }

    // Buscar producto en Dolibarr por referencia (SKU)
    const filtroSku = encodeURIComponent("t.ref='" + sku + "'");
    const resultadoProd = await dolibarrApi(
      'products?sortfield=t.ref&sortorder=ASC&limit=100&filter=' + filtroSku,
      'GET'
    );

    if (resultadoProd.ok && Array.isArray(resultadoProd.data) && resultadoProd.data.length > 0) {
      const productoDolibarr = resultadoProd.data[0];
      lineasPedido.push({
        fk_product: productoDolibarr.id,
        qty: cantidad,
        subprice: precioUnitario,
        desc: descripcionCompleta,
        product_type: 0,
        tva_tx: productoDolibarr.tva_tx || 0,
      });
      addLog('info', 'SKU encontrado: ' + sku, productoDolibarr.label + ' (ID: ' + productoDolibarr.id + ')', orderNum);
    } else {
      // SKU NO ENCONTRADO — registrar error pero CONTINUAR con los demas
      skusFaltantes.push(sku + ' — ' + descripcionCompleta);
      addLog('warning', 'SKU NO encontrado en Dolibarr: ' + sku, 'Producto: ' + descripcionCompleta + ' — Se omitira esta linea', orderNum);
    }
  }

  // Verificar que al menos un producto fue mapeado
  if (lineasPedido.length === 0) {
    const msg = 'Ningun SKU del pedido existe en el catalogo de Dolibarr. SKUs faltantes: ' + skusFaltantes.join(' | ');
    addLog('error', 'Error critico en ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  if (skusFaltantes.length > 0) {
    addLog('warning', orderNum + ' tiene SKUs faltantes', 'Se continuara con ' + lineasPedido.length + ' de ' + lineItems.length + ' lineas. Faltantes: ' + skusFaltantes.join(', '), orderNum);
  }

  // ------------------------------------------
  // PASO B2: CREAR EL PEDIDO DE VENTA EN DOLIBARR
  // ------------------------------------------
  addLog('info', 'Creando pedido de venta en Dolibarr: ' + orderNum, 'Cliente ID: ' + dolibarrClientId + ' — ' + lineasPedido.length + ' lineas', orderNum);

  const datosPedido = {
    socid: dolibarrClientId,
    date: Math.floor(new Date(shopifyOrder.created_at).getTime() / 1000),
    lines: lineasPedido,
    note_private: 'Pedido Shopify ' + orderNum + ' — Metodo de pago: ' + gatewayPago,
    note_public: 'Pedido realizado en tienda online Shopify — ' + orderNum,
    fk_cond_reglement: CONFIG.dolibarrPayMethod,
  };

  const resultadoPedido = await dolibarrApi('orders', 'POST', datosPedido);

  if (!resultadoPedido.ok) {
    const msg = 'Error al crear pedido en Dolibarr. Detalle: ' + (resultadoPedido.error || JSON.stringify(resultadoPedido.data) || 'desconocido');
    addLog('error', 'Error creando pedido para ' + orderNum, msg, orderNum);
    addError(orderNum, 'critical', msg);
    return { ok: false, error: msg };
  }

  const dolibarrPedidoId = resultadoPedido.data;
  addLog('success', 'Pedido de venta creado en Dolibarr', 'ID: ' + dolibarrPedidoId + ' para ' + orderNum, orderNum);

  // ------------------------------------------
  // PASO C1: VALIDAR EL PEDIDO
  // ------------------------------------------
  addLog('info', 'Validando pedido ' + dolibarrPedidoId, 'POST /orders/' + dolibarrPedidoId + '/validate', orderNum);

  const resultadoValidacion = await dolibarrApi('orders/' + dolibarrPedidoId + '/validate', 'POST', {});

  if (resultadoValidacion.ok) {
    addLog('success', 'Pedido validado correctamente', 'ID: ' + dolibarrPedidoId, orderNum);
  } else {
    addLog('warning', 'No se pudo validar el pedido ' + dolibarrPedidoId, (resultadoValidacion.error || 'El pedido pudo haberse creado como borrador'), orderNum);
  }

  // ------------------------------------------
  // PASO C2: GENERAR FACTURA DESDE EL PEDIDO
  // ------------------------------------------
  addLog('info', 'Generando factura para pedido ' + dolibarrPedidoId, 'POST /orders/' + dolibarrPedidoId + '/createinvoicewithdelayedlines', orderNum);

  const resultadoFactura = await dolibarrApi(
    'orders/' + dolibarrPedidoId + '/createinvoicewithdelayedlines',
    'POST',
    {}
  );

  let dolibarrFacturaId = null;

  if (resultadoFactura.ok) {
    dolibarrFacturaId = resultadoFactura.data;
    addLog('success', 'Factura generada correctamente', 'ID: ' + dolibarrFacturaId + ' desde pedido ' + dolibarrPedidoId, orderNum);

    // ------------------------------------------
    // PASO C3: MARCAR FACTURA COMO PAGADA
    // ------------------------------------------
    addLog('info', 'Marcando factura ' + dolibarrFacturaId + ' como pagada', 'Monto: $' + totalPrecio, orderNum);

    const datosPago = {
      amount: totalPrecio,
      fk_typepayment: CONFIG.dolibarrPayMethod,
      datepay: Math.floor(Date.now() / 1000),
      closepaid: 'yes',
      note_private: 'Pago automatico desde Shopify — Pedido ' + orderNum + ' — ' + gatewayPago,
    };

    const resultadoPago = await dolibarrApi('invoices/' + dolibarrFacturaId + '/pay', 'POST', datosPago);

    if (resultadoPago.ok) {
      addLog('success', 'Factura marcada como pagada', 'Factura ID: ' + dolibarrFacturaId + ' — $' + totalPrecio, orderNum);
    } else {
      addLog('warning', 'No se pudo marcar la factura como pagada', 'Factura ID: ' + dolibarrFacturaId + ' — Error: ' + (resultadoPago.error || 'desconocido') + ' — Se creara como borrador pendiente', orderNum);
    }
  } else {
    addLog('warning', 'No se pudo generar la factura para ' + orderNum, 'Error: ' + (resultadoFactura.error || JSON.stringify(resultadoFactura.data)) + ' — El pedido existe pero sin factura asociada', orderNum);
  }

  // ------------------------------------------
  // RESULTADO FINAL
  // ------------------------------------------
  const duracionTotal = Date.now() - tiempoInicio;

  if (skusFaltantes.length > 0) {
    const msg = 'Sincronizacion PARCIAL de ' + orderNum + '. Se omitieron ' + skusFaltantes.length + ' producto(s) con SKU inexistente: ' + skusFaltantes.join(' | ');
    addLog('warning', orderNum + ' sincronizado parcialmente', 'Pedido: ' + dolibarrPedidoId + ' — Factura: ' + (dolibarrFacturaId || 'No generada') + ' — ' + duracionTotal + 'ms', orderNum);
    addError(orderNum, 'warning', msg);
    return { ok: 'partial', pedidoId: dolibarrPedidoId, facturaId: dolibarrFacturaId, duracion: duracionTotal, skusFaltantes: skusFaltantes };
  }

  addLog('success', orderNum + ' sincronizado COMPLETAMENTE', 'Pedido Dolibarr: ' + dolibarrPedidoId + ' — Factura: ' + (dolibarrFacturaId || 'No generada') + ' — ' + duracionTotal + 'ms', orderNum);

  return {
    ok: true,
    pedidoId: dolibarrPedidoId,
    facturaId: dolibarrFacturaId,
    duracion: duracionTotal,
  };
}

// =============================================
// ENDPOINT: WEBHOOK DE SHOPIFY
// Shopify envia los pedidos aqui
// =============================================
app.post('/webhook/shopify/orders-paid', function (req, res) {
  // Verificar que la integracion este activa
  if (!CONFIG.integrationActive) {
    console.log('[WEBHOOK] Recibido pero integracion desactivada — ignorando');
    return res.status(200).send('Integration off');
  }

  // Verificar que el webhook viene realmente de Shopify (HMAC)
  if (!verifyShopifyHmac(req)) {
    console.log('[WEBHOOK] HMAC invalido — posible falsificacion — rechazado');
    addLog('error', 'SEGURIDAD: HMAC invalido', 'Un webhook fue recibido pero la firma no coincide con Shopify — posible ataque', '');
    return res.status(401).send('Invalid HMAC');
  }

  // Responder 200 OK inmediatamente (Shopify necesita respuesta rapida)
  res.status(200).send('OK');

  // Procesar el pedido de forma asincrona
  procesarPedido(req.body).catch(function (err) {
    addLog('error', 'Excepcion no capturada', err.message + ' — ' + (err.stack || ''), '#' + (req.body.order_number || 'desconocido'));
    addError('#' + (req.body.order_number || 'desconocido'), 'critical', 'Excepcion del sistema: ' + err.message);
  });
});

// Webhook alternativo para pedidos completados
app.post('/webhook/shopify/orders-fulfilled', function (req, res) {
  if (!CONFIG.integrationActive) return res.status(200).send('Off');
  if (!verifyShopifyHmac(req)) return res.status(401).send('Invalid HMAC');
  res.status(200).send('OK');
  const num = '#' + (req.body.order_number || req.body.id || '?');
  addLog('info', 'Pedido completado/fulfilled: ' + num, 'Evento recibido — no requiere accion adicional', num);
});

// =============================================
// ENDPOINT: SERVIR EL PANEL HTML
// =============================================
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================
// ENDPOINTS: API REST PARA EL PANEL FRONTAL
// =============================================

// Estadisticas generales
app.get('/api/stats', function (req, res) {
  const pedidosExitosos = syncLogs.filter(function (l) {
    return l.tipo === 'success' && (l.titulo.includes('completamente') || l.titulo.includes('COMPLETAMENTE'));
  }).length;

  const facturasCreadas = syncLogs.filter(function (l) {
    return l.tipo === 'success' && l.titulo.includes('Factura');
  }).length;

  const clientesNuevos = syncLogs.filter(function (l) {
    return l.tipo === 'success' && l.titulo.includes('cliente creado');
  }).length;

  const erroresPendientes = syncErrors.filter(function (e) {
    return !e.resuelto;
  }).length;

  res.json({
    pedidos: pedidosExitosos,
    facturas: facturasCreadas,
    clientes: clientesNuevos,
    errores: erroresPendientes,
  });
});

// Obtener todos los logs
app.get('/api/logs', function (req, res) {
  const limite = parseInt(req.query.limit, 10) || 200;
  res.json(syncLogs.slice(0, limite));
});

// Obtener errores pendientes
app.get('/api/errors', function (req, res) {
  const pendientes = syncErrors.filter(function (e) { return !e.resuelto; });
  res.json(pendientes);
});

// Marcar un error como resuelto
app.put('/api/errors/:id/resolve', function (req, res) {
  const idBuscado = parseInt(req.params.id, 10);
  const errorEncontrado = syncErrors.find(function (e) { return e.id === idBuscado; });
  if (errorEncontrado) {
    errorEncontrado.resuelto = true;
    res.json({ ok: true, message: 'Error marcado como resuelto' });
  } else {
    res.status(404).json({ ok: false, message: 'Error no encontrado' });
  }
});

// Resolver todos los errores
app.post('/api/errors/resolve-all', function (req, res) {
  syncErrors.forEach(function (e) { e.resuelto = true; });
  res.json({ ok: true, message: 'Todos los errores resueltos' });
});

// Sincronizacion manual (informacion)
app.post('/api/sync/manual', function (req, res) {
  res.json({ ok: true, message: 'La sincronizacion manual busca pedidos pendientes en Shopify. En modo webhook, los pedidos llegan automaticamente.' });
});

// Limpiar todos los logs
app.delete('/api/logs', function (req, res) {
  syncLogs.length = 0;
  syncCounter = 0;
  res.json({ ok: true, message: 'Logs eliminados' });
});

// Obtener configuracion (sin exponer credenciales completas)
app.get('/api/config', function (req, res) {
  res.json({
    shopifyShop: CONFIG.shopifyShop,
    shopifyApiKey: CONFIG.shopifyApiKey ? CONFIG.shopifyApiKey.substring(0, 10) + '...' : 'No configurada',
    dolibarrUrl: CONFIG.dolibarrUrl ? CONFIG.dolibarrUrl.replace(/\/api.*$/, '') : 'No configurada',
    dolibarrApiKey: CONFIG.dolibarrApiKey ? CONFIG.dolibarrApiKey.substring(0, 6) + '...' : 'No configurada',
    integrationActive: CONFIG.integrationActive,
  });
});

// Activar o desactivar la integracion
app.post('/api/toggle', function (req, res) {
  CONFIG.integrationActive = !CONFIG.integrationActive;
  addLog('info', 'Integracion ' + (CONFIG.integrationActive ? 'ACTIVADA' : 'DESACTIVADA'), 'Cambio realizado por el administrador', '');
  res.json({ active: CONFIG.integrationActive });
});

// Health check
app.get('/api/health', function (req, res) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    integrationActive: CONFIG.integrationActive,
    logsCount: syncLogs.length,
    errorsCount: syncErrors.filter(function (e) { return !e.resuelto; }).length,
    memoryUsage: process.memoryUsage(),
  });
});

// =============================================
// INICIAR SERVIDOR
// =============================================
const PORT = process.env.PORT || 3099;
app.listen(PORT, function () {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         SyncBridge v1.0 — ACTIVO         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Puerto:       ' + String(PORT).padEnd(26) + '║');
  console.log('║  Shopify:      ' + (CONFIG.shopifyShop || 'No configurado').padEnd(26) + '║');
  console.log('║  Dolibarr:     ' + (CONFIG.dolibarrUrl ? 'Configurado' : 'No configurado').padEnd(26) + '║');
  console.log('║  Integracion:  ' + (CONFIG.integrationActive ? 'ACTIVADA' : 'DESACTIVADA').padEnd(26) + '║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Webhook URL: https://TU-DOMINIO.com/webhook/shopify/orders-paid');
  console.log('Panel URL:    https://TU-DOMINIO.com/');
  console.log('');
});
