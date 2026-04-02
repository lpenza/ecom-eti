import { useState, useCallback } from 'react';
import * as api from '../services/api';

export function usePedidos() {
  const [pedidos, setPedidos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Procesando...');
  const [selectedPedidos, setSelectedPedidos] = useState([]);
  const [uesAuthenticated, setUesAuthenticated] = useState(false);

  // Calcular estadísticas
  const stats = {
    total: Array.isArray(pedidos) ? pedidos.length : 0,
    pendientes: Array.isArray(pedidos) ? pedidos.filter(p => p.estado === 'pendiente' || p.estado === 'verificado').length : 0,
    procesados: Array.isArray(pedidos) ? pedidos.filter(p => p.estado === 'procesado' || p.estado === 'etiqueta_generada').length : 0
  };

  // Login en UES
  const loginUES = useCallback(async () => {
    console.log('🔐 Iniciando login en UES...');
    setLoading(true);
    setLoadingText('Autenticando en UES...');

    try {
      const result = await api.loginUES();
      
      if (result.success) {
        console.log('✅ Login exitoso en UES');
        setUesAuthenticated(true);
        return { success: true };
      }
      
      return { success: false, error: result.error || 'Error desconocido' };
    } catch (error) {
      console.error('❌ Error en login UES:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Verificar estado de autenticación UES
  const checkUESStatus = useCallback(async () => {
    try {
      const status = await api.checkUESStatus();
      setUesAuthenticated(status.authenticated);
    } catch (error) {
      console.error('Error verificando estado UES:', error);
      setUesAuthenticated(false);
    }
  }, []);

  // Cargar pedidos desde el servidor
  const cargarPedidos = useCallback(async () => {
    console.log('📥 Cargando pedidos...');
    setLoading(true);
    setLoadingText('Cargando pedidos...');

    try {
      const data = await api.obtenerPedidos();
      
      // Validar que sea un array
      if (!Array.isArray(data)) {
        console.warn('⚠️ La respuesta no es un array:', data);
        setPedidos([]);
        return { success: false, error: 'Formato de respuesta inválido' };
      }
      
      console.log(`✅ ${data.length} pedidos cargados`);
      setPedidos(data);
      
      // Verificar estado de UES
      await checkUESStatus();
      
      return { success: true, count: data.length };
    } catch (error) {
      console.error('❌ Error cargando pedidos:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, [checkUESStatus]);

  // Sincronizar con Shopify
  const sincronizarShopify = useCallback(async () => {
    console.log('🔄 Sincronizando con Shopify...');
    setLoading(true);
    setLoadingText('Sincronizando con Shopify...');

    try {
      const result = await api.sincronizarShopify();
      console.log('✅ Sincronización completada:', result);
      
      // Recargar pedidos
      await cargarPedidos();
      
      return { success: true };
    } catch (error) {
      console.error('❌ Error en sincronización:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, [cargarPedidos]);

  // Ejecutar fulfillment en Shopify para pedidos con etiqueta generada
  const ejecutarFulfillmentShopify = useCallback(async (pedidoIds = null, trackingTemplate = null) => {
    console.log('🚚 Ejecutando fulfillment Shopify...');
    setLoading(true);
    setLoadingText('Ejecutando fulfillment Shopify...');

    try {
      const result = await api.ejecutarFulfillmentShopify(pedidoIds, trackingTemplate);
      await cargarPedidos();
      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error en fulfillment Shopify:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, [cargarPedidos]);

  // Reenviar notificacion de tracking para un pedido puntual
  const notificarTrackingPedido = useCallback(async (pedidoId, options = {}) => {
    console.log(`📨 Reenviando tracking para pedido ${pedidoId}...`);
    setLoading(true);
    setLoadingText('Enviando notificacion de tracking...');

    try {
      const result = await api.notificarTrackingPedido(pedidoId, options);
      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error reenviando tracking:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Marcar pedido como notificado (para envios manuales de WhatsApp)
  const marcarPedidoNotificado = useCallback(async (pedidoId) => {
    console.log(`✓ Marcando pedido ${pedidoId} como notificado...`);

    try {
      const result = await api.marcarPedidoNotificado(pedidoId);
      
      // Actualizar el pedido en el estado local
      setPedidos(prevPedidos =>
        prevPedidos.map(p =>
          p.id === pedidoId
            ? { ...p, notificacion_enviada_at: result.notificacion_enviada_at }
            : p
        )
      );
      
      return { success: true };
    } catch (error) {
      console.error('❌ Error marcando pedido como notificado:', error);
      return { success: false, error: error.message };
    }
  }, []);

  const actualizarRevisionContacto = useCallback(async (pedidoId, pendiente, motivo = '') => {
    try {
      const result = await api.actualizarRevisionContacto(pedidoId, { pendiente, motivo });

      setPedidos(prevPedidos =>
        prevPedidos.map(p =>
          p.id === pedidoId
            ? {
                ...p,
                revision_contacto_pendiente: Boolean(result.revision_contacto_pendiente),
                revision_contacto_motivo: result.revision_contacto_motivo || '',
                revision_contacto_fecha: result.revision_contacto_fecha || null,
              }
            : p
        )
      );

      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error actualizando revisión de contacto:', error);
      return { success: false, error: error.message };
    }
  }, []);

  const descartarEtiqueta = useCallback(async (pedidoId) => {
    console.log(`↩️ Descartando etiqueta para pedido ${pedidoId}...`);
    setLoading(true);
    setLoadingText('Descartando etiqueta...');

    try {
      const result = await api.descartarEtiqueta(pedidoId);

      setPedidos(prevPedidos =>
        prevPedidos.map(p =>
          p.id === pedidoId
            ? {
                ...p,
                estado: 'pendiente',
                etiqueta_generada: false,
                numero_seguimiento_ues: null,
                link_etiqueta_drive: null,
              }
            : p
        )
      );

      setSelectedPedidos(prev => prev.filter(id => id !== pedidoId));

      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error descartando etiqueta:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Generar etiqueta individual
  const generarEtiqueta = useCallback(async (pedidoId, payloadOverrides = null) => {
    console.log(`📦 Generando etiqueta para pedido ${pedidoId}...`);
    setLoading(true);
    setLoadingText('Generando etiqueta...');

    try {
      const result = await api.generarEtiqueta(pedidoId, payloadOverrides);
      console.log('✅ Etiqueta generada:', result);
      
      // Actualizar el pedido en el estado
      setPedidos(prevPedidos =>
        prevPedidos.map(p =>
          p.id === pedidoId
            ? { 
                ...p, 
                estado: 'etiqueta_generada', 
                numero_seguimiento_ues: result.tracking,
                etiqueta_generada: true
              }
            : p
        )
      );
      
      return { success: true, pdfUrl: result.pdfUrl, tracking: result.tracking };
    } catch (error) {
      console.error('❌ Error generando etiqueta:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Generar etiqueta de reclamo (asociada a un pedido)
  const generarEtiquetaReclamo = useCallback(async (pedidoId, notas = '') => {
    console.log(`📦 Generando etiqueta de reclamo para pedido ${pedidoId}...`);
    setLoading(true);
    setLoadingText('Generando etiqueta de reclamo...');

    try {
      const result = await api.generarEtiquetaReclamo(pedidoId, notas);
      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error generando etiqueta de reclamo:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Generar etiqueta de colaboracion
  const generarEtiquetaColaboracion = useCallback(async (data) => {
    console.log('📦 Generando etiqueta de colaboracion...');
    setLoading(true);
    setLoadingText('Generando etiqueta de colaboracion...');

    try {
      const result = await api.generarEtiquetaColaboracion(data);
      return { success: true, ...result };
    } catch (error) {
      console.error('❌ Error generando etiqueta de colaboracion:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // Generar etiquetas masivas
  const generarEtiquetasMasivo = useCallback(async () => {
    if (selectedPedidos.length === 0) {
      return { success: false, error: 'No hay pedidos seleccionados' };
    }

    console.log(`📦 Generando ${selectedPedidos.length} etiquetas...`);
    setLoading(true);
    setLoadingText(`Generando ${selectedPedidos.length} etiquetas...`);

    try {
      const results = await Promise.all(
        selectedPedidos.map(id => api.generarEtiqueta(id))
      );
      
      const exitosos = results.filter(r => r.success).length;
      console.log(`✅ ${exitosos}/${selectedPedidos.length} etiquetas generadas`);
      
      // Actualizar pedidos procesados
      setPedidos(prevPedidos =>
        prevPedidos.map(p => {
          const result = results.find(r => r.pedidoId === p.id);
          if (result && result.success) {
            return { ...p, estado: 'procesado', tracking: result.tracking };
          }
          return p;
        })
      );
      
      // Limpiar selección
      setSelectedPedidos([]);
      
      return { success: true, count: exitosos };
    } catch (error) {
      console.error('❌ Error en generación masiva:', error);
      return { success: false, error: error.message };
    } finally {
      setLoading(false);
    }
  }, [selectedPedidos]);

  // Toggle selección individual
  const toggleSelectPedido = useCallback((pedidoId) => {
    setSelectedPedidos(prev => {
      if (prev.includes(pedidoId)) {
        return prev.filter(id => id !== pedidoId);
      } else {
        return [...prev, pedidoId];
      }
    });
  }, []);

  // Toggle seleccionar todos
  const toggleSelectAll = useCallback(() => {
    if (selectedPedidos.length === pedidos.length) {
      setSelectedPedidos([]);
    } else {
      setSelectedPedidos(pedidos.map(p => p.id));
    }
  }, [pedidos, selectedPedidos]);

  const limpiarSeleccion = useCallback(() => {
    setSelectedPedidos([]);
  }, []);

  const setPedidoSeleccionado = useCallback((pedidoId, seleccionado) => {
    setSelectedPedidos((prev) => {
      const exists = prev.includes(pedidoId);
      if (seleccionado && !exists) {
        return [...prev, pedidoId];
      }
      if (!seleccionado && exists) {
        return prev.filter((id) => id !== pedidoId);
      }
      return prev;
    });
  }, []);

  return {
    pedidos,
    loading,
    loadingText,
    selectedPedidos,
    stats,
    uesAuthenticated,
    cargarPedidos,
    sincronizarShopify,
    ejecutarFulfillmentShopify,
    notificarTrackingPedido,
    marcarPedidoNotificado,
    actualizarRevisionContacto,
    descartarEtiqueta,
    generarEtiqueta,
    generarEtiquetaReclamo,
    generarEtiquetaColaboracion,
    generarEtiquetasMasivo,
    toggleSelectAll,
    toggleSelectPedido,
    loginUES,
    limpiarSeleccion,
    setPedidoSeleccionado
  };
}
