import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Toolbar from './components/Toolbar';
import PedidosTable from './components/PedidosTable';
import DatosPreviewModal from './components/modals/DatosPreviewModal';
import PDFPreviewModal from './components/modals/PDFPreviewModal';
import LoadingModal from './components/modals/LoadingModal';
import Toast from './components/Toast';
import { usePedidos } from './hooks/usePedidos';

function App() {
  const {
    pedidos,
    loading,
    loadingText,
    selectedPedidos,
    uesAuthenticated,
    cargarPedidos,
    sincronizarShopify,
    ejecutarFulfillmentShopify,
    notificarTrackingPedido,
    marcarPedidoNotificado,
    generarEtiqueta,
    limpiarSeleccion,
    setPedidoSeleccionado,
    toggleSelectAll,
    toggleSelectPedido,
    loginUES
  } = usePedidos();

  const [showDatosModal, setShowDatosModal] = useState(false);
  const [showPDFModal, setShowPDFModal] = useState(false);
  const [previewPedidos, setPreviewPedidos] = useState([]);
  const [previewInitialIndex, setPreviewInitialIndex] = useState(0);
  const [pdfUrl, setPdfUrl] = useState('');
  const [toast, setToast] = useState({ show: false, message: '', type: '' });
  const [fulfillmentPreviewIds, setFulfillmentPreviewIds] = useState(null); // null = normal, array = preview mode
  const [tableFilter, setTableFilter] = useState('porValidar');
  const [notifChannelFilter, setNotifChannelFilter] = useState(null); // null | 'email' | 'whatsapp' | 'noChannel'
  const [channelPriority, setChannelPriority] = useState('email'); // 'email' | 'whatsapp'

  const estadoEsCerrado = (estado) => {
    const estadoNormalizado = String(estado || '').toLowerCase();
    return estadoNormalizado === 'enviado';
  };

  // Pedidos que aún no tienen etiqueta generada (necesitan validación)
  const pedidosPendientes = pedidos.filter((p) => !p.etiqueta_generada && !estadoEsCerrado(p.estado));
  
  // Pedidos con etiqueta pero no notificados (incluye los de WhatsApp sin email que están esperando notificación manual)
  const pedidosConEtiqueta = pedidos.filter((p) => p.etiqueta_generada && !Boolean(p.notificacion_enviada_at) && !estadoEsCerrado(p.estado));
  
  // Pedidos notificados: tienen notificacion_enviada_at O estado 'enviado'
  const pedidosEnviados = pedidos.filter((p) => Boolean(p.notificacion_enviada_at) || estadoEsCerrado(p.estado));

  // Helper para determinar si tiene email
  const tieneEmail = (p) => Boolean(String(p.cliente_email || '').trim());
  
  // Pendientes de envio: tienen etiqueta y tracking, NO han sido notificados, Y tienen email (Shopify solo puede notificar por email)
  const pedidosListosFulfillment = pedidos.filter(
    (p) => p.etiqueta_generada && p.numero_seguimiento_ues && !Boolean(p.notificacion_enviada_at) && !estadoEsCerrado(p.estado) && tieneEmail(p)
  );
  const pedidosListosFulfillmentSeleccionados = pedidosListosFulfillment.filter((p) =>
    selectedPedidos.includes(p.id)
  );
  const candidatosFulfillment = selectedPedidos.length > 0
    ? pedidosListosFulfillmentSeleccionados
    : pedidosListosFulfillment;
  const seleccionadosEnPreview = Array.isArray(fulfillmentPreviewIds)
    ? fulfillmentPreviewIds.filter((id) => selectedPedidos.includes(id))
    : [];

  // Desglose de canales de notificacion para el preview (antes de confirmar)
  const tienePhone = (p) => String(p.cliente_telefono || '').replace(/\D/g, '').length >= 8;

  // Determinar canal en base a prioridad configurada
  const getCanalNotificacion = (p) => {
    const email = tieneEmail(p);
    const phone = tienePhone(p);
    
    if (channelPriority === 'whatsapp') {
      // Prioridad WhatsApp: si tiene phone, usa wpp aunque tenga email
      if (phone) return 'whatsapp';
      if (email) return 'email';
      return 'noChannel';
    } else {
      // Prioridad Email (default): si tiene email, usa shopify email
      if (email) return 'email';
      if (phone) return 'whatsapp';
      return 'noChannel';
    }
  };

  const notifPreview = fulfillmentPreviewIds !== null ? (() => {
    const enPreview = pedidos.filter((p) => fulfillmentPreviewIds.includes(p.id));
    return {
      shopifyEmail: enPreview.filter((p) => getCanalNotificacion(p) === 'email').length,
      whatsapp: enPreview.filter((p) => getCanalNotificacion(p) === 'whatsapp').length,
      noChannel: enPreview.filter((p) => getCanalNotificacion(p) === 'noChannel').length,
    };
  })() : null;

  // IDs del canal activo (para acotar el contador del boton Confirmar)
  const previewIdsPorCanal = (() => {
    if (!fulfillmentPreviewIds) return null;
    if (!notifChannelFilter) return fulfillmentPreviewIds;
    const enPreview = pedidos.filter((p) => fulfillmentPreviewIds.includes(p.id));
    if (notifChannelFilter === 'email') return enPreview.filter((p) => getCanalNotificacion(p) === 'email').map((p) => p.id);
    if (notifChannelFilter === 'whatsapp') return enPreview.filter((p) => getCanalNotificacion(p) === 'whatsapp').map((p) => p.id);
    if (notifChannelFilter === 'noChannel') return enPreview.filter((p) => getCanalNotificacion(p) === 'noChannel').map((p) => p.id);
    return fulfillmentPreviewIds;
  })();

  const headerStats = {
    porValidar: pedidosPendientes.length,
    etiquetasGeneradas: pedidosConEtiqueta.length,
    pendientesFulfillment: pedidosListosFulfillment.length,
    enviados: pedidosEnviados.length,
  };

  const pedidosFiltradosPorCard = (() => {
    if (tableFilter === 'etiquetasGeneradas') return pedidosConEtiqueta;
    if (tableFilter === 'pendientesFulfillment') return pedidosListosFulfillment;
    if (tableFilter === 'enviados') return pedidosEnviados;
    return pedidosPendientes;
  })();

  // Cargar pedidos al montar el componente
  useEffect(() => {
    console.log('🚀 App React montada - cargando pedidos...');
    cargarPedidos();
  }, []);

  // Confirmación desde modal (uno o múltiples pedidos)
  const handleConfirmarGeneracion = async (items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    if (!uesAuthenticated) {
      mostrarToast('Debes iniciar sesión en UES antes de generar etiquetas', 'warning');
      return;
    }
    
    setShowDatosModal(false);

    if (items.length === 1) {
      const item = items[0];
      const resultado = await generarEtiqueta(item.pedidoId, item.payloadOverrides || null);

      if (resultado.success && resultado.pdfUrl) {
        setPdfUrl(resultado.pdfUrl);
        setShowPDFModal(true);
      } else {
        mostrarToast(resultado.error || 'Error al generar etiqueta', 'error');
      }
      return;
    }

    let exitosos = 0;
    let fallidos = 0;
    const totalMarcados = items.length;

    for (const item of items) {
      const resultado = await generarEtiqueta(item.pedidoId, item.payloadOverrides || null);
      if (resultado.success) {
        exitosos += 1;
      } else {
        fallidos += 1;
      }
    }

    limpiarSeleccion();

    if (fallidos === 0) {
      mostrarToast(`✅ ${exitosos}/${totalMarcados} etiquetas generadas correctamente`, 'success');
    } else {
      mostrarToast(`⚠️ ${exitosos}/${totalMarcados} exitosas y ${fallidos} con error`, 'warning');
    }
  };

  // Función para mostrar toast
  const mostrarToast = (message, type = 'info') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: '' }), 3000);
  };

  // Handler para sincronización Shopify
  const handleSincronizarShopify = async () => {
    const resultado = await sincronizarShopify();
    if (resultado.success) {
      mostrarToast('✅ Sincronización completada', 'success');
    } else {
      mostrarToast(resultado.error || 'Error en sincronización', 'error');
    }
  };

  // Handler para fulfillment Shopify — primer clic muestra preview en tabla
  const handleFulfillmentShopify = () => {
    const candidatos = candidatosFulfillment;
    if (candidatos.length === 0) {
      if (selectedPedidos.length > 0) {
        mostrarToast('⚠️ Los pedidos seleccionados no estan listos para enviar tracking', 'warning');
      } else {
        mostrarToast('ℹ️ No hay pedidos listos para enviar tracking', 'warning');
      }
      return;
    }
    limpiarSeleccion();
    candidatos.forEach((p) => setPedidoSeleccionado(p.id, true));
    setFulfillmentPreviewIds(candidatos.map((p) => p.id));
    setNotifChannelFilter(null);
    mostrarToast(`🔍 ${candidatos.length} pedido(s) listos — confirma para enviar tracking`, 'info');
  };

  // Handler para confirmar y ejecutar el fulfillment
  const handleConfirmarFulfillment = async () => {
    const enPreview = Array.isArray(fulfillmentPreviewIds) && fulfillmentPreviewIds.length > 0;
    if (enPreview && seleccionadosEnPreview.length === 0) {
      mostrarToast('⚠️ Selecciona al menos un pedido para enviar tracking', 'warning');
      return;
    }

    const pedidoIds = enPreview ? seleccionadosEnPreview : null;
    const resultado = await ejecutarFulfillmentShopify(pedidoIds);
    setFulfillmentPreviewIds(null);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error enviando tracking', 'error');
      return;
    }

    if (resultado.failCount > 0) {
      mostrarToast(`⚠️ Tracking: ${resultado.successCount}/${resultado.count} OK`, 'warning');
    } else {
      mostrarToast(`✅ Tracking enviado a ${resultado.successCount} pedido(s)`, 'success');
    }
  };

  // Handler para cancelar el preview de fulfillment
  const handleCancelarFulfillment = () => {
    setFulfillmentPreviewIds(null);
    setNotifChannelFilter(null);
  };

  // Handler para reenvio manual de notificacion de tracking
  const handleReenviarNotificacion = async (pedidoId) => {
    const resultado = await notificarTrackingPedido(pedidoId);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error reenviando notificacion', 'error');
      return;
    }

    const notif = resultado.notification || {};
    const emailOk = Boolean(notif.email?.success);
    const wppOk = Boolean(notif.whatsapp?.success);

    if (notif.handledByShopifyEmail) {
      mostrarToast('ℹ️ Email gestionado por Shopify (no se envia desde la app)', 'info');
      return;
    }

    if (!emailOk && !wppOk) {
      const canal = notif.canal || (notif.whatsapp?.skippedReason ? 'email' : 'whatsapp');
      mostrarToast(`⚠️ No se pudo enviar por ${canal}`, 'warning');
      return;
    }

    mostrarToast(
      wppOk ? '✅ Notificado por WhatsApp' : '✅ Notificado por Email',
      'success'
    );
  };

  // Handler para login UES
  const handleLoginUES = async () => {
    const resultado = await loginUES();
    if (resultado.success) {
      mostrarToast('✅ Login exitoso en UES', 'success');
      await cargarPedidos(); // Recargar para actualizar estado
    } else {
      mostrarToast(resultado.error || 'Error al conectar con UES', 'error');
    }
  };

  // Handler para validación masiva previa a generar
  const handleValidarSeleccionados = async () => {
    if (pedidosPendientes.length === 0) {
      mostrarToast('⚠️ No hay pedidos pendientes para validar', 'warning');
      return;
    }

    limpiarSeleccion();
    setPreviewPedidos(pedidosPendientes);
    setPreviewInitialIndex(0);
    setShowDatosModal(true);
  };

  return (
    <div className="app">
      {/* Header con estadísticas */}
      <Header 
        stats={headerStats} 
        activeFilter={tableFilter} 
        onFilterChange={setTableFilter}
        onActualizar={cargarPedidos}
        onLoginUES={handleLoginUES}
        uesAuthenticated={uesAuthenticated}
      />

      {/* Toolbar con acciones */}
      <Toolbar
        onSincronizar={handleSincronizarShopify}
        onValidar={handleValidarSeleccionados}
        onFulfillment={handleFulfillmentShopify}
        onConfirmarFulfillment={handleConfirmarFulfillment}
        onCancelarFulfillment={handleCancelarFulfillment}
        fulfillmentPreviewCount={fulfillmentPreviewIds !== null ? previewIdsPorCanal.filter((id) => selectedPedidos.includes(id)).length : null}
        fulfillmentPreviewTotalCount={previewIdsPorCanal?.length ?? null}
        fulfillmentReadyCount={candidatosFulfillment.length}
        notifPreview={notifPreview}
        notifChannelFilter={notifChannelFilter}
        onNotifChannelFilter={setNotifChannelFilter}
        channelPriority={channelPriority}
        onChannelPriorityChange={setChannelPriority}
        pendingCount={pedidosPendientes.length}
        uesAuthenticated={uesAuthenticated}
      />

      {/* Tabla de pedidos */}
      <div className="main-content">
        <PedidosTable
          pedidos={fulfillmentPreviewIds !== null
            ? (() => {
                const enPreview = pedidos.filter((p) => fulfillmentPreviewIds.includes(p.id));
                if (notifChannelFilter === 'email') return enPreview.filter((p) => getCanalNotificacion(p) === 'email');
                if (notifChannelFilter === 'whatsapp') return enPreview.filter((p) => getCanalNotificacion(p) === 'whatsapp');
                if (notifChannelFilter === 'noChannel') return enPreview.filter((p) => getCanalNotificacion(p) === 'noChannel');
                return enPreview;
              })()
            : pedidosFiltradosPorCard
          }
          selectedPedidos={selectedPedidos}
          onToggleSelect={toggleSelectPedido}
          onToggleSelectAll={toggleSelectAll}
          onReenviarNotificacion={handleReenviarNotificacion}
          onMarcarNotificado={marcarPedidoNotificado}
          fulfillmentPreview={fulfillmentPreviewIds !== null}
          channelPriority={channelPriority}
          showNotifyColumn={tableFilter !== 'porValidar'}
          showTrackingColumn={tableFilter !== 'porValidar'}
        />
      </div>

      {/* Modal de vista previa de datos */}
      {showDatosModal && previewPedidos.length > 0 && (
        <DatosPreviewModal
          pedidos={previewPedidos}
          selectedPedidoIds={selectedPedidos}
          initialIndex={previewInitialIndex}
          onReviewedChange={setPedidoSeleccionado}
          onClose={() => setShowDatosModal(false)}
          onConfirm={handleConfirmarGeneracion}
        />
      )}

      {/* Modal de vista previa de PDF */}
      {showPDFModal && (
        <PDFPreviewModal
          pdfUrl={pdfUrl}
          onClose={() => setShowPDFModal(false)}
        />
      )}

      {/* Modal de loading */}
      {loading && <LoadingModal text={loadingText} />}

      {/* Toast de notificaciones */}
      {toast.show && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}

export default App;
