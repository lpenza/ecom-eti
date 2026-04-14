import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import Toolbar from './components/Toolbar';
import PedidosTable from './components/PedidosTable';
import DatosPreviewModal from './components/modals/DatosPreviewModal';
import PDFPreviewModal from './components/modals/PDFPreviewModal';
import LoadingModal from './components/modals/LoadingModal';
import Toast from './components/Toast';
import FollowUpPanel from './components/FollowUpPanel';
import TemplateManagerPanel from './components/TemplateManagerPanel';
import BotControlPanel from './components/BotControlPanel';
import { usePedidos } from './hooks/usePedidos';
import {
  generarLinkWhatsApp,
  obtenerPedidosFinalizados,
  obtenerPedidosParaReclamo,
  obtenerPlantillas,
  crearPlantilla,
  actualizarPlantilla,
  eliminarPlantilla,
  activarPlantilla,
  combinarPdfsEtiquetas,
  regenerarCacheUES,
  obtenerEstadoCacheUES,
  obtenerReclamosPendientes,
  obtenerPedidosDespachados,
  obtenerPedidosEnviados,
  marcarEtiquetaImpresa,
  marcarDespachados,
} from './services/api';

const HTML_TEMPLATE_PREFIX = '[HTML] ';

function normalizeTemplateRecord(record) {
  const rawName = String(record?.name || '');
  const isHtml = rawName.startsWith(HTML_TEMPLATE_PREFIX);

  return {
    id: String(record.id),
    name: isHtml ? rawName.slice(HTML_TEMPLATE_PREFIX.length) : rawName,
    content: record.content,
    isActive: record.is_active,
    kind: isHtml ? 'html' : 'whatsapp',
  };
}

