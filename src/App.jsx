import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Toolbar from './components/Toolbar';
import PedidosTable from './components/PedidosTable';
import DatosPreviewModal from './components/modals/DatosPreviewModal';
import PDFPreviewModal from './components/modals/PDFPreviewModal';
import LoadingModal from './components/modals/LoadingModal';
import Toast from './components/Toast';
import FollowUpPanel from './components/FollowUpPanel';
import TemplateManagerPanel from './components/TemplateManagerPanel';
import { usePedidos } from './hooks/usePedidos';
import { obtenerPedidosFinalizados } from './services/api';

const FOLLOWUP_TEMPLATES_STORAGE_KEY = 'velinne_followup_templates_v1';
const DEFAULT_FOLLOWUP_TEMPLATE = {
  id: 'default-1',
  name: 'Seguimiento Nutritivo',
  body: 'Hola {{cliente_nombre}}, como estas?\n\nHace {{dias_transcurridos}} dias recibiste tu pedido #{{numero_pedido}} y queria saber como te sentiste con los resultados.\n\nSi queres, te ayudo a ajustar tu rutina para potenciar el resultado 💚',
};

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
    generarEtiquetaReclamo,
    generarEtiquetaColaboracion,
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
  const [activeView, setActiveView] = useState('pedidos'); // pedidos | especiales | followup | plantillas
  const [notifChannelFilter, setNotifChannelFilter] = useState(null); // null | 'email' | 'whatsapp' | 'noChannel'
  const [channelPriority, setChannelPriority] = useState('email'); // 'email' | 'whatsapp'
  const [etiquetaMode, setEtiquetaMode] = useState('reclamos'); // reclamos | colaboraciones
  const [reclamoPedidoId, setReclamoPedidoId] = useState('');
  const [reclamoBusqueda, setReclamoBusqueda] = useState('');
  const [reclamoNotas, setReclamoNotas] = useState('');
  const [pedidosFinalizados, setPedidosFinalizados] = useState([]);
  const [pedidosFinalizadosLoaded, setPedidosFinalizadosLoaded] = useState(false);
  const [followupTemplates, setFollowupTemplates] = useState([DEFAULT_FOLLOWUP_TEMPLATE]);
  const [activeFollowupTemplateId, setActiveFollowupTemplateId] = useState(DEFAULT_FOLLOWUP_TEMPLATE.id);
  const [colForm, setColForm] = useState({
    cliente_nombre: '',
    cliente_email: '',
    cliente_telefono: '',
    direccion_envio: '',
    localidad: '',
    departamento: '',
    codigo_postal: '',
    notas: '',
  });

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

  const pedidosFinalizadosParaReclamo = [...pedidosFinalizados].sort((a, b) => {
    const numA = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  const pedidosBusquedaReclamo = (() => {
    const q = String(reclamoBusqueda || '').trim().toLowerCase();
    const base = pedidosFinalizadosParaReclamo;

    if (!q) return base.slice(0, 12);

    return base
      .filter((p) => {
        const numero = String(p.numero_pedido || p.id || '').toLowerCase();
        const nombre = String(p.cliente_nombre || '').toLowerCase();
        const email = String(p.cliente_email || '').toLowerCase();
        const telefono = String(p.cliente_telefono || '').toLowerCase();
        return numero.includes(q) || nombre.includes(q) || email.includes(q) || telefono.includes(q);
      })
      .slice(0, 20);
  })();

  const pedidoReclamoSeleccionado = pedidosFinalizadosParaReclamo.find((p) => p.id === reclamoPedidoId) || null;

  // Cargar pedidos al montar el componente
  useEffect(() => {
    console.log('🚀 App React montada - cargando pedidos...');
    cargarPedidos();
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOLLOWUP_TEMPLATES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setFollowupTemplates(parsed);
        setActiveFollowupTemplateId(parsed[0].id);
      }
    } catch (error) {
      console.error('No se pudieron cargar las plantillas follow-up:', error);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(FOLLOWUP_TEMPLATES_STORAGE_KEY, JSON.stringify(followupTemplates));
  }, [followupTemplates]);

  useEffect(() => {
    if (!followupTemplates.some((tpl) => tpl.id === activeFollowupTemplateId)) {
      setActiveFollowupTemplateId(followupTemplates[0]?.id || '');
    }
  }, [followupTemplates, activeFollowupTemplateId]);

  useEffect(() => {
    const shouldLoadFinalizados = activeView === 'especiales' && etiquetaMode === 'reclamos' && !pedidosFinalizadosLoaded;
    if (!shouldLoadFinalizados) return;

    let cancelled = false;
    obtenerPedidosFinalizados()
      .then((data) => {
        if (cancelled) return;
        setPedidosFinalizados(Array.isArray(data) ? data : []);
        setPedidosFinalizadosLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('❌ Error cargando pedidos finalizados para reclamos:', error);
        mostrarToast('No se pudieron cargar los pedidos finalizados para reclamos', 'error');
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, etiquetaMode, pedidosFinalizadosLoaded]);

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

  const handleGenerarReclamo = async () => {
    if (!reclamoPedidoId) {
      mostrarToast('Selecciona un pedido para el reclamo', 'warning');
      return;
    }
    if (!uesAuthenticated) {
      mostrarToast('Debes iniciar sesión en UES antes de generar etiquetas', 'warning');
      return;
    }

    const resultado = await generarEtiquetaReclamo(reclamoPedidoId, reclamoNotas);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error generando etiqueta de reclamo', 'error');
      return;
    }

    if (resultado.pdfUrl) {
      setPdfUrl(resultado.pdfUrl);
      setShowPDFModal(true);
    }
    mostrarToast(`✅ Reclamo ${resultado.referencia} generado`, 'success');
  };

  const handleGenerarColaboracion = async () => {
    if (!uesAuthenticated) {
      mostrarToast('Debes iniciar sesión en UES antes de generar etiquetas', 'warning');
      return;
    }

    const resultado = await generarEtiquetaColaboracion(colForm);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error generando etiqueta de colaboracion', 'error');
      return;
    }

    if (resultado.pdfUrl) {
      setPdfUrl(resultado.pdfUrl);
      setShowPDFModal(true);
    }

    mostrarToast(`✅ Colaboracion ${resultado.referencia} generada`, 'success');
    setColForm({
      cliente_nombre: '',
      cliente_email: '',
      cliente_telefono: '',
      direccion_envio: '',
      localidad: '',
      departamento: '',
      codigo_postal: '',
      notas: '',
    });
  };

  return (
    <div className="app app-shell">
      <aside className="side-nav">
        <div className="side-nav-brand">
          <div className="side-nav-logo">VELINNE</div>
          <div className="side-nav-subtitle">BEAUTY</div>
        </div>

        <nav className="side-nav-menu" aria-label="Navegacion principal">
          <button
            type="button"
            className={`side-nav-item ${activeView === 'pedidos' ? 'side-nav-item-active' : ''}`}
            onClick={() => setActiveView('pedidos')}
          >
            <span className="side-nav-icon">📦</span>
            Operativa Pedidos
          </button>
          <button
            type="button"
            className={`side-nav-item ${activeView === 'especiales' ? 'side-nav-item-active' : ''}`}
            onClick={() => setActiveView('especiales')}
          >
            <span className="side-nav-icon">🏷️</span>
            Etiquetas Especiales
          </button>
          <button
            type="button"
            className={`side-nav-item ${activeView === 'followup' ? 'side-nav-item-active' : ''}`}
            onClick={() => setActiveView('followup')}
          >
            <span className="side-nav-icon">✈️</span>
            Follow-Up Diario
          </button>
          <button
            type="button"
            className={`side-nav-item ${activeView === 'plantillas' ? 'side-nav-item-active' : ''}`}
            onClick={() => setActiveView('plantillas')}
          >
            <span className="side-nav-icon">📝</span>
            Plantillas
          </button>
        </nav>
      </aside>

      <main className="app-main">
        {activeView === 'pedidos' && (
          <Header 
            stats={headerStats} 
            activeFilter={tableFilter} 
            onFilterChange={setTableFilter}
            onActualizar={cargarPedidos}
            onLoginUES={handleLoginUES}
            uesAuthenticated={uesAuthenticated}
          />
        )}

      {activeView === 'pedidos' && (
        <>
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
        </>
      )}

      {activeView === 'especiales' && (
        <>
          <div className="module-panel module-panel-tight-top">
            <h3>Etiquetas Especiales</h3>
            <p>Casos fuera del flujo normal de pedidos.</p>
            <label className="module-label" htmlFor="tipo-etiqueta">Caso</label>
            <select
              id="tipo-etiqueta"
              className="module-input"
              value={etiquetaMode}
              onChange={(e) => setEtiquetaMode(e.target.value)}
            >
              <option value="reclamos">Reclamo (RCL)</option>
              <option value="colaboraciones">Colaboracion (COL)</option>
            </select>
          </div>

          {etiquetaMode === 'reclamos' && (
            <div className="module-panel module-panel-tight">
              <h3>Reclamos (RCL)</h3>
              <p>Genera una nueva etiqueta para un pedido finalizado. La referencia se crea como RCL(numero de pedido).</p>

              <label className="module-label" htmlFor="reclamo-busqueda">Buscar pedido asociado</label>
              <input
                id="reclamo-busqueda"
                className="module-input"
                value={reclamoBusqueda}
                onChange={(e) => setReclamoBusqueda(e.target.value)}
                placeholder="Buscar entre pedidos finalizados por numero, cliente, email o telefono"
              />

              <p className="module-help-text">Solo se listan pedidos finalizados o ya notificados.</p>

              {pedidoReclamoSeleccionado && (
                <div className="module-search-selected">
                  <span>
                    Seleccionado: #{pedidoReclamoSeleccionado.numero_pedido || pedidoReclamoSeleccionado.id} - {pedidoReclamoSeleccionado.cliente_nombre || 'Sin nombre'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setReclamoPedidoId('')}
                  >
                    Cambiar
                  </button>
                </div>
              )}

              <div className="module-search-results">
                {pedidosBusquedaReclamo.length === 0 ? (
                  <div className="module-search-empty">No se encontraron pedidos finalizados para esa busqueda</div>
                ) : (
                  pedidosBusquedaReclamo.map((p) => {
                    const selected = p.id === reclamoPedidoId;
                    return (
                      <button
                        type="button"
                        key={p.id}
                        className={`module-search-item ${selected ? 'module-search-item-active' : ''}`}
                        onClick={() => setReclamoPedidoId(p.id)}
                      >
                        <strong>#{p.numero_pedido || p.id}</strong> - {p.cliente_nombre || 'Sin nombre'}
                        <span>
                          {p.cliente_email || 'Sin email'}{p.cliente_telefono ? ` | ${p.cliente_telefono}` : ''}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              <label className="module-label" htmlFor="reclamo-notas">Notas (opcional)</label>
              <textarea
                id="reclamo-notas"
                className="module-input"
                rows={3}
                value={reclamoNotas}
                onChange={(e) => setReclamoNotas(e.target.value)}
                placeholder="Motivo del reclamo o aclaraciones"
              />

              <button type="button" className="btn btn-primary" onClick={handleGenerarReclamo}>
                Generar Etiqueta RCL
              </button>
            </div>
          )}

          {etiquetaMode === 'colaboraciones' && (
            <div className="module-panel module-panel-tight">
              <h3>Colaboraciones (COL)</h3>
              <p>Genera etiquetas para influencers y colaboraciones. La referencia se asigna automaticamente como COL(0,1,2...)</p>

              <div className="module-grid">
                <input
                  className="module-input"
                  placeholder="Nombre del destinatario"
                  value={colForm.cliente_nombre}
                  onChange={(e) => setColForm((prev) => ({ ...prev, cliente_nombre: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Email (opcional)"
                  value={colForm.cliente_email}
                  onChange={(e) => setColForm((prev) => ({ ...prev, cliente_email: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Telefono"
                  value={colForm.cliente_telefono}
                  onChange={(e) => setColForm((prev) => ({ ...prev, cliente_telefono: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Direccion completa"
                  value={colForm.direccion_envio}
                  onChange={(e) => setColForm((prev) => ({ ...prev, direccion_envio: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Localidad"
                  value={colForm.localidad}
                  onChange={(e) => setColForm((prev) => ({ ...prev, localidad: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Departamento"
                  value={colForm.departamento}
                  onChange={(e) => setColForm((prev) => ({ ...prev, departamento: e.target.value }))}
                />
                <input
                  className="module-input"
                  placeholder="Codigo postal"
                  value={colForm.codigo_postal}
                  onChange={(e) => setColForm((prev) => ({ ...prev, codigo_postal: e.target.value }))}
                />
              </div>

              <textarea
                className="module-input"
                rows={3}
                placeholder="Notas (opcional)"
                value={colForm.notas}
                onChange={(e) => setColForm((prev) => ({ ...prev, notas: e.target.value }))}
              />

              <button type="button" className="btn btn-primary" onClick={handleGenerarColaboracion}>
                Generar Etiqueta COL
              </button>
            </div>
          )}
        </>
      )}

      {activeView === 'followup' && (
        <FollowUpPanel
          mostrarToast={mostrarToast}
          templates={followupTemplates}
          activeTemplateId={activeFollowupTemplateId}
          setActiveTemplateId={setActiveFollowupTemplateId}
          setTemplates={setFollowupTemplates}
          onOpenTemplateManager={() => setActiveView('plantillas')}
        />
      )}

      {activeView === 'plantillas' && (
        <TemplateManagerPanel
          templates={followupTemplates}
          activeTemplateId={activeFollowupTemplateId}
          onActiveTemplateChange={setActiveFollowupTemplateId}
          onTemplatesChange={setFollowupTemplates}
          onBackToFollowUp={() => setActiveView('followup')}
          mostrarToast={mostrarToast}
        />
      )}

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
      </main>
    </div>
  );
}

export default App;
