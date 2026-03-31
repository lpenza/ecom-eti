const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Importar servicios
const supabaseService = require('./services/supabaseService');
const uesService = require('./services/uesService');
const shopifyService = require('./services/shopifyService');
const notificationService = require('./services/notificationService');
const logService = require('./services/logService');

// Rutas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Obtener pedidos activos (pendientes + etiqueta generada, excluye procesados)
app.get('/api/pedidos', async (req, res) => {
  try {
    console.log('📥 GET /api/pedidos - Obteniendo pedidos...');
    const pedidos = await supabaseService.obtenerPedidosActivos();
    
    console.log(`📊 Pedidos obtenidos: ${pedidos ? pedidos.length : 0}`);
    
    // Asegurar que siempre devolvemos un array
    const pedidosArray = Array.isArray(pedidos) ? pedidos : [];
    
    console.log(`✅ Enviando ${pedidosArray.length} pedidos al cliente`);
    res.json(pedidosArray);
  } catch (error) {
    console.error('❌ Error en /api/pedidos:', error.message);
    logService.error('Error al obtener pedidos', error);
    // En caso de error, devolver array vacío en lugar de objeto
    res.status(500).json([]);
  }
});

// Login en UES
app.post('/api/ues/login', async (req, res) => {
  try {
    console.log('🔐 Intentando login en UES...');
    const token = await uesService.autenticarManual();
    logService.info('Login exitoso en UES');
    res.json({ success: true, token: token ? 'authenticated' : null });
  } catch (error) {
    logService.error('Error al hacer login en UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estado de autenticación UES
app.get('/api/ues/status', (req, res) => {
  const isAuthenticated = uesService.token != null;
  res.json({ authenticated: isAuthenticated });
});

// Vista previa de payloads UES (sin enviar a UES)
app.get('/api/ues/payload-preview/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const preview = await uesService.construirPayloadsUes(pedido);
    res.json({ success: true, data: preview });
  } catch (error) {
    logService.error('Error al construir preview payload UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ues/catalog/departamentos', async (req, res) => {
  try {
    const data = await supabaseService.obtenerDepartamentosUes();
    res.json({ success: true, data });
  } catch (error) {
    logService.error('Error obteniendo catalogo de departamentos UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ues/catalog/localidades', async (req, res) => {
  try {
    const departamentoId = req.query.departamento_id || null;
    const data = await supabaseService.obtenerLocalidadesUes(departamentoId);
    res.json({ success: true, data });
  } catch (error) {
    logService.error('Error obteniendo catalogo de localidades UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar con Shopify (alias para React)
app.post('/api/sync-shopify', async (req, res) => {
  try {
    const ordenes = await shopifyService.obtenerOrdenes();
    const resultado = await supabaseService.sincronizarOrdenes(ordenes);
    logService.info(`Sincronizados ${resultado.length} pedidos desde Shopify`);
    res.json({ success: true, count: resultado.length });
  } catch (error) {
    logService.error('Error al sincronizar Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar con Shopify (ruta legacy)
app.post('/api/sincronizar-shopify', async (req, res) => {
  try {
    const ordenes = await shopifyService.obtenerOrdenes();
    const resultado = await supabaseService.sincronizarOrdenes(ordenes);
    logService.info(`Sincronizados ${resultado.length} pedidos desde Shopify`);
    res.json({ success: true, data: resultado });
  } catch (error) {
    logService.error('Error al sincronizar Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function handleFulfillmentShopify(req, res) {
  try {
    const { pedidoIds, notifyEmail = true, notifyWhatsApp = true } = req.body || {};

    let pedidos = [];
    if (Array.isArray(pedidoIds) && pedidoIds.length > 0) {
      const pedidosEncontrados = await Promise.all(
        pedidoIds.map((pedidoId) => supabaseService.obtenerPedido(pedidoId))
      );
      pedidos = pedidosEncontrados.filter(Boolean);
    } else {
      pedidos = await supabaseService.obtenerPedidosParaFulfillment();
    }

    const candidatos = pedidos.filter(
      (p) => (p.shopify_order_id || p.numero_pedido) && p.numero_seguimiento_ues
    );

    const resultados = [];

    for (const pedido of candidatos) {
      try {
        // Resolver shopify_order_id si no está guardado en DB
        let shopifyOrderId = pedido.shopify_order_id;
        if (!shopifyOrderId && pedido.numero_pedido) {
          shopifyOrderId = await shopifyService.obtenerIdPorNumeroPedido(pedido.numero_pedido);
          if (!shopifyOrderId) {
            throw new Error(`No se encontró la orden #${pedido.numero_pedido} en Shopify`);
          }
        }

        const fulfillment = await shopifyService.marcarComoCumplida(
          shopifyOrderId,
          pedido.numero_seguimiento_ues
        );

        await supabaseService.actualizarPedido(pedido.id, {
          estado: 'enviado',
          notificacion_enviada_at: new Date().toISOString(),
        });

        resultados.push({
          pedidoId: pedido.id,
          shopifyOrderId,
          success: true,
          fulfillmentId: fulfillment?.id || null,
        });
      } catch (error) {
        resultados.push({
          pedidoId: pedido.id,
          shopifyOrderId: pedido.shopify_order_id || null,
          success: false,
          error: error.message,
        });
      }
    }

    const successCount = resultados.filter((r) => r.success).length;
    const failCount = resultados.length - successCount;

    let notificationSuccessCount = 0;
    let notificationFailCount = 0;

    for (const result of resultados) {
      if (!result.success) continue;
      const pedido = candidatos.find((p) => p.id === result.pedidoId);
      if (!pedido) continue;

      const notification = await notificationService.notificarTracking(pedido, {
        trackingNumber: pedido.numero_seguimiento_ues,
        sendEmail: notifyEmail,
        sendWhatsApp: notifyWhatsApp,
      });

      result.notification = notification;

      if (notification.anySent || notification.handledByShopifyEmail) {
        notificationSuccessCount += 1;
        // Actualizar timestamp de notificación
        await supabaseService.actualizarPedido(pedido.id, {
          notificacion_enviada_at: new Date().toISOString(),
        });
      } else {
        notificationFailCount += 1;
      }
    }

    logService.info(`Fulfillment Shopify ejecutado: ${successCount} OK, ${failCount} error`);

    res.json({
      success: true,
      count: resultados.length,
      successCount,
      failCount,
      notificationSuccessCount,
      notificationFailCount,
      data: resultados,
    });
  } catch (error) {
    logService.error('Error en fulfillment Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Ejecutar fulfillment en Shopify para pedidos con etiqueta generada
app.post('/api/fulfillment-shopify', handleFulfillmentShopify);

// Alias legacy con typo historico (.NET): fullfilment
app.post('/api/fullfilment-shopify', handleFulfillmentShopify);

// Reintentar notificacion de tracking para un pedido puntual
app.post('/api/notificar-tracking/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const { sendEmail = true, sendWhatsApp = true } = req.body || {};

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    if (!pedido.numero_seguimiento_ues) {
      return res.status(400).json({ success: false, error: 'Pedido sin numero de seguimiento' });
    }

    const notification = await notificationService.notificarTracking(pedido, {
      trackingNumber: pedido.numero_seguimiento_ues,
      sendEmail,
      sendWhatsApp,
    });

    res.json({
      success: true,
      pedidoId,
      notification,
    });
  } catch (error) {
    logService.error('Error al notificar tracking', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar pedido como notificado (para envios manuales de WhatsApp)
app.post('/api/marcar-notificado/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    await supabaseService.actualizarPedido(pedidoId, {
      notificacion_enviada_at: new Date().toISOString(),
    });

    logService.info(`Pedido ${pedidoId} marcado como notificado (WhatsApp manual)`);

    res.json({
      success: true,
      pedidoId,
      notificacion_enviada_at: new Date().toISOString(),
    });
  } catch (error) {
    logService.error('Error al marcar pedido como notificado', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generar etiqueta UES (con ID en URL para React)
app.post('/api/generar-etiqueta/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const { payloadOverrides } = req.body || {};
    
    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    logService.info(`Generando etiqueta para pedido ${pedidoId}`);

    // Generar etiqueta en UES
    const etiqueta = await uesService.generarEtiqueta(pedido, payloadOverrides || null);
    
    // Actualizar pedido en Supabase
    await supabaseService.actualizarPedido(pedidoId, {
      estado: 'pendiente',
      numero_seguimiento_ues: etiqueta.numeroSeguimiento,
      link_etiqueta_drive: etiqueta.urlPdf,
      etiqueta_generada: true,
      etiqueta_impresa: false
    });

    logService.info(`Etiqueta generada exitosamente para pedido ${pedidoId}: ${etiqueta.numeroSeguimiento}`);
    
    // Respuesta en formato que React espera
    res.json({ 
      success: true, 
      pedidoId,
      tracking: etiqueta.numeroSeguimiento,
      pdfUrl: etiqueta.urlPdf
    });
  } catch (error) {
    logService.error('Error al generar etiqueta', { 
      error: error.message,
      stack: error.stack 
    });
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Generar etiqueta UES (ruta legacy con body)
app.post('/api/generar-etiqueta', async (req, res) => {
  try {
    const { pedidoId, payloadOverrides } = req.body || {};
    
    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    logService.info(`Generando etiqueta para pedido ${pedidoId}`);

    // Generar etiqueta en UES
    const etiqueta = await uesService.generarEtiqueta(pedido, payloadOverrides || null);
    
    // Actualizar pedido en Supabase
    await supabaseService.actualizarPedido(pedidoId, {
      estado: 'pendiente',
      numero_seguimiento_ues: etiqueta.numeroSeguimiento,
      link_etiqueta_drive: etiqueta.urlPdf,
      etiqueta_generada: true,
      etiqueta_impresa: false
    });

    logService.info(`Etiqueta generada exitosamente para pedido ${pedidoId}: ${etiqueta.numeroSeguimiento}`);
    res.json({ success: true, data: etiqueta });
  } catch (error) {
    logService.error('Error al generar etiqueta', { 
      error: error.message,
      stack: error.stack 
    });
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Generar múltiples etiquetas
app.post('/api/generar-etiquetas-masivo', async (req, res) => {
  try {
    const { pedidoIds } = req.body;
    const resultados = [];
    
    for (const pedidoId of pedidoIds) {
      try {
        const pedido = await supabaseService.obtenerPedido(pedidoId);
        const etiqueta = await uesService.generarEtiqueta(pedido);
        
        await supabaseService.actualizarPedido(pedidoId, {
          estado: 'pendiente',
          numero_seguimiento_ues: etiqueta.numeroSeguimiento,
          link_etiqueta_drive: etiqueta.urlPdf,
          etiqueta_generada: true,
          etiqueta_impresa: false
        });
        
        resultados.push({ pedidoId, success: true, etiqueta });
      } catch (error) {
        resultados.push({ pedidoId, success: false, error: error.message });
        logService.error(`Error en pedido ${pedidoId}`, error);
      }
    }
    
    logService.info(`Procesados ${resultados.length} pedidos en modo masivo`);
    res.json({ success: true, data: resultados });
  } catch (error) {
    logService.error('Error en generación masiva', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Descargar etiqueta
app.get('/api/descargar-etiqueta/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido || !pedido.url_etiqueta) {
      return res.status(404).json({ success: false, error: 'Etiqueta no encontrada' });
    }

    const pdfBuffer = await uesService.descargarEtiqueta(pedido.url_etiqueta);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiqueta_${pedidoId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    logService.error('Error al descargar etiqueta', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Validar dirección con Google Maps
app.post('/api/validar-direccion', async (req, res) => {
  try {
    const { direccion } = req.body;
    const axios = require('axios');
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: direccion,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    
    res.json({ success: true, data: response.data });
  } catch (error) {
    logService.error('Error al validar dirección', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener estadísticas
app.get('/api/estadisticas', async (req, res) => {
  try {
    const stats = await supabaseService.obtenerEstadisticas();
    res.json({ success: true, data: stats });
  } catch (error) {
    logService.error('Error al obtener estadísticas', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 VELINNE Server corriendo en http://localhost:${PORT}`);
  logService.info(`Servidor iniciado en puerto ${PORT}`);
});