function toStoredTemplateName(name, kind = 'whatsapp') {
  const clean = String(name || '').trim();
  if (kind === 'html') {
    if (clean.startsWith(HTML_TEMPLATE_PREFIX)) return clean;
    return `${HTML_TEMPLATE_PREFIX}${clean}`;
  }

  return clean.startsWith(HTML_TEMPLATE_PREFIX)
    ? clean.slice(HTML_TEMPLATE_PREFIX.length)
    : clean;
}

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
    marcarRevisionContactoContactado,
    enviarEmailMasivoPendientesContacto,
    descartarEtiqueta,
    generarEtiqueta,
    consolidarEtiqueta,
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
  const [activeView, setActiveView] = useState('pedidos'); // pedidos | especiales | followup | plantillas | bot
  const [notifChannelFilter, setNotifChannelFilter] = useState(null); // null | 'email' | 'whatsapp' | 'noChannel'
  const [etiquetasCanalFilter, setEtiquetasCanalFilter] = useState('whatsapp'); // null | 'whatsapp' | 'email'
  const [channelPriority, setChannelPriority] = useState('email'); // 'email' | 'whatsapp'
  const [etiquetaMode, setEtiquetaMode] = useState('reclamos'); // reclamos | colaboraciones
  const [reclamoPedidoId, setReclamoPedidoId] = useState('');
  const [reclamoBusqueda, setReclamoBusqueda] = useState('');
  const [reclamoNotas, setReclamoNotas] = useState('');
  const [pedidosFinalizados, setPedidosFinalizados] = useState([]);
  const [pedidosFinalizadosLoaded, setPedidosFinalizadosLoaded] = useState(false);
  const [previewMode, setPreviewMode] = useState('normal'); // 'normal' | 'reclamo'
  const [reclamosPendientes, setReclamosPendientes] = useState([]);
  const [reclamosPendientesLoading, setReclamosPendientesLoading] = useState(false);
  const [pedidosDespachadosList, setPedidosDespachadosList] = useState([]);
  const [pedidosEnviadosList, setPedidosEnviadosList] = useState([]);
  const [pedidosEnviadosLoaded, setPedidosEnviadosLoaded] = useState(false);
  const [pedidosEnviadosLoading, setPedidosEnviadosLoading] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState('');
  const [activeTrackingTemplateId, setActiveTrackingTemplateId] = useState('');
  const [activeHtmlTemplateId, setActiveHtmlTemplateId] = useState('');
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
  const pedidosPendientesContactoSinCelConEmail = pedidosPendientesContacto.filter((p) => {
    const email = String(p.cliente_email || '').trim();
    const phoneDigits = String(p.cliente_telefono || '').replace(/\D/g, '');
    return Boolean(email) && phoneDigits.length < 8;
  });
  
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
    reclamosPendientes: reclamosPendientes.length,
    pendientesContacto: pedidosPendientesContacto.length,
    etiquetasGeneradas: pedidosConEtiqueta.length,
    pendientesFulfillment: pedidosListosFulfillment.length,
    whatsappTracking: pedidosTrackingWhatsApp.length,
    revisionManual: pedidosRevisionManual.length,
    despachados: pedidosDespachadosList.length,
    enviados: pedidosEnviadosList.length,
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
    if (tableFilter === 'etiquetasGeneradas') {
      if (etiquetasCanalFilter === 'whatsapp') return pedidosConEtiqueta.filter((p) => getCanalNotificacion(p) === 'whatsapp');
      if (etiquetasCanalFilter === 'email') return pedidosConEtiqueta.filter((p) => getCanalNotificacion(p) === 'email');
      return pedidosConEtiqueta;
    }
    if (tableFilter === 'pendientesFulfillment') return pedidosListosFulfillment;
    if (tableFilter === 'revisionManual') return pedidosRevisionManual;
    if (tableFilter === 'despachados') return pedidosDespachadosList;
    if (tableFilter === 'enviados') return pedidosEnviadosList;
    return pedidosPendientesValidables;
  })();

  const pedidosSeleccionadosConEtiquetaDescargable = pedidosFiltradosPorCard.filter((p) => (
    selectedPedidos.includes(p.id)
    && Boolean(p.etiqueta_generada)
    && Boolean(String(p.link_etiqueta_drive || '').trim())
  ));

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

  const templatesWhatsapp = templates.filter((t) => t.kind !== 'html');
  const templatesHtml = templates.filter((t) => t.kind === 'html');

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
        
        // Mapear de formato DB a formato frontend (con tipo)
        const plantillasMapeadas = plantillas.map(normalizeTemplateRecord);
        const plantillasWpp = plantillasMapeadas.filter((p) => p.kind !== 'html');
        const plantillasHtmlCargadas = plantillasMapeadas.filter((p) => p.kind === 'html');
        
        setTemplates(plantillasMapeadas);
        
        // Establecer plantilla activa para follow-up (solo WhatsApp)
        const activa = plantillasWpp.find((p) => p.isActive);
        if (activa) {
          setActiveTemplateId(activa.id);
        } else if (plantillasWpp.length > 0) {
          setActiveTemplateId(plantillasWpp[0].id);
        }
        
        // Establecer plantilla activa para tracking (buscar por nombre, solo WhatsApp)
        const trackingTemplate = plantillasWpp.find((p) => 
          p.name.toLowerCase().includes('envío') || 
          p.name.toLowerCase().includes('tracking') ||
          p.name.toLowerCase().includes('notificación')
        );
        if (trackingTemplate) {
          setActiveTrackingTemplateId(trackingTemplate.id);
        } else if (plantillasWpp.length > 0) {
          // Si no hay plantilla de tracking, usar la primera
          setActiveTrackingTemplateId(plantillasWpp[0].id);
        }

        // Plantilla HTML activa para emails masivos
        if (plantillasHtmlCargadas.length > 0) {
          setActiveHtmlTemplateId((prev) => prev || plantillasHtmlCargadas[0].id);
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

  // Sincronizar activeTemplateId (whatsapp/follow-up)
  useEffect(() => {
    if (!templatesWhatsapp.some((tpl) => tpl.id === activeTemplateId)) {
      setActiveTemplateId(templatesWhatsapp[0]?.id || '');
    }
  }, [templatesWhatsapp, activeTemplateId]);

  useEffect(() => {
    if (!templatesWhatsapp.some((tpl) => tpl.id === activeTrackingTemplateId)) {
      setActiveTrackingTemplateId(templatesWhatsapp[0]?.id || '');
    }
  }, [templatesWhatsapp, activeTrackingTemplateId]);

  useEffect(() => {
    if (!templatesHtml.some((tpl) => tpl.id === activeHtmlTemplateId)) {
      setActiveHtmlTemplateId(templatesHtml[0]?.id || '');
    }
  }, [templatesHtml, activeHtmlTemplateId]);

  useEffect(() => {
    const shouldLoadFinalizados = activeView === 'especiales' && etiquetaMode === 'reclamos' && !pedidosFinalizadosLoaded;
    if (!shouldLoadFinalizados) return;

    let cancelled = false;
    obtenerPedidosParaReclamo()
      .then((data) => {
        if (cancelled) return;
        setPedidosFinalizados(Array.isArray(data) ? data : []);
        setPedidosFinalizadosLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('❌ Error cargando pedidos para reclamos:', error);
        mostrarToast('No se pudieron cargar los pedidos para reclamos', 'error');
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, etiquetaMode, pedidosFinalizadosLoaded]);

  useEffect(() => {
    let cancelled = false;
    setReclamosPendientesLoading(true);

    obtenerReclamosPendientes()
      .then((data) => {
        if (cancelled) return;
        setReclamosPendientes(Array.isArray(data) ? data : []);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('❌ Error cargando reclamos pendientes:', error);
      })
      .finally(() => {
        if (!cancelled) setReclamosPendientesLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // Cargar pedidos despachados (sin fulfillment aún)
  const cargarPedidosDespachados = useCallback(async () => {
    try {
      const data = await obtenerPedidosDespachados();
      setPedidosDespachadosList(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('❌ Error cargando pedidos despachados:', error);
    }
  }, []);

  // Cargar pedidos procesados (fulfillment enviado)
  const cargarPedidosEnviados = useCallback(async () => {
    setPedidosEnviadosLoading(true);
    try {
      const data = await obtenerPedidosEnviados();
      setPedidosEnviadosList(Array.isArray(data) ? data : []);
      setPedidosEnviadosLoaded(true);
    } catch (error) {
      console.error('❌ Error cargando pedidos enviados:', error);
    } finally {
      setPedidosEnviadosLoading(false);
    }
  }, []);

  useEffect(() => {
    cargarPedidosDespachados();
    cargarPedidosEnviados();
  }, [cargarPedidosDespachados, cargarPedidosEnviados]);

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
        if (resultado.warning) {
          mostrarToast(`⚠️ ${resultado.warning}. Tracking: ${resultado.tracking}`, 'warning');
        }
      } else if (resultado.success) {
        mostrarToast(
          resultado.warning || `✅ Etiqueta generada correctamente. Tracking: ${resultado.tracking}`,
          resultado.warning ? 'warning' : 'success'
        );
      } else {
        mostrarToast(resultado.error || 'Error al generar etiqueta', 'error');
      }
      return;
    }

    let exitosos = 0;
    let fallidos = 0;
    const pdfUrlsExitosas = [];
    let exitososSinPdf = 0;
    const totalMarcados = items.length;

    const itemById = new Map(items.map((item) => [item.pedidoId, item]));
    const pedidoById = new Map(pedidos.map((p) => [p.id, p]));
    const resultadosPorPedidoId = new Map();
    const pedidosBase = items.filter((item) => !item.consolidarConPedidoId);
    const pedidosConsolidados = items.filter((item) => !!item.consolidarConPedidoId);

    const grupoPorPrincipal = new Map();
    pedidosConsolidados.forEach((item) => {
      const principalId = item.consolidarConPedidoId;
      if (!principalId) return;
      if (!grupoPorPrincipal.has(principalId)) {
        grupoPorPrincipal.set(principalId, new Set([principalId]));
      }
      grupoPorPrincipal.get(principalId).add(item.pedidoId);
    });

    const indexEnSeleccion = new Map(items.map((item, idx) => [item.pedidoId, idx]));

    const resolverReferenciaPedido = (pedidoId) => {
      const item = itemById.get(pedidoId);
      const referenciaOverride = String(item?.payloadOverrides?.payloadEnvio?.referencia || '').trim();
      if (referenciaOverride) return referenciaOverride;

      const pedidoData = pedidoById.get(pedidoId);
      return String(pedidoData?.numero_pedido || pedidoData?.id || pedidoId || '').trim();
    };

    for (const item of pedidosBase) {
      let payloadOverridesFinal = item.payloadOverrides || null;
      const grupo = grupoPorPrincipal.get(item.pedidoId);

      if (grupo && grupo.size > 1) {
        const refsConsolidadas = Array.from(grupo)
          .sort((a, b) => (indexEnSeleccion.get(a) ?? Number.MAX_SAFE_INTEGER) - (indexEnSeleccion.get(b) ?? Number.MAX_SAFE_INTEGER))
          .map((pedidoId) => resolverReferenciaPedido(pedidoId))
          .filter(Boolean);

        if (refsConsolidadas.length > 1) {
          const referenciaConsolidada = refsConsolidadas.join('/');
          payloadOverridesFinal = {
            ...(item.payloadOverrides || {}),
            payloadEnvio: {
              ...(item.payloadOverrides?.payloadEnvio || {}),
              referencia: referenciaConsolidada,
            },
            guia: {
              ...(item.payloadOverrides?.guia || {}),
              comentario: referenciaConsolidada,
            },
          };
        }
      }

      const resultado = await generarEtiqueta(item.pedidoId, payloadOverridesFinal);
      resultadosPorPedidoId.set(item.pedidoId, resultado);

      if (resultado.success) {
        exitosos += 1;
        if (resultado.pdfUrl) {
          pdfUrlsExitosas.push(resultado.pdfUrl);
        } else {
          exitososSinPdf += 1;
        }
      } else {
        fallidos += 1;
      }
    }

    for (const item of pedidosConsolidados) {
      const principalId = item.consolidarConPedidoId;
      const resultadoPrincipal = resultadosPorPedidoId.get(principalId);
      const principalItem = itemById.get(principalId);

      if (!resultadoPrincipal?.success) {
        fallidos += 1;
        continue;
      }

      const consolidado = await consolidarEtiqueta(item.pedidoId, {
        sourcePedidoId: principalId,
        tracking: resultadoPrincipal.tracking,
        pdfUrl: resultadoPrincipal.pdfUrl || null,
        tipoEntrega: principalItem?.payloadOverrides?.tipoEntrega || 'domicilio',
        puntoRetiroId: principalItem?.payloadOverrides?.puntoRetiroId || null,
        puntoRetiroNombre: principalItem?.payloadOverrides?.puntoRetiroNombre || '',
      });

      if (consolidado.success) {
        exitosos += 1;
        if (!consolidado.pdfUrl) {
          exitososSinPdf += 1;
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
      if (exitososSinPdf > 0) {
        mostrarToast(`⚠️ ${exitosos}/${totalMarcados} etiquetas generadas. ${exitososSinPdf} sin PDF para previsualizar.`, 'warning');
      } else {
        mostrarToast(`✅ ${exitosos}/${totalMarcados} etiquetas generadas correctamente`, 'success');
      }
    } else {
      const sinPdfTexto = exitososSinPdf > 0 ? `, ${exitososSinPdf} sin PDF` : '';
      mostrarToast(`⚠️ ${exitosos}/${totalMarcados} exitosas${sinPdfTexto} y ${fallidos} con error`, 'warning');
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
      const plantillasMapeadas = plantillas.map(normalizeTemplateRecord);
      const plantillasWpp = plantillasMapeadas.filter((p) => p.kind !== 'html');
      const plantillasHtmlCargadas = plantillasMapeadas.filter((p) => p.kind === 'html');
      console.log('📝 Plantillas mapeadas:', plantillasMapeadas);
      setTemplates(plantillasMapeadas);
      
      // Actualizar plantilla activa si es necesaria
      const activa = plantillasWpp.find((p) => p.isActive);
      if (activa) {
        setActiveTemplateId(activa.id);
      }

      if (plantillasHtmlCargadas.length > 0 && !plantillasHtmlCargadas.some((p) => p.id === activeHtmlTemplateId)) {
        setActiveHtmlTemplateId(plantillasHtmlCargadas[0].id);
      }
    } catch (error) {
      console.error('Error al recargar plantillas:', error);
      throw error;
    }
  };

  // Crear nueva plantilla
  const handleCrearPlantilla = async (plantilla) => {
    try {
      const kind = plantilla.kind === 'html' ? 'html' : 'whatsapp';
      await crearPlantilla({
        name: toStoredTemplateName(plantilla.name, kind),
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
  const handleActualizarPlantilla = async (id, cambios, forcedKind = null) => {
    try {
      const actual = templates.find((t) => String(t.id) === String(id));
      const kind = forcedKind || actual?.kind || 'whatsapp';
      const cambiosAPI = {};
      if (cambios.name !== undefined) cambiosAPI.name = toStoredTemplateName(cambios.name, kind);
      if (cambios.content !== undefined) cambiosAPI.content = cambios.content;
      if (cambios.isActive !== undefined) cambiosAPI.is_active = cambios.isActive;
      
      await actualizarPlantilla(id, cambiosAPI);
      
      // Actualizar solo localmente para evitar recargar y perder el foco
      setTemplates(prevTemplates => 
        prevTemplates.map(t => 
          t.id === id 
            ? { ...t, ...cambios, kind } 
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
      const kind = plantilla.kind === 'html' ? 'html' : 'whatsapp';
      await crearPlantilla({
        name: toStoredTemplateName(`${plantilla.name} (copia)`, kind),
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
      const activeTemplate = templatesWhatsapp.find(t => t.id === activeTrackingTemplateId);
      
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
      cargarPedidosEnviados(); cargarPedidosDespachados();
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

    const activeTemplate = templatesWhatsapp.find((t) => t.id === activeTrackingTemplateId);
    const resultado = await generarLinkWhatsApp(pedido, activeTemplate?.content);
    
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error al generar link de WhatsApp', 'error');
      return;
    }

    // Abrir WhatsApp Web con el link generado
    window.open(resultado.url, '_blank');
    mostrarToast('WhatsApp abierto con el mensaje', 'success');
  };

  // Handler para contacto rapido de pedidos en "Pendientes de Contacto"
  const handleContactarPendienteRapido = async (pedidoId) => {
    const pedido = pedidos.find((p) => p.id === pedidoId);
    if (!pedido) {
      mostrarToast('No se encontro el pedido seleccionado', 'error');
      return;
    }

    const activeTemplate = templatesWhatsapp.find((t) => t.id === activeTrackingTemplateId);
    const resultado = await generarLinkWhatsApp(pedido, activeTemplate?.content);

    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error al generar link de WhatsApp', 'error');
      return;
    }

    window.open(resultado.url, '_blank');
    const registro = await marcarRevisionContactoContactado(pedidoId);
    if (!registro.success) {
      mostrarToast(registro.error || 'No se pudo registrar el contacto', 'warning');
      return;
    }
    mostrarToast(`WhatsApp abierto con plantilla: ${activeTemplate?.name || 'Mensaje por defecto'}`, 'success');
  };

  const handleEnviarEmailPendientesContacto = async () => {
    if (tableFilter !== 'pendientesContacto') {
      mostrarToast('Esta acción está disponible en Pendientes de Contacto', 'warning');
      return;
    }

    const candidatos = pedidosPendientesContactoSinCelConEmail;
    if (candidatos.length === 0) {
      mostrarToast('No hay pendientes de contacto sin celular y con email', 'warning');
      return;
    }

    const activeTemplate = templatesHtml.find((t) => t.id === activeHtmlTemplateId);
    if (!activeTemplate) {
      mostrarToast('Selecciona o crea una plantilla HTML en la sección Plantillas', 'warning');
      return;
    }
    const subjectDefault = 'Seguimiento de tu pedido #{{numero_pedido}}';
    const subjectTemplate = window.prompt(
      'Asunto del email (podés usar {{numero_pedido}} y {{cliente_nombre}}):',
      subjectDefault
    );

    if (subjectTemplate === null) return;

    const resultado = await enviarEmailMasivoPendientesContacto({
      pedidoIds: candidatos.map((p) => p.id),
      subjectTemplate: String(subjectTemplate || '').trim() || subjectDefault,
      htmlTemplate: activeTemplate?.content || '',
      onlyWithoutPhone: true,
    });

    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error enviando email masivo', 'error');
      return;
    }

    if ((resultado.failed || 0) > 0) {
      mostrarToast(`✉️ Emails: ${resultado.sent}/${resultado.count} enviados (${resultado.failed} con error)`, 'warning');
    } else {
      mostrarToast(`✉️ ${resultado.sent} email(s) enviados`, 'success');
    }
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

  const handleDescargarEtiqueta = (pedidoId) => {
    const pedido = pedidos.find((p) => p.id === pedidoId);
    const etiquetaUrl = String(pedido?.link_etiqueta_drive || '').trim();

    if (!etiquetaUrl) {
      mostrarToast('Esta etiqueta no tiene PDF disponible para descargar', 'warning');
      return;
    }

    const a = document.createElement('a');
    a.href = etiquetaUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.download = `etiqueta-${pedido?.numero_pedido || pedidoId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    marcarEtiquetaImpresa(pedidoId)
      .then(() => cargarPedidos())
      .catch(() => {});
  };

  const handleDescargarEtiquetasSeleccionadas = async () => {
    if (selectedPedidos.length === 0) {
      mostrarToast('Selecciona al menos un pedido para descargar etiquetas', 'warning');
      return;
    }

    const pedidosSeleccionados = pedidosFiltradosPorCard.filter((p) => selectedPedidos.includes(p.id));
    const pedidosSinPdf = pedidosSeleccionados.filter((p) => !String(p.link_etiqueta_drive || '').trim());
    const pdfUrls = pedidosSeleccionadosConEtiquetaDescargable.map((p) => String(p.link_etiqueta_drive).trim());

    if (pdfUrls.length === 0) {
      mostrarToast('Los pedidos seleccionados no tienen etiqueta PDF disponible', 'warning');
      return;
    }

    if (pdfUrls.length === 1) {
      const pedido = pedidosSeleccionadosConEtiquetaDescargable[0];
      handleDescargarEtiqueta(pedido.id);
      if (pedidosSinPdf.length > 0) {
        mostrarToast(`Se descargó 1 etiqueta. ${pedidosSinPdf.length} pedido(s) seleccionados no tenían PDF.`, 'warning');
      }
      return;
    }

    try {
      const combinado = await combinarPdfsEtiquetas(pdfUrls);
      if (!combinado?.success || !combinado?.pdfUrl) {
        mostrarToast('No se pudo combinar las etiquetas seleccionadas', 'error');
        return;
      }

      const a = document.createElement('a');
      a.href = combinado.pdfUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = `etiquetas-seleccionadas-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      if (pedidosSinPdf.length > 0) {
        mostrarToast(`Descarga combinada lista (${pdfUrls.length} etiquetas). ${pedidosSinPdf.length} pedido(s) sin PDF.`, 'warning');
      }

      Promise.all(pedidosSeleccionadosConEtiquetaDescargable.map((p) => marcarEtiquetaImpresa(p.id)))
        .then(() => cargarPedidos())
        .catch(() => {});
    } catch (error) {
      console.error('Error combinando etiquetas seleccionadas:', error);
      mostrarToast('No se pudieron combinar las etiquetas seleccionadas', 'error');
    }
  };

  // Fulfillment para pedidos en revision manual (sin canal de notificacion)
  const handleFulfillmentRevisionManual = async () => {
    const ids = selectedPedidos.length > 0
      ? selectedPedidos.filter((id) => pedidosRevisionManual.some((p) => p.id === id))
      : pedidosRevisionManual.map((p) => p.id);

    if (ids.length === 0) {
      mostrarToast('No hay pedidos de revision manual para procesar', 'warning');
      return;
    }

    const resultado = await ejecutarFulfillmentShopify(ids);
    if (!resultado.success) {
      mostrarToast(resultado.error || 'Error en fulfillment', 'error');
      return;
    }
    if (resultado.failCount > 0) {
      mostrarToast(`⚠️ Fulfillment: ${resultado.successCount}/${resultado.count} OK`, 'warning');
    } else {
      mostrarToast(`✅ ${resultado.successCount} fulfillment(s) enviados`, 'success');
    }
    cargarPedidosEnviados();
    cargarPedidosDespachados();
  };

  // Marcar pedidos seleccionados como despachados (tag DESPACHADO en Shopify + estado enviado)
  const handleMarcarDespachados = async () => {
    const ids = selectedPedidos.length > 0
      ? selectedPedidos
      : pedidosFiltradosPorCard.map((p) => p.id);

    if (ids.length === 0) {
      mostrarToast('No hay pedidos para marcar', 'warning');
      return;
    }

    const resultado = await marcarDespachados(ids);
    if (!resultado?.success) {
      mostrarToast(resultado?.error || 'Error al marcar como despachados', 'error');
      return;
    }

    mostrarToast(`✅ ${resultado.ok}/${resultado.total} pedidos marcados como despachados`, 'success');
    limpiarSeleccion();
    await cargarPedidos();
    cargarPedidosDespachados();
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

  // ==================== HANDLERS RECLAMOS PENDIENTES ====================

  const handleNotificarReclamoWhatsApp = async (reclamo) => {
    const telefono = String(reclamo.cliente_telefono || '').replace(/\D/g, '');
    if (!telefono || telefono.length < 8) {
      mostrarToast('El reclamo no tiene teléfono válido para WhatsApp', 'warning');
      return;
    }
    const primerNombre = String(reclamo.cliente_nombre || 'cliente').trim().split(/\s+/)[0];
    const tracking = reclamo.numero_seguimiento_ues || '';
    const referencia = `RCL${reclamo.numero_pedido || reclamo.id}`;
    const mensaje = encodeURIComponent(
      `Hola ${primerNombre}! Tu etiqueta de reclamo ${referencia} fue generada.` +
      (tracking ? `\nNúmero de seguimiento: ${tracking}` : '')
    );
    const waNumber = telefono.startsWith('598') ? telefono : `598${telefono}`;
    window.open(`https://wa.me/${waNumber}?text=${mensaje}`, '_blank');

    try {
      await marcarPedidoNotificado(reclamo.id);
      setReclamosPendientes((prev) => prev.filter((r) => r.id !== reclamo.id));
      cargarPedidosEnviados();
      mostrarToast(`✅ Reclamo notificado y marcado`, 'success');
    } catch {
      mostrarToast('WhatsApp abierto, pero no se pudo marcar como notificado', 'warning');
    }
  };

  const handleDescargarPdfReclamo = (reclamo) => {
    const url = String(reclamo.link_etiqueta_drive || '').trim();
    if (!url) {
      mostrarToast('Este reclamo no tiene PDF disponible', 'warning');
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleFulfillmentReclamo = async (reclamo) => {
    if (!reclamo.numero_seguimiento_ues) {
      mostrarToast('El reclamo no tiene número de seguimiento para hacer fulfillment', 'warning');
      return;
    }
    try {
      const resultado = await ejecutarFulfillmentShopify([reclamo.id]);
      if (!resultado.success) {
        mostrarToast(resultado.error || 'Error en fulfillment del reclamo', 'error');
        return;
      }
      setReclamosPendientes((prev) => prev.filter((r) => r.id !== reclamo.id));
      mostrarToast(`✅ Fulfillment de reclamo enviado a Shopify`, 'success');
    } catch (error) {
      mostrarToast('Error al ejecutar fulfillment del reclamo', 'error');
    }
  };

  const handleMarcarDespachadoReclamo = async (reclamo) => {
    try {
      const resultado = await marcarDespachados([reclamo.id]);
      if (!resultado.success) {
        mostrarToast(resultado.error || 'Error al marcar como despachado', 'error');
        return;
      }
      setReclamosPendientes((prev) => prev.filter((r) => r.id !== reclamo.id));
      cargarPedidosDespachados();
      mostrarToast(`✅ Reclamo #${reclamo.numero_pedido || reclamo.id} marcado como despachado`, 'success');
    } catch (error) {
      mostrarToast('Error al marcar reclamo como despachado', 'error');
    }
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
          <button
            type="button"
            className={`side-nav-item ${activeView === 'bot' ? 'side-nav-item-active' : ''}`}
            onClick={() => setActiveView('bot')}
          >
            <span className="side-nav-icon">🤖</span>
            Bot WhatsApp
          </button>
        </nav>
      </aside>

      <main className="app-main">
        {activeView === 'pedidos' && (
          <Header
            stats={headerStats}
            activeFilter={tableFilter}
            onFilterChange={(f) => { setTableFilter(f); setEtiquetasCanalFilter(f === 'etiquetasGeneradas' ? 'whatsapp' : null); }}
            onActualizar={cargarPedidos}
            onLoginUES={handleLoginUES}
            onRegenerarCache={handleRegenerarCacheUES}
            uesAuthenticated={uesAuthenticated}
          />
        )}

      {activeView === 'pedidos' && (
        <div className="app-main-body">
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
            activeTrackingTemplate={templatesWhatsapp.find(t => t.id === activeTrackingTemplateId)}
            templates={templatesWhatsapp}
            onTrackingTemplateChange={setActiveTrackingTemplateId}
          />

          {/* Barra de accion email masivo (solo en pendientes contacto) */}
          {tableFilter === 'pendientesContacto' && (
            <div className="section-action-bar">
              {pedidosPendientesContacto.some((p) => tienePhone(p)) && templatesWhatsapp.length > 0 && (
                <div className="active-template-selector">
                  <label htmlFor="pending-contact-whatsapp-template">💬 Plantilla WhatsApp:</label>
                  <select
                    id="pending-contact-whatsapp-template"
                    value={activeTrackingTemplateId}
                    onChange={(e) => setActiveTrackingTemplateId(e.target.value)}
                    className="template-selector"
                  >
                    {templatesWhatsapp.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {pedidosPendientesContactoSinCelConEmail.length > 0 && (
                <>
                  {templatesHtml.length > 0 ? (
                    <div className="active-template-selector">
                      <label htmlFor="pending-contact-email-template">✉️ Plantilla email:</label>
                      <select
                        id="pending-contact-email-template"
                        value={activeHtmlTemplateId}
                        onChange={(e) => setActiveHtmlTemplateId(e.target.value)}
                        className="template-selector"
                      >
                        {templatesHtml.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <span>✉️ {pedidosPendientesContactoSinCelConEmail.length} pendiente(s) sin tel con email, sin plantilla HTML seleccionable</span>
                  )}

                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleEnviarEmailPendientesContacto}
                    disabled={templatesHtml.length === 0}
                    title={templatesHtml.length === 0 ? 'Creá una plantilla HTML en Plantillas antes de enviar' : 'Enviar email masivo con la plantilla HTML seleccionada'}
                  >
                    Enviar email masivo ({pedidosPendientesContactoSinCelConEmail.length})
                  </button>
                </>
              )}
            </div>
          )}

          {tableFilter === 'etiquetasGeneradas' && (
            <div className="section-action-bar">
              <span>
                Seleccionados: {selectedPedidos.length} | Descargables: {pedidosSeleccionadosConEtiquetaDescargable.length}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleDescargarEtiquetasSeleccionadas}
                disabled={pedidosSeleccionadosConEtiquetaDescargable.length === 0}
                title={pedidosSeleccionadosConEtiquetaDescargable.length === 0
                  ? 'Selecciona pedidos con etiqueta PDF disponible'
                  : 'Descargar juntas las etiquetas seleccionadas'}
              >
                📥 Descargar seleccionadas ({pedidosSeleccionadosConEtiquetaDescargable.length})
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleMarcarDespachados}
                title={selectedPedidos.length > 0
                  ? `Marcar ${selectedPedidos.length} pedido(s) seleccionado(s) como despachados`
                  : `Marcar todos los ${pedidosFiltradosPorCard.length} pedidos de esta vista como despachados`}
              >
                🚀 Marcar como Despachados ({selectedPedidos.length > 0 ? selectedPedidos.length : pedidosFiltradosPorCard.length})
              </button>
            </div>
          )}

          {tableFilter === 'revisionManual' && (
            <div className="section-action-bar">
              <span>
                {selectedPedidos.length > 0
                  ? `Seleccionados: ${selectedPedidos.length}`
                  : `${pedidosRevisionManual.length} pedido(s) sin canal de notificación`}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleFulfillmentRevisionManual}
                disabled={pedidosRevisionManual.length === 0}
                title="Enviar fulfillment a Shopify para estos pedidos (sin notificación al cliente)"
              >
                📨 Enviar Fulfillment ({selectedPedidos.length > 0 ? selectedPedidos.length : pedidosRevisionManual.length})
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleMarcarDespachados}
                disabled={pedidosRevisionManual.length === 0}
                title="Marcar como despachados y agregar tag DESPACHADO en Shopify"
              >
                🚀 Marcar como Despachados ({selectedPedidos.length > 0 ? selectedPedidos.length : pedidosRevisionManual.length})
              </button>
            </div>
          )}

          {tableFilter === 'despachados' && (
            <div className="section-action-bar">
              <span>
                {selectedPedidos.length > 0
                  ? `Seleccionados: ${selectedPedidos.length}`
                  : `${pedidosDespachadosList.length} pedido(s) despachados sin fulfillment`}
              </span>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const ids = selectedPedidos.length > 0
                    ? selectedPedidos.filter((id) => pedidosDespachadosList.some((p) => p.id === id))
                    : pedidosDespachadosList.map((p) => p.id);
                  if (ids.length === 0) { mostrarToast('No hay pedidos para procesar', 'warning'); return; }
                  const resultado = await ejecutarFulfillmentShopify(ids);
                  if (!resultado.success) { mostrarToast(resultado.error || 'Error en fulfillment', 'error'); return; }
                  if (resultado.failCount > 0) {
                    mostrarToast(`⚠️ Fulfillment: ${resultado.successCount}/${resultado.count} OK`, 'warning');
                  } else {
                    mostrarToast(`✅ ${resultado.successCount} fulfillment(s) enviados`, 'success');
                  }
                  limpiarSeleccion();
                  cargarPedidosDespachados();
                  cargarPedidosEnviados();
                }}
                disabled={pedidosDespachadosList.length === 0}
                title="Enviar fulfillment a Shopify para los despachados seleccionados"
              >
                📨 Enviar Fulfillment ({selectedPedidos.length > 0 ? selectedPedidos.length : pedidosDespachadosList.length})
              </button>
            </div>
          )}

          {/* Filtro de canal para etiquetas generadas */}
          {tableFilter === 'etiquetasGeneradas' && (
            <div className="notif-preview-chips" style={{ padding: '0 1rem 0.5rem' }}>
              <button
                type="button"
                className={`notif-chip notif-chip-wpp ${etiquetasCanalFilter === 'whatsapp' ? 'notif-chip-active' : ''}`}
                onClick={() => setEtiquetasCanalFilter(etiquetasCanalFilter === 'whatsapp' ? null : 'whatsapp')}
              >
                💬 WhatsApp ({pedidosConEtiqueta.filter((p) => getCanalNotificacion(p) === 'whatsapp').length})
              </button>
              <button
                type="button"
                className={`notif-chip notif-chip-email ${etiquetasCanalFilter === 'email' ? 'notif-chip-active' : ''}`}
                onClick={() => setEtiquetasCanalFilter(etiquetasCanalFilter === 'email' ? null : 'email')}
              >
                🏪 Shopify automático ({pedidosConEtiqueta.filter((p) => getCanalNotificacion(p) === 'email').length})
              </button>
            </div>
          )}

          {/* Tabla de reclamos pendientes */}
          {tableFilter === 'reclamosPendientes' && (
            <div className="main-content">
              {reclamosPendientesLoading ? (
                <p className="module-help-text">Cargando reclamos...</p>
              ) : reclamosPendientes.length === 0 ? (
                <p className="module-help-text">No hay reclamos pendientes de notificación.</p>
              ) : (
                <div className="reclamos-table-wrapper">
                  <table className="reclamos-table">
                    <thead>
                      <tr>
                        <th>Referencia</th>
                        <th>Pedido</th>
                        <th>Cliente</th>
                        <th>Tracking</th>
                        <th>Estado</th>
                        <th>Fecha</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reclamosPendientes.map((reclamo) => {
                        const estado = reclamo.estado || 'etiqueta_generada';
                        const isDespachado = estado === 'despachado';
                        const isEnviado    = estado === 'enviado';
                        return (
                          <tr key={reclamo.id}>
                            <td><strong>RCL{reclamo.numero_pedido || reclamo.id}</strong></td>
                            <td>#{reclamo.numero_pedido || reclamo.id}</td>
                            <td>
                              <div>{reclamo.cliente_nombre || '—'}</div>
                              <div className="reclamo-sub">{reclamo.cliente_telefono || reclamo.cliente_email || '—'}</div>
                            </td>
                            <td>{reclamo.numero_seguimiento_ues || '—'}</td>
                            <td>
                              {isEnviado    && <span className="reclamo-estado-badge reclamo-estado-enviado">✅ Procesado</span>}
                              {isDespachado && !isEnviado && <span className="reclamo-estado-badge reclamo-estado-despachado">🚀 Despachado</span>}
                              {!isDespachado && !isEnviado && <span className="reclamo-estado-badge reclamo-estado-generada">📦 Etiqueta lista</span>}
                            </td>
                            <td>{reclamo.created_at ? new Date(reclamo.created_at).toLocaleDateString('es-UY') : '—'}</td>
                            <td className="reclamo-actions">
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleNotificarReclamoWhatsApp(reclamo)}
                                title="Notificar por WhatsApp y marcar como notificado"
                              >
                                💬 WhatsApp
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleDescargarPdfReclamo(reclamo)}
                                disabled={!reclamo.link_etiqueta_drive}
                                title="Descargar PDF de la etiqueta"
                              >
                                📥 PDF
                              </button>
                              <button
                                type="button"
                                className={`btn btn-sm ${isDespachado || isEnviado ? 'btn-secondary' : 'btn-primary'}`}
                                onClick={() => handleMarcarDespachadoReclamo(reclamo)}
                                disabled={isDespachado || isEnviado}
                                title={isDespachado || isEnviado ? 'Ya marcado como despachado' : 'Marcar como despachado'}
                              >
                                🚀 Despachar
                              </button>
                              <button
                                type="button"
                                className={`btn btn-sm ${isEnviado ? 'btn-secondary' : 'btn-primary'}`}
                                onClick={() => handleFulfillmentReclamo(reclamo)}
                                disabled={!reclamo.numero_seguimiento_ues || isEnviado}
                                title={isEnviado ? 'Fulfillment ya enviado' : 'Ejecutar fulfillment en Shopify'}
                              >
                                🏪 Shopify
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Tabla de pedidos */}
          {tableFilter !== 'reclamosPendientes' && (
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
              onContactarPendiente={handleContactarPendienteRapido}
              onMarcarNotificado={async (pedidoId) => { await marcarPedidoNotificado(pedidoId); cargarPedidosEnviados(); cargarPedidosDespachados(); }}
              onDescargarEtiqueta={handleDescargarEtiqueta}
              onDescartarEtiqueta={handleDescartarEtiqueta}
              fulfillmentPreview={fulfillmentPreviewIds !== null}
              channelPriority={channelPriority}
              showNotifyColumn={tableFilter !== 'porValidar'}
              showTrackingColumn={tableFilter !== 'porValidar'}
              activeTrackingTemplate={templatesWhatsapp.find((t) => t.id === activeTrackingTemplateId)}
              activeContactTemplate={templatesWhatsapp.find((t) => t.id === activeTrackingTemplateId)}
              modoPendienteContacto={tableFilter === 'pendientesContacto'}
            />
          </div>
          )}
        </div>
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
          templates={templatesWhatsapp}
          activeTemplateId={activeTemplateId}
          setActiveTemplateId={setActiveTemplateId}
          onUpdateTemplate={handleActualizarPlantilla}
          onOpenTemplateManager={() => setActiveView('plantillas')}
        />
      )}

      {activeView === 'plantillas' && (
        <TemplateManagerPanel
          templates={templatesWhatsapp}
          htmlTemplates={templatesHtml}
          activeTemplateId={activeTemplateId}
          activeHtmlTemplateId={activeHtmlTemplateId}
          onActiveTemplateChange={setActiveTemplateId}
          onActiveHtmlTemplateChange={setActiveHtmlTemplateId}
          onCreateTemplate={handleCrearPlantilla}
          onUpdateTemplate={handleActualizarPlantilla}
          onDeleteTemplate={handleEliminarPlantilla}
          onDuplicateTemplate={handleDuplicarPlantilla}
          onBackToFollowUp={() => setActiveView('followup')}
          mostrarToast={mostrarToast}
        />
      )}

      {activeView === 'bot' && (
        <BotControlPanel mostrarToast={mostrarToast} />
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
