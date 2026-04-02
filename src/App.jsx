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
import { 
  generarLinkWhatsApp,
  obtenerPedidosFinalizados,
  obtenerPlantillas,
  crearPlantilla,
  actualizarPlantilla,
  eliminarPlantilla,
  activarPlantilla,
  combinarPdfsEtiquetas,
  regenerarCacheUES,
  obtenerEstadoCacheUES
} from './services/api';

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
    actualizarRevisionContacto,
    descartarEtiqueta,
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
  const [previewMode, setPreviewMode] = useState('normal'); // 'normal' | 'reclamo'
  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState('');
  const [activeTrackingTemplateId, setActiveTrackingTemplateId] = useState('');
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
  const pedidosPendientesContacto = pedidosPendientes.filter((p) => Boolean(p.revision_contacto_pendiente));
  const pedidosPendientesValidables = pedidosPendientes.filter((p) => !Boolean(p.revision_contacto_pendiente));
  
  // Pedidos con etiqueta pero no notificados (incluye los de WhatsApp sin email que están esperando notificación manual)
  const pedidosConEtiqueta = pedidos.filter((p) => p.etiqueta_generada && !Boolean(p.notificacion_enviada_at) && !estadoEsCerrado(p.estado));
  
  // Pedidos notificados: tienen notificacion_enviada_at O estado 'enviado'
  const pedidosEnviados = pedidos.filter((p) => Boolean(p.notificacion_enviada_at) || estadoEsCerrado(p.estado));

  // Helper para determinar si tiene email
  const tieneEmail = (p) => Boolean(String(p.cliente_email || '').trim());
  const tienePhone = (p) => String(p.cliente_telefono || '').replace(/\D/g, '').length >= 8;

  const getCanalTrackingBase = (p) => {
    if (tieneEmail(p)) return 'email';
    if (tienePhone(p)) return 'whatsapp';
    return 'noChannel';
  };

  const pedidosTrackingAutomatico = pedidosConEtiqueta.filter((p) => getCanalTrackingBase(p) === 'email');
  const pedidosTrackingWhatsApp = pedidosConEtiqueta.filter((p) => getCanalTrackingBase(p) === 'whatsapp');
  const pedidosRevisionManual = pedidosConEtiqueta.filter((p) => getCanalTrackingBase(p) === 'noChannel');
  const trackingClasificadoTotal = pedidosTrackingAutomatico.length + pedidosTrackingWhatsApp.length + pedidosRevisionManual.length;
  const hayDescuadreTracking = trackingClasificadoTotal !== pedidosConEtiqueta.length;
  
  // Pendientes de envio: tienen etiqueta y tracking, NO han sido notificados, Y tienen email (Shopify solo puede notificar por email)
  const pedidosListosFulfillment = pedidosTrackingAutomatico;
  const pedidosListosFulfillmentSeleccionados = pedidosListosFulfillment.filter((p) =>
    selectedPedidos.includes(p.id)
  );
  const candidatosFulfillment = selectedPedidos.length > 0
    ? pedidosListosFulfillmentSeleccionados
    : pedidosListosFulfillment;
  const seleccionadosEnPreview = Array.isArray(fulfillmentPreviewIds)
    ? fulfillmentPreviewIds.filter((id) => selectedPedidos.includes(id))
    : [];

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
    porValidar: pedidosPendientesValidables.length,
    pendientesContacto: pedidosPendientesContacto.length,
    etiquetasGeneradas: pedidosConEtiqueta.length,
    pendientesFulfillment: pedidosListosFulfillment.length,
    whatsappTracking: pedidosTrackingWhatsApp.length,
    revisionManual: pedidosRevisionManual.length,
    enviados: pedidosEnviados.length,
    trackingAlert: hayDescuadreTracking || pedidosRevisionManual.length > 0,
    trackingBreakdown: {
      total: pedidosConEtiqueta.length,
      automatico: pedidosListosFulfillment.length,
      whatsapp: pedidosTrackingWhatsApp.length,
      revisionManual: pedidosRevisionManual.length,
      descuadre: hayDescuadreTracking,
    },
  };

  const pedidosFiltradosPorCard = (() => {
    if (tableFilter === 'pendientesContacto') return pedidosPendientesContacto;
    if (tableFilter === 'etiquetasGeneradas') return pedidosConEtiqueta;
    if (tableFilter === 'pendientesFulfillment') return pedidosListosFulfillment;
    if (tableFilter === 'revisionManual') return pedidosRevisionManual;
    if (tableFilter === 'enviados') return pedidosEnviados;
    return pedidosPendientesValidables;
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

  // Monitorear estado del caché UES en background
  useEffect(() => {
    let cacheCheckInterval;
    let cacheNotified = false;
    
    const verificarCacheUES = async () => {
      try {
        const estado = await obtenerEstadoCacheUES();
        
        if (estado.ready && !cacheNotified) {
          mostrarToast('✅ Catálogo UES disponible', 'success');
          cacheNotified = true;
        } else if (!estado.ready && estado.error && !cacheNotified) {
          // Mostrar warning si hay error persistente después de 10 segundos
          mostrarToast('⚠️ Catálogo UES aún actualizándose...', 'info');
        }
      } catch (err) {
        // Silenciar errores de consulta (no es crítico)
      }
    };
    
    // Verificar estado cada 3 segundos durante 30 segundos max
    let checkCount = 0;
    cacheCheckInterval = setInterval(() => {
      verificarCacheUES();
      checkCount++;
      if (checkCount > 10) clearInterval(cacheCheckInterval); // Max 30 segundos
    }, 3000);
    
    return () => clearInterval(cacheCheckInterval);
  }, []);

  // Cargar plantillas desde la API
  useEffect(() => {
    let cancelled = false;
    
    obtenerPlantillas()
      .then((plantillas) => {
        if (cancelled) return;
        
        // Mapear de formato DB a formato frontend
        const plantillasMapeadas = plantillas.map((p) => ({
          id: String(p.id),
          name: p.name,
          content: p.content,
          isActive: p.is_active
        }));
        
        setTemplates(plantillasMapeadas);
        
        // Establecer plantilla activa para follow-up
        const activa = plantillasMapeadas.find((p) => p.isActive);
        if (activa) {
          setActiveTemplateId(activa.id);
        } else if (plantillasMapeadas.length > 0) {
          setActiveTemplateId(plantillasMapeadas[0].id);
        }
        
        // Establecer plantilla activa para tracking (buscar por nombre)
        const trackingTemplate = plantillasMapeadas.find((p) => 
          p.name.toLowerCase().includes('envío') || 
          p.name.toLowerCase().includes('tracking') ||
          p.name.toLowerCase().includes('notificación')
        );
        if (trackingTemplate) {
          setActiveTrackingTemplateId(trackingTemplate.id);
        } else if (plantillasMapeadas.length > 0) {
          // Si no hay plantilla de tracking, usar la primera
          setActiveTrackingTemplateId(plantillasMapeadas[0].id);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Error al cargar plantillas:', error);
        mostrarToast('No se pudieron cargar las plantillas', 'error');
      });
    
    return () => {
      cancelled = true;
    };
  }, []);

  // Sincronizar activeTemplateId si se elimina la plantilla activa
  useEffect(() => {
    if (!templates.some((tpl) => tpl.id === activeTemplateId)) {
      setActiveTemplateId(templates[0]?.id || '');
    }
  }, [templates, activeTemplateId]);

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
    
    // Si estamos en modo reclamo, usar el handler específico
    if (previewMode === 'reclamo') {
      return handleConfirmarReclamo(items);
    }
    
    setShowDatosModal(false);
    setPreviewMode('normal');

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
    const pdfUrlsExitosas = [];
    const totalMarcados = items.length;

    for (const item of items) {
      const resultado = await generarEtiqueta(item.pedidoId, item.payloadOverrides || null);
      if (resultado.success) {
        exitosos += 1;
        if (resultado.pdfUrl) {
          pdfUrlsExitosas.push(resultado.pdfUrl);
        }
      } else {
        fallidos += 1;
      }
    }

    if (pdfUrlsExitosas.length > 1) {
      try {
        const combinado = await combinarPdfsEtiquetas(pdfUrlsExitosas);
        if (combinado?.success && combinado?.pdfUrl) {
          setPdfUrl(combinado.pdfUrl);
          setShowPDFModal(true);
        }
      } catch (error) {
        mostrarToast('Se generaron etiquetas, pero no se pudo combinar el PDF. Mostrando la primera.', 'warning');
        setPdfUrl(pdfUrlsExitosas[0]);
        setShowPDFModal(true);
      }
    } else if (pdfUrlsExitosas.length === 1) {
      setPdfUrl(pdfUrlsExitosas[0]);
      setShowPDFModal(true);
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

  // ==================== FUNCIONES DE PLANTILLAS ====================

  // Recargar plantillas desde la API
  const recargarPlantillas = async () => {
    try {
      const plantillas = await obtenerPlantillas();
      console.log('📝 Plantillas recibidas desde API:', plantillas);
      const plantillasMapeadas = plantillas.map((p) => ({
        id: String(p.id),
        name: p.name,
        content: p.content,
        isActive: p.is_active
      }));
      console.log('📝 Plantillas mapeadas:', plantillasMapeadas);
      setTemplates(plantillasMapeadas);
      
      // Actualizar plantilla activa si es necesaria
      const activa = plantillasMapeadas.find((p) => p.isActive);
      if (activa) {
        setActiveTemplateId(activa.id);
      }
    } catch (error) {
      console.error('Error al recargar plantillas:', error);
      throw error;
    }
  };

  // Crear nueva plantilla
  const handleCrearPlantilla = async (plantilla) => {
    try {
      await crearPlantilla({
        name: plantilla.name,
        content: plantilla.content,
        is_active: false
      });
      await recargarPlantillas();
      mostrarToast('✅ Plantilla creada', 'success');
    } catch (error) {
      console.error('Error al crear plantilla:', error);
      mostrarToast('Error al crear plantilla', 'error');
      throw error;
    }
  };

  // Actualizar plantilla existente
  const handleActualizarPlantilla = async (id, cambios) => {
    try {
      const cambiosAPI = {};
      if (cambios.name !== undefined) cambiosAPI.name = cambios.name;
      if (cambios.content !== undefined) cambiosAPI.content = cambios.content;
      if (cambios.isActive !== undefined) cambiosAPI.is_active = cambios.isActive;
      
      await actualizarPlantilla(id, cambiosAPI);
      
      // Actualizar solo localmente para evitar recargar y perder el foco
      setTemplates(prevTemplates => 
        prevTemplates.map(t => 
          t.id === id 
            ? { ...t, ...cambios } 
            : t
        )
      );
    } catch (error) {
      console.error('Error al actualizar plantilla:', error);
      mostrarToast('Error al actualizar plantilla', 'error');
      throw error;
    }
  };

  // Eliminar plantilla
  const handleEliminarPlantilla = async (id) => {
    try {
      await eliminarPlantilla(id);
      await recargarPlantillas();
      mostrarToast('✅ Plantilla eliminada', 'success');
    } catch (error) {
      console.error('Error al eliminar plantilla:', error);
      mostrarToast('Error al eliminar plantilla', 'error');
      throw error;
    }
  };

  // Activar plantilla
  const handleActivarPlantilla = async (id) => {
    try {
      await activarPlantilla(id);
      await recargarPlantillas();
    } catch (error) {
      console.error('Error al activar plantilla:', error);
      mostrarToast('Error al activar plantilla', 'error');
      throw error;
    }
  };

  // Duplicar plantilla
  const handleDuplicarPlantilla = async (plantilla) => {
    try {
      await crearPlantilla({
        name: `${plantilla.name} (copia)`,
        content: plantilla.content,
        is_active: false
      });
      await recargarPlantillas();
      mostrarToast('✅ Plantilla duplicada', 'success');
    } catch (error) {
      console.error('Error al duplicar plantilla:', error);
      mostrarToast('Error al duplicar plantilla', 'error');
      throw error;
    }
  };

  // ==================== FIN FUNCIONES DE PLANTILLAS ====================

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

    try {
      // Crear fulfillments en Shopify (sin notificar automáticamente)
      const pedidoIds = enPreview ? seleccionadosEnPreview : null;
      const resultado = await ejecutarFulfillmentShopify(pedidoIds);
      
      setFulfillmentPreviewIds(null);
      
      if (!resultado.success) {
        mostrarToast(resultado.error || 'Error en fulfillment', 'error');
        return;
      }

      if (resultado.failCount > 0) {
        mostrarToast(`⚠️ Fulfillment: ${resultado.successCount}/${resultado.count} OK`, 'warning');
      } else {
        mostrarToast(`✅ ${resultado.successCount} fulfillment(s) creados`, 'success');
      }

      // Obtener la plantilla activa de tracking
      const activeTemplate = templates.find(t => t.id === activeTrackingTemplateId);
      
      // Solo generar links de WhatsApp para pedidos SIN email
      // (los que tienen email ya fueron notificados por Shopify automáticamente)
      const pedidosSinEmail = resultado.pedidosSinEmail || [];

      if (pedidosSinEmail.length > 0) {
        // Generar links en paralelo
        const promesas = pedidosSinEmail.map(pedido => 
          generarLinkWhatsApp(pedido, activeTemplate?.content)
        );

        const resultadosLinks = await Promise.all(promesas);

        // Abrir cada link en una nueva pestaña con delay para no saturar el navegador
        resultadosLinks.forEach((result, index) => {
          if (result.success) {
            setTimeout(() => window.open(result.url, '_blank'), index * 500);
          }
        });

        const linksExitosos = resultadosLinks.filter(r => r.success).length;
        mostrarToast(`📱 ${linksExitosos} notificaciones por WhatsApp (sin email)`, 'info');
      } else if(resultado.successCount > 0) {
        mostrarToast(`✉️ Todos los pedidos fueron notificados por email automáticamente`, 'info');
      }

      await cargarPedidos(); // Recargar lista de pedidos
    } catch (error) {
      console.error('Error en fulfillment:', error);
      mostrarToast('Error al procesar fulfillment', 'error');
    }
  };

  // Handler para cancelar el preview de fulfillment
  const handleCancelarFulfillment = () => {
    setFulfillmentPreviewIds(null);
    setNotifChannelFilter(null);
  };

  // Handler para reenvio manual de notificacion de tracking
  const handleReenviarNotificacion = async (pedidoId) => {
    const pedido = pedidos.find(p => p.id === pedidoId);
    if (!pedido || !pedido.cliente_telefono) {
      mostrarToast('Pedido sin teléfono válido', 'error');
      return;
    }

    const activeTemplate = templates.find((t) => t.id === activeTrackingTemplateId);
    const resultado = await generarLinkWhatsApp(pedido, activeTemplate?.content);
    
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error al generar link de WhatsApp', 'error');
      return;
    }

    // Abrir WhatsApp Web con el link generado
    window.open(resultado.url, '_blank');
    mostrarToast('WhatsApp abierto con el mensaje', 'success');
  };

  const handleDescartarEtiqueta = async (pedidoId) => {
    const pedido = pedidos.find((p) => p.id === pedidoId);
    const numeroPedido = pedido?.numero_pedido || pedidoId;

    const confirmado = window.confirm(`Descartar la etiqueta del pedido #${numeroPedido} y devolverlo a validacion?`);
    if (!confirmado) {
      return;
    }

    const resultado = await descartarEtiqueta(pedidoId);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'No se pudo descartar la etiqueta', 'error');
      return;
    }

    mostrarToast(resultado.message || 'Etiqueta descartada. El pedido volvio a validacion.', 'success');
    if (tableFilter !== 'porValidar') {
      setTableFilter('porValidar');
    }
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

  // Handler para regenerar caché de catálogo UES
  const handleRegenerarCacheUES = async () => {
    try {
      mostrarToast('🔄 Actualizando catálogo de localidades...', 'info');
      const resultado = await regenerarCacheUES();
      if (resultado.success) {
        mostrarToast(`✅ ${resultado.message}`, 'success');
      } else {
        mostrarToast(resultado.error || 'Error al actualizar catálogo', 'error');
      }
    } catch (error) {
      mostrarToast('❌ Error al actualizar catálogo UES', 'error');
    }
  };

  // Handler para validación masiva previa a generar
  const handleValidarSeleccionados = async () => {
    const enPendientesContacto = tableFilter === 'pendientesContacto';

    if (enPendientesContacto) {
      if (pedidosPendientesContacto.length === 0) {
        mostrarToast('⚠️ No hay pedidos en pendientes de contacto para revisar', 'warning');
        return;
      }

      limpiarSeleccion();
      setPreviewPedidos(pedidosPendientesContacto);
      setPreviewInitialIndex(0);
      setShowDatosModal(true);
      mostrarToast('ℹ️ Revisando pedidos pendientes de contacto en modal', 'info');
      return;
    }

    if (pedidosPendientesValidables.length === 0) {
      if (pedidosPendientesContacto.length > 0) {
        limpiarSeleccion();
        setPreviewPedidos(pedidosPendientesContacto);
        setPreviewInitialIndex(0);
        setShowDatosModal(true);
        mostrarToast('⚠️ No hay pedidos listos para validar. Te abrí los pendientes de contacto para que los puedas resolver.', 'warning');
      } else {
        mostrarToast('⚠️ No hay pedidos pendientes para validar', 'warning');
      }
      return;
    }

    if (pedidosPendientesContacto.length > 0) {
      mostrarToast(`⚠️ ${pedidosPendientesContacto.length} pedido(s) bloqueados por contacto quedaron fuera de la validación`, 'warning');
    }

    limpiarSeleccion();
    setPreviewPedidos(pedidosPendientesValidables);
    setPreviewInitialIndex(0);
    setShowDatosModal(true);
  };

  const handleToggleRevisionContacto = async (pedidoId) => {
    const pedido = pedidos.find((p) => p.id === pedidoId);
    if (!pedido) return;

    const yaPendiente = Boolean(pedido.revision_contacto_pendiente);
    if (yaPendiente) {
      const confirmado = window.confirm('¿Marcar como resuelto y habilitar validación de este pedido?');
      if (!confirmado) return;

      const resultado = await actualizarRevisionContacto(pedidoId, false, '');
      if (!resultado.success) {
        mostrarToast(resultado.error || 'No se pudo actualizar el estado de revisión', 'error');
        return;
      }
      mostrarToast('✅ Pedido habilitado para validación', 'success');
      return;
    }

    const motivo = window.prompt('Motivo de contacto pendiente (se guardará para revisión manual):', pedido.revision_contacto_motivo || '');
    if (motivo === null) return;

    const resultado = await actualizarRevisionContacto(pedidoId, true, motivo);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'No se pudo marcar el pedido para revisión', 'error');
      return;
    }
    mostrarToast('⚠️ Pedido marcado para contacto con cliente', 'info');
    if (tableFilter === 'porValidar') {
      setTableFilter('pendientesContacto');
    }
  };

  const handleUpdateRevisionContactoDesdeModal = async (pedidoId, pendiente, motivo) => {
    const resultado = await actualizarRevisionContacto(pedidoId, pendiente, motivo || '');
    if (!resultado.success) {
      return resultado;
    }

    setPreviewPedidos((prev) => prev.map((p) => (
      p.id === pedidoId
        ? {
            ...p,
            revision_contacto_pendiente: Boolean(resultado.revision_contacto_pendiente),
            revision_contacto_motivo: resultado.revision_contacto_motivo || '',
            revision_contacto_fecha: resultado.revision_contacto_fecha || null,
          }
        : p
    )));

    return resultado;
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

    // Buscar el pedido seleccionado en la lista de finalizados
    const pedidoSeleccionado = pedidosFinalizados.find(p => p.id === reclamoPedidoId);
    if (!pedidoSeleccionado) {
      mostrarToast('No se encontró el pedido seleccionado', 'error');
      return;
    }

    // Abrir modal de preview en modo reclamo
    setPreviewPedidos([pedidoSeleccionado]);
    setPreviewInitialIndex(0);
    setPreviewMode('reclamo');
    setShowDatosModal(true);
  };

  const handleConfirmarReclamo = async (items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    
    setShowDatosModal(false);
    setPreviewMode('normal');

    const item = items[0]; // Solo hay un pedido en modo reclamo
    
    // Agregar las notas del reclamo a las observaciones si hay
    if (reclamoNotas && item.payloadOverrides?.payloadDireccion) {
      const obsActuales = item.payloadOverrides.payloadDireccion.observaciones || '';
      item.payloadOverrides.payloadDireccion.observaciones = 
        [obsActuales, reclamoNotas].filter(Boolean).join(' | ');
    }

    const resultado = await generarEtiquetaReclamo(
      item.pedidoId, 
      reclamoNotas, 
      item.payloadOverrides
    );
    
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error generando etiqueta de reclamo', 'error');
      return;
    }

    if (resultado.pdfUrl) {
      setPdfUrl(resultado.pdfUrl);
      setShowPDFModal(true);
    }
    
    mostrarToast(`✅ Reclamo ${resultado.referencia} generado`, 'success');
    
    // Limpiar campos del formulario
    setReclamoPedidoId('');
    setReclamoNotas('');
    setReclamoBusqueda('');
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
            onRegenerarCache={handleRegenerarCacheUES}
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
            activeTrackingTemplate={templates.find(t => t.id === activeTrackingTemplateId)}
            templates={templates}
            onTrackingTemplateChange={setActiveTrackingTemplateId}
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
              onDescartarEtiqueta={handleDescartarEtiqueta}
              fulfillmentPreview={fulfillmentPreviewIds !== null}
              channelPriority={channelPriority}
              showNotifyColumn={tableFilter !== 'porValidar' && tableFilter !== 'pendientesContacto'}
              showTrackingColumn={tableFilter !== 'porValidar'}
              activeTrackingTemplate={templates.find((t) => t.id === activeTrackingTemplateId)}
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
          templates={templates}
          activeTemplateId={activeTemplateId}
          setActiveTemplateId={setActiveTemplateId}
          onUpdateTemplate={handleActualizarPlantilla}
          onOpenTemplateManager={() => setActiveView('plantillas')}
        />
      )}

      {activeView === 'plantillas' && (
        <TemplateManagerPanel
          templates={templates}
          activeTemplateId={activeTemplateId}
          onActiveTemplateChange={setActiveTemplateId}
          onCreateTemplate={handleCrearPlantilla}
          onUpdateTemplate={handleActualizarPlantilla}
          onDeleteTemplate={handleEliminarPlantilla}
          onDuplicateTemplate={handleDuplicarPlantilla}
          onBackToFollowUp={() => setActiveView('followup')}
          mostrarToast={mostrarToast}
        />
      )}

      {/* Modal de vista previa de datos */}
      {showDatosModal && previewPedidos.length > 0 && (
        <DatosPreviewModal
          pedidos={previewPedidos}
          selectedPedidoIds={previewMode === 'reclamo' ? [reclamoPedidoId] : selectedPedidos}
          initialIndex={previewInitialIndex}
          onReviewedChange={setPedidoSeleccionado}
          onUpdateRevisionContacto={handleUpdateRevisionContactoDesdeModal}
          onClose={() => {
            setShowDatosModal(false);
            setPreviewMode('normal');
          }}
          onConfirm={handleConfirmarGeneracion}
          isReclamoMode={previewMode === 'reclamo'}
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
