import React, { useEffect, useMemo, useState } from 'react';
import {
  geocodificarPedido,
  obtenerCatalogoDepartamentosUES,
  obtenerCatalogoLocalidadesUES,
  obtenerPayloadPreviewUES,
  obtenerPuntosRetiroUES,
} from '../../services/api';

function DatosPreviewModal({ pedidos = [], selectedPedidoIds = [], initialIndex = 0, onReviewedChange, onClose, onConfirm, isReclamoMode = false, onUpdateRevisionContacto }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [departamentos, setDepartamentos] = useState([]);
  const [localidadesByDep, setLocalidadesByDep] = useState({});
  const [puntosRetiroByLocalidad, setPuntosRetiroByLocalidad] = useState({});
  const [previewByPedidoId, setPreviewByPedidoId] = useState({});
  const [formsByPedidoId, setFormsByPedidoId] = useState({});
  const [validationError, setValidationError] = useState('');
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [geocodificando, setGeocodificando] = useState(false);
  const [geoResultadoByPedidoId, setGeoResultadoByPedidoId] = useState({});
  const [geoAplicadoByPedidoId, setGeoAplicadoByPedidoId] = useState({});
  const [localidadSugerida, setLocalidadSugerida] = useState(null); // { id, nombre, score }
  const [numeroPuertaSugerido, setNumeroPuertaSugerido] = useState(false); // true si se autocompletó con s/n

  const currentPedido = pedidos[currentIndex] || null;
  const currentPreview = currentPedido ? previewByPedidoId[currentPedido.id] : null;
  const currentForm = currentPedido ? formsByPedidoId[currentPedido.id] : null;

  const currentDepartamentoId = String(currentForm?.payloadDireccion?.departamento_id || '');
  const localidadesActuales = useMemo(() => {
    if (!currentDepartamentoId) return [];
    return localidadesByDep[currentDepartamentoId] || [];
  }, [localidadesByDep, currentDepartamentoId]);
  const currentLocalidadId = String(currentForm?.payloadDireccion?.localidad_id || '');
  const puntosRetiroActuales = useMemo(() => {
    const all = puntosRetiroByLocalidad['_all'] || [];
    if (!currentDepartamentoId) return all;
    return all.filter((p) => String(p.departamento_id) === String(currentDepartamentoId));
  }, [puntosRetiroByLocalidad, currentDepartamentoId]);

  const isBatch = pedidos.length > 1;
  const checkedCount = Object.values(formsByPedidoId).filter((f) => f?.checked).length;
  const [consolidacionConfigByGroup, setConsolidacionConfigByGroup] = useState({});

  const consolidacionSugerida = useMemo(() => {
    if (!isBatch || !Array.isArray(pedidos) || pedidos.length < 2) return [];

    const normalizePhone = (value) => {
      const digits = String(value || '').replace(/\D/g, '');
      if (!digits) return '';

      // Normaliza teléfonos UY para comparar local vs internacional.
      // Ej: 099243970 -> 99243970, 59899243970 -> 99243970
      let normalized = digits;
      if (normalized.startsWith('598') && normalized.length >= 11) {
        normalized = normalized.slice(3);
      }
      if (normalized.startsWith('0') && normalized.length >= 9) {
        normalized = normalized.slice(1);
      }
      return normalized;
    };
    const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
    const n = pedidos.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (x) => {
      let p = x;
      while (parent[p] !== p) {
        parent[p] = parent[parent[p]];
        p = parent[p];
      }
      return p;
    };

    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const linksByKey = new Map();
    pedidos.forEach((pedido, idx) => {
      const estado = String(pedido?.estado || '').trim().toLowerCase();
      if (!estado) return;

      const phone = normalizePhone(pedido?.cliente_telefono);
      const email = normalizeEmail(pedido?.cliente_email);

      if (phone.length >= 8) {
        const key = `estado:${estado}|phone:${phone}`;
        const arr = linksByKey.get(key) || [];
        arr.push(idx);
        linksByKey.set(key, arr);
      }

      if (email) {
        const key = `estado:${estado}|email:${email}`;
        const arr = linksByKey.get(key) || [];
        arr.push(idx);
        linksByKey.set(key, arr);
      }
    });

    for (const arr of linksByKey.values()) {
      if (arr.length < 2) continue;
      const first = arr[0];
      for (let i = 1; i < arr.length; i++) {
        union(first, arr[i]);
      }
    }

    const groupsByRoot = new Map();
    pedidos.forEach((_, idx) => {
      const root = find(idx);
      const arr = groupsByRoot.get(root) || [];
      arr.push(idx);
      groupsByRoot.set(root, arr);
    });

    const sugerencias = [];
    for (const indexList of groupsByRoot.values()) {
      if (indexList.length < 2) continue;

      const idsOrdenados = indexList
        .map((i) => pedidos[i]?.id)
        .filter(Boolean)
        .sort((a, b) => {
          const ia = pedidos.findIndex((p) => p.id === a);
          const ib = pedidos.findIndex((p) => p.id === b);
          return ia - ib;
        });

      if (idsOrdenados.length < 2) continue;

      const groupId = idsOrdenados.join('|');
      sugerencias.push({
        groupId,
        pedidoIds: idsOrdenados,
        defaultPrincipalId: idsOrdenados[0],
      });
    }

    return sugerencias;
  }, [pedidos, isBatch]);

  useEffect(() => {
    if (consolidacionSugerida.length === 0) {
      setConsolidacionConfigByGroup({});
      return;
    }

    setConsolidacionConfigByGroup((prev) => {
      const next = {};
      consolidacionSugerida.forEach((group) => {
        const previous = prev[group.groupId];
        next[group.groupId] = {
          enabled: previous?.enabled || false,
          principalId: group.pedidoIds.includes(previous?.principalId)
            ? previous.principalId
            : group.defaultPrincipalId,
        };
      });
      return next;
    });
  }, [consolidacionSugerida]);

  const pedidosConsolidadosOcultos = useMemo(() => {
    const hidden = new Set();
    consolidacionSugerida.forEach((group) => {
      const config = consolidacionConfigByGroup[group.groupId];
      if (!config?.enabled) return;

      const principalId = config.principalId || group.defaultPrincipalId;
      group.pedidoIds.forEach((pedidoId) => {
        if (pedidoId !== principalId) hidden.add(pedidoId);
      });
    });
    return hidden;
  }, [consolidacionSugerida, consolidacionConfigByGroup]);

  const pedidosVisibles = useMemo(() => {
    if (!isBatch) return pedidos;
    return pedidos.filter((pedido) => !pedidosConsolidadosOcultos.has(pedido.id));
  }, [isBatch, pedidos, pedidosConsolidadosOcultos]);

  const visibleIndexes = useMemo(() => (
    pedidos
      .map((pedido, index) => ({ pedido, index }))
      .filter(({ pedido }) => !pedidosConsolidadosOcultos.has(pedido.id))
      .map(({ index }) => index)
  ), [pedidos, pedidosConsolidadosOcultos]);

  const currentVisiblePos = useMemo(() => {
    if (!isBatch) return currentIndex;
    return visibleIndexes.indexOf(currentIndex);
  }, [isBatch, currentIndex, visibleIndexes]);

  const consolidacionGroupByPedidoId = useMemo(() => {
    const map = new Map();
    consolidacionSugerida.forEach((group) => {
      group.pedidoIds.forEach((pedidoId) => map.set(pedidoId, group));
    });
    return map;
  }, [consolidacionSugerida]);

  const currentConsolidacionGroup = currentPedido
    ? consolidacionGroupByPedidoId.get(currentPedido.id) || null
    : null;

  const currentConsolidacionConfig = currentConsolidacionGroup
    ? (consolidacionConfigByGroup[currentConsolidacionGroup.groupId]
      || { enabled: false, principalId: currentConsolidacionGroup.defaultPrincipalId })
    : null;

  useEffect(() => {
    if (!isBatch) return;
    const current = pedidos[currentIndex];
    if (!current) return;
    if (!pedidosConsolidadosOcultos.has(current.id)) return;

    const firstVisibleIndex = visibleIndexes[0];
    if (typeof firstVisibleIndex === 'number') {
      setCurrentIndex(firstVisibleIndex);
    }
  }, [isBatch, pedidos, currentIndex, pedidosConsolidadosOcultos, visibleIndexes]);

  const getFormValidation = (form) => {
    if (!form) {
      return { blockers: ['Cargando datos del pedido'], warnings: [] };
    }

    const blockers = [];
    const warnings = [];

    const tipoEntrega = form.tipoEntrega || 'domicilio';

    if (tipoEntrega === 'domicilio') {
      if (!String(form.payloadDireccion?.calle || '').trim()) blockers.push('Falta calle');

      const nroPuerta = String(form.payloadDireccion?.nro_puerta || '').trim();
      if (!nroPuerta || nroPuerta.toLowerCase() === 's/n') {
        blockers.push('Falta número de puerta');
      }

      if (!String(form.payloadDireccion?.departamento_id || '').trim()) blockers.push('Falta departamento');
      if (!String(form.payloadDireccion?.localidad_id || '').trim()) blockers.push('Falta localidad');
    } else if (tipoEntrega === 'pickup') {
      if (!form.puntoRetiroId) blockers.push('Falta seleccionar punto de retiro');
    }

    if (!String(form.payloadEnvio?.nombre_recibe || '').trim()) blockers.push('Falta nombre destinatario');
    if (!String(form.payloadEnvio?.telefono_recibe || '').trim()) blockers.push('Falta teléfono destinatario');
    if (!String(form.payloadEnvio?.email_recibe || '').trim()) warnings.push('Sin email destinatario');

    return { blockers, warnings };
  };

  useEffect(() => {
    setCurrentIndex(initialIndex);
    setLocalidadSugerida(null); // Limpiar sugerencia al cambiar de pedido
    setNumeroPuertaSugerido(false); // Limpiar indicador de sugerencia
  }, [initialIndex]);

  useEffect(() => {
    (async () => {
      try {
        const deps = await obtenerCatalogoDepartamentosUES();
        setDepartamentos(Array.isArray(deps.data) ? deps.data : []);
      } catch (error) {
        setDepartamentos([]);
      }
    })();
  }, []);

  const loadLocalidades = async (departamentoId) => {
    const depId = String(departamentoId || '');
    if (!depId || localidadesByDep[depId]) return;

    try {
      const response = await obtenerCatalogoLocalidadesUES(depId);
      setLocalidadesByDep((prev) => ({
        ...prev,
        [depId]: Array.isArray(response.data) ? response.data : [],
      }));
    } catch (error) {
      setLocalidadesByDep((prev) => ({ ...prev, [depId]: [] }));
    }
  };

  const loadPuntosRetiro = async () => {
    if (puntosRetiroByLocalidad['_all']) return;

    try {
      const response = await obtenerPuntosRetiroUES();
      setPuntosRetiroByLocalidad((prev) => ({
        ...prev,
        '_all': Array.isArray(response.data) ? response.data : [],
      }));
    } catch (error) {
      setPuntosRetiroByLocalidad((prev) => ({ ...prev, '_all': [] }));
    }
  };

  const ensurePreviewLoaded = async (pedidoId, pedidoData) => {
    if (previewByPedidoId[pedidoId]?.data || previewByPedidoId[pedidoId]?.loading) return;

    setPreviewByPedidoId((prev) => ({
      ...prev,
      [pedidoId]: { loading: true, data: null, error: '' },
    }));

    try {
      const response = await obtenerPayloadPreviewUES(pedidoId);
      const preview = response.data || null;

      setPreviewByPedidoId((prev) => ({
        ...prev,
        [pedidoId]: { loading: false, data: preview, error: '' },
      }));

      setFormsByPedidoId((prev) => {
        if (prev[pedidoId]) return prev;

        const tipoEntregaInicial = String(pedidoData?.tipo_entrega_ues || '').toLowerCase() === 'pickup'
          ? 'pickup'
          : 'domicilio';

        const detectedDepartamentoId = String(
          preview?.payloadDireccion?.departamento_id || preview?.localidadUes?.departamento_id || ''
        );
        const detectedLocalidadId = String(
          preview?.payloadDireccion?.localidad_id || preview?.localidadUes?.ues_id || ''
        );

        const guia = Array.isArray(preview?.payloadEnvio?.guias) && preview.payloadEnvio.guias.length > 0
          ? preview.payloadEnvio.guias[0]
          : {};

        return {
          ...prev,
          [pedidoId]: {
            checked: selectedPedidoIds.includes(pedidoId) && !Boolean(pedidoData?.revision_contacto_pendiente),
            revision_contacto_pendiente: Boolean(pedidoData?.revision_contacto_pendiente),
            revision_contacto_motivo: pedidoData?.revision_contacto_motivo || '',
            tipoEntrega: tipoEntregaInicial,
            puntoRetiroId: pedidoData?.punto_retiro_ues_id ? String(pedidoData.punto_retiro_ues_id) : null,
            puntoRetiroNombre: pedidoData?.punto_retiro_ues_nombre || '',
            payloadDireccion: {
              calle: preview?.payloadDireccion?.calle || '',
              nro_puerta: preview?.payloadDireccion?.nro_puerta || '',
              numero_apartamento: preview?.payloadDireccion?.numero_apartamento || '',
              zip_code: preview?.payloadDireccion?.zip_code || '',
              latitud: preview?.payloadDireccion?.latitud || '',
              longitud: preview?.payloadDireccion?.longitud || '',
              departamento_id: detectedDepartamentoId,
              localidad_id: detectedLocalidadId,
              observaciones: preview?.payloadDireccion?.observaciones || '',
            },
            payloadEnvio: {
              referencia: preview?.payloadEnvio?.referencia || '',
              nombre_recibe: preview?.payloadEnvio?.nombre_recibe || '',
              telefono_recibe: preview?.payloadEnvio?.telefono_recibe || '',
              email_recibe: preview?.payloadEnvio?.email_recibe || '',
              servicio_id: preview?.payloadEnvio?.servicio_id || '',
              direccion_remitente_id: preview?.payloadEnvio?.direccion_remitente_id || '',
            },
            guia: {
              comentario: guia.comentario || '',
              peso: guia.peso || '',
              ci: guia.ci || '',
              valor_declarado: guia.valor_declarado || '',
            },
          },
        };
      });

      const depId = String(
        preview?.payloadDireccion?.departamento_id || preview?.localidadUes?.departamento_id || ''
      );
      if (depId) {
        await loadLocalidades(depId);
      }

      await loadPuntosRetiro();
    } catch (error) {
      setPreviewByPedidoId((prev) => ({
        ...prev,
        [pedidoId]: {
          loading: false,
          data: null,
          error: error.message || 'No se pudo obtener el preview UES',
          pedidoDataFallback: pedidoData, // Guardar datos del pedido para usar después
          direccionParseada: error.response?.direccionParseada, // Guardar dirección parseada si está disponible
        },
      }));

      // Inicializar formulario básico - el departamento se autodetectará en useEffect
      setFormsByPedidoId((prev) => {
        if (prev[pedidoId]) return prev;

        if (!pedidoData) return prev;

        const tipoEntregaInicial = String(pedidoData?.tipo_entrega_ues || '').toLowerCase() === 'pickup'
          ? 'pickup'
          : 'domicilio';

        // Usar dirección parseada del backend si está disponible
        const direccionParseada = error.response?.direccionParseada;

        return {
          ...prev,
          [pedidoId]: {
            checked: selectedPedidoIds.includes(pedidoId) && !Boolean(pedidoData?.revision_contacto_pendiente),
            bypassValidation: false,
            revision_contacto_pendiente: Boolean(pedidoData?.revision_contacto_pendiente),
            revision_contacto_motivo: pedidoData?.revision_contacto_motivo || '',
            tipoEntrega: tipoEntregaInicial,
            puntoRetiroId: pedidoData?.punto_retiro_ues_id ? String(pedidoData.punto_retiro_ues_id) : null,
            puntoRetiroNombre: pedidoData?.punto_retiro_ues_nombre || '',
            payloadDireccion: {
              calle: direccionParseada?.calle || pedidoData.calle || pedidoData.direccion_envio || '',
              nro_puerta: direccionParseada?.numeroPuerta || pedidoData.numero_puerta || '',
              numero_apartamento: direccionParseada?.apartamento || pedidoData.apartamento || '',
              zip_code: pedidoData.codigo_postal || '11000',
              latitud: pedidoData.latitud || '',
              longitud: pedidoData.longitud || '',
              departamento_id: '', // Se autodetectará después
              localidad_id: '',
              observaciones: direccionParseada?.observaciones || '',
            },
            payloadEnvio: {
              referencia: pedidoData.numero_pedido ? `#${pedidoData.numero_pedido}` : '',
              nombre_recibe: pedidoData.cliente_nombre || '',
              telefono_recibe: pedidoData.cliente_telefono || '',
              email_recibe: pedidoData.cliente_email || '',
              servicio_id: '1473',
              direccion_remitente_id: '24225033',
            },
            guia: {
              comentario: pedidoData.numero_pedido ? `Pedido #${pedidoData.numero_pedido}` : '',
              peso: '',
              ci: '',
              valor_declarado: '',
            },
          },
        };
      });
    }
  };

  useEffect(() => {
    if (!currentPedido) return;
    ensurePreviewLoaded(currentPedido.id, currentPedido);
    setLocalidadSugerida(null); // Limpiar sugerencia al cambiar de pedido
  }, [currentPedido]);

  // Auto-geocodificar cada pedido al cargarse por primera vez
  useEffect(() => {
    if (!currentPedido?.id) return;
    if (geoResultadoByPedidoId[currentPedido.id] !== undefined) return;
    handleGeocodificar(currentPedido);
  }, [currentPedido?.id]);

  // Aplicar resultado de geocodificado al form una sola vez por resultado
  useEffect(() => {
    if (!currentPedido?.id) return;
    const geo = geoResultadoByPedidoId[currentPedido.id];
    const form = formsByPedidoId[currentPedido.id];
    // Solo aplicar si: hay resultado ok, el form está listo, y aún no se aplicó
    if (!geo?.ok || !geo.ues_id || !form) return;
    if (geoAplicadoByPedidoId[currentPedido.id]) return;
    const depId = String(geo.departamento_id);
    const locId = String(geo.ues_id);
    // Marcar como aplicado antes de actualizar para evitar loops
    setGeoAplicadoByPedidoId((prev) => ({ ...prev, [currentPedido.id]: true }));
    loadLocalidades(depId).then(() => {
      setFormsByPedidoId((prev) => {
        const existing = prev[currentPedido.id];
        if (!existing) return prev;
        return {
          ...prev,
          [currentPedido.id]: {
            ...existing,
            payloadDireccion: {
              ...existing.payloadDireccion,
              departamento_id: depId,
              localidad_id: locId,
            },
          },
        };
      });
    });
  }, [currentPedido?.id, geoResultadoByPedidoId[currentPedido?.id], formsByPedidoId[currentPedido?.id]]);

  useEffect(() => {
    if (!currentDepartamentoId) return;
    loadLocalidades(currentDepartamentoId);
  }, [currentDepartamentoId]);

  useEffect(() => {
    loadPuntosRetiro();
  }, []);

  // Autodetectar departamento cuando hay error de preview y los departamentos ya se cargaron
  useEffect(() => {
    if (!currentPedido || !currentPreview?.error || departamentos.length === 0) return;
    
    const form = formsByPedidoId[currentPedido.id];
    // Solo autodetectar si el formulario existe pero no tiene departamento asignado
    if (!form || form.payloadDireccion?.departamento_id) return;

    const pedidoData = currentPreview.pedidoDataFallback || currentPedido;
    const nombreDepartamento = String(pedidoData.departamento || '').toLowerCase().trim();
    
    if (nombreDepartamento) {
      const depEncontrado = departamentos.find(
        dep => String(dep.nombre || '').toLowerCase().trim() === nombreDepartamento
      );
      
      if (depEncontrado) {
        const depId = String(depEncontrado.id);
        console.log(`✅ Departamento autodetectado: ${depEncontrado.nombre} (ID: ${depId})`);
        
        // Actualizar el formulario con el departamento detectado
        setFormsByPedidoId((prev) => ({
          ...prev,
          [currentPedido.id]: {
            ...prev[currentPedido.id],
            payloadDireccion: {
              ...prev[currentPedido.id]?.payloadDireccion,
              departamento_id: depId,
            },
          },
        }));
        
        // Cargar localidades de este departamento
        loadLocalidades(depId);
      }
    }
  }, [currentPedido, currentPreview, departamentos, formsByPedidoId]);

  // Sugerir localidad inteligente cuando las localidades se cargan y hay error
  useEffect(() => {
    if (!currentPedido || !currentPreview?.error) return;
    if (localidadesActuales.length === 0) return;

    const pedidoData = currentPreview.pedidoDataFallback || currentPedido;
    const localidadOriginal = String(pedidoData.localidad || '').trim();
    
    if (!localidadOriginal) return;

    // Función de fuzzy matching simple
    const calcularSimilitud = (str1, str2) => {
      const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
      const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Coincidencia exacta
      if (s1 === s2) return 100;
      
      // Contiene
      if (s1.includes(s2) || s2.includes(s1)) return 80;
      
      // Levenshtein simplificado (primeras letras)
      const prefix = Math.min(s1.length, s2.length, 5);
      let matches = 0;
      for (let i = 0; i < prefix; i++) {
        if (s1[i] === s2[i]) matches++;
      }
      return (matches / prefix) * 60;
    };

    // Buscar mejor coincidencia
    let mejorMatch = null;
    let mejorScore = 0;

    for (const loc of localidadesActuales) {
      const score = calcularSimilitud(localidadOriginal, loc.nombre);
      if (score > mejorScore) {
        mejorScore = score;
        mejorMatch = { id: String(loc.id), nombre: loc.nombre, score };
      }
    }

    // Solo sugerir si el score es razonable (> 50%)
    if (mejorMatch && mejorScore > 50) {
      console.log(`💡 Localidad sugerida: ${mejorMatch.nombre} (score: ${mejorScore})`);
      setLocalidadSugerida(mejorMatch);
      
      // Auto-seleccionar la sugerencia en el formulario
      setFormsByPedidoId((prev) => ({
        ...prev,
        [currentPedido.id]: {
          ...prev[currentPedido.id],
          payloadDireccion: {
            ...prev[currentPedido.id]?.payloadDireccion,
            localidad_id: mejorMatch.id,
          },
        },
      }));
    } else {
      setLocalidadSugerida(null);
    }
  }, [currentPedido, currentPreview, localidadesActuales]);

  // Auto-completar número de puerta con "s/n" si está vacío
  useEffect(() => {
    if (!currentPedido || !currentForm) return;
    
    const nroPuerta = String(currentForm.payloadDireccion?.nro_puerta || '').trim();
    
    // Si el número de puerta está vacío, autocompletar con "s/n"
    if (!nroPuerta) {
      console.log(`💡 Autocompletando nro_puerta con "s/n" (sin número)`);
      setNumeroPuertaSugerido(true);
      
      setFormsByPedidoId((prev) => ({
        ...prev,
        [currentPedido.id]: {
          ...prev[currentPedido.id],
          payloadDireccion: {
            ...prev[currentPedido.id]?.payloadDireccion,
            nro_puerta: 's/n',
          },
        },
      }));
    } else if (nroPuerta.toLowerCase() === 's/n') {
      // Si es s/n, mantener el indicador de sugerencia
      setNumeroPuertaSugerido(true);
    } else {
      // Si tiene un valor DIFERENTE de s/n, limpiar el indicador
      setNumeroPuertaSugerido(false);
    }
  }, [currentPedido, currentForm?.payloadDireccion?.nro_puerta]);

  const updateCurrentForm = (section, key, value) => {
    if (!currentPedido) return;

    setFormsByPedidoId((prev) => ({
      ...prev,
      [currentPedido.id]: {
        ...prev[currentPedido.id],
        [section]: {
          ...(prev[currentPedido.id]?.[section] || {}),
          [key]: value,
        },
      },
    }));
  };

  const handleGeocodificar = async (pedidoOverride = null) => {
    const pedido = pedidoOverride || currentPedido;
    if (!pedido?.id) return;
    // Marcar como en progreso inmediatamente para evitar doble disparo
    setGeoResultadoByPedidoId((prev) => ({ ...prev, [pedido.id]: { loading: true } }));
    // Resetear "ya aplicado" para que este nuevo resultado se aplique al form
    setGeoAplicadoByPedidoId((prev) => ({ ...prev, [pedido.id]: false }));
    setGeocodificando(true);
    const depIdActual = formsByPedidoId[pedido.id]?.payloadDireccion?.departamento_id || null;
    try {
      const result = await geocodificarPedido(pedido.id, depIdActual);
      // Solo guardar el resultado — el useEffect de aplicación al form se encarga del resto
      setGeoResultadoByPedidoId((prev) => ({
        ...prev,
        [pedido.id]: result.success
          ? { ok: true, ...result.data }
          : { ok: false, error: result.error, google: result.google },
      }));
    } catch (err) {
      setGeoResultadoByPedidoId((prev) => ({
        ...prev,
        [pedido.id]: { ok: false, error: err.message },
      }));
    } finally {
      setGeocodificando(false);
    }
  };

  const handleDepartamentoChange = async (value) => {
    updateCurrentForm('payloadDireccion', 'departamento_id', value);
    updateCurrentForm('payloadDireccion', 'localidad_id', '');
    await loadLocalidades(value);
  };

  const handleTipoEntregaChange = async (value) => {
    if (!currentPedido) return;

    setFormsByPedidoId((prev) => ({
      ...prev,
      [currentPedido.id]: {
        ...prev[currentPedido.id],
        tipoEntrega: value,
        puntoRetiroId: value === 'pickup' ? prev[currentPedido.id]?.puntoRetiroId || null : null,
        puntoRetiroNombre: value === 'pickup' ? prev[currentPedido.id]?.puntoRetiroNombre || '' : '',
      },
    }));

    if (value === 'pickup') {
      await loadPuntosRetiro();
    }
  };

  const handlePuntoRetiroChange = (value) => {
    if (!currentPedido) return;
    const point = puntosRetiroActuales.find((p) => String(p.id) === String(value));

    setFormsByPedidoId((prev) => ({
      ...prev,
      [currentPedido.id]: {
        ...prev[currentPedido.id],
        puntoRetiroId: value || null,
        puntoRetiroNombre: point?.nombre || point?.descripcion || point?.direccion || '',
      },
    }));
  };

  const toggleCurrentChecked = () => {
    if (!currentPedido) return;
    const nextChecked = !formsByPedidoId[currentPedido.id]?.checked;

    setFormsByPedidoId((prev) => ({
      ...prev,
      [currentPedido.id]: {
        ...prev[currentPedido.id],
        checked: nextChecked,
        bypassValidation: nextChecked,
      },
    }));

    if (typeof onReviewedChange === 'function') {
      onReviewedChange(currentPedido.id, nextChecked);
    }

    setValidationError('');
  };

  const handleConfirmClick = () => {
    const groupByPedidoId = {};
    consolidacionSugerida.forEach((group) => {
      group.pedidoIds.forEach((pedidoId) => {
        groupByPedidoId[pedidoId] = group;
      });
    });

    const items = pedidos.map((pedido) => {
      const form = formsByPedidoId[pedido.id];
      const pendienteContacto = Boolean(form?.revision_contacto_pendiente);
      const group = groupByPedidoId[pedido.id] || null;
      const groupConfig = group ? consolidacionConfigByGroup[group.groupId] : null;
      const principalId = groupConfig?.principalId || group?.defaultPrincipalId || null;
      const consolidarConPedidoId = groupConfig?.enabled && principalId && pedido.id !== principalId
        ? principalId
        : null;
      const isConsolidadoSecundario = Boolean(consolidarConPedidoId);
      const validation = getFormValidation(form);
      const blockers = isConsolidadoSecundario ? [] : [...validation.blockers];
      const principalChecked = principalId ? !!formsByPedidoId[principalId]?.checked : false;

      if (pendienteContacto && !isConsolidadoSecundario) {
        blockers.push('Pendiente de contacto con cliente');
      }
      const payloadOverrides = form ? {
        tipoEntrega: form.tipoEntrega || 'domicilio',
        puntoRetiroId: form.tipoEntrega === 'pickup' ? form.puntoRetiroId || null : null,
        puntoRetiroNombre: form.tipoEntrega === 'pickup' ? form.puntoRetiroNombre || '' : '',
        payloadDireccion: form.payloadDireccion || {},
        payloadEnvio: form.payloadEnvio || {},
        guia: form.guia || {},
      } : null;

      return {
        pedidoId: pedido.id,
        checked: isConsolidadoSecundario
          ? principalChecked
          : (!!form?.checked && !pendienteContacto),
        bypassValidation: isConsolidadoSecundario ? true : !!form?.bypassValidation,
        blockers,
        consolidarConPedidoId,
        payloadOverrides: payloadOverrides,
      };
    });

    const checkedItems = items.filter((item) => item.checked);

    if (checkedItems.length === 0) {
      setValidationError('Marca al menos un pedido como revisado para generar.');
      return;
    }

    const withBlockers = checkedItems.filter(
      (item) => !item.bypassValidation && Array.isArray(item.blockers) && item.blockers.length > 0
    );
    if (withBlockers.length > 0) {
      setValidationError(`Hay ${withBlockers.length} pedido(s) con errores bloqueantes.`);
      return;
    }

    const checkedIds = new Set(checkedItems.map((item) => item.pedidoId));
    const consolidacionInvalida = checkedItems.find((item) => (
      item.consolidarConPedidoId && !checkedIds.has(item.consolidarConPedidoId)
    ));
    if (consolidacionInvalida) {
      setValidationError('Si activas consolidación, también debes marcar como revisado el pedido principal del grupo.');
      return;
    }

    setValidationError('');
    onConfirm(checkedItems);
  };

  if (!currentPedido) return null;

  const currentValidation = getFormValidation(currentForm);
  const canMarkCurrent = currentValidation.blockers.length === 0;

  const departamentoDetectadoId = String(
    currentForm?.payloadDireccion?.departamento_id ||
    currentPreview?.data?.payloadDireccion?.departamento_id ||
    currentPreview?.data?.localidadUes?.departamento_id ||
    ''
  );
  const departamentoEnOpciones = departamentos.some((d) => String(d.id) === departamentoDetectadoId);

  const localidadDetectadaId = String(
    currentForm?.payloadDireccion?.localidad_id ||
    currentPreview?.data?.payloadDireccion?.localidad_id ||
    currentPreview?.data?.localidadUes?.ues_id ||
    ''
  );
  const localidadEnOpciones = localidadesActuales.some((l) => String(l.id) === localidadDetectadaId);

  const departamentoRefNombre =
    departamentos.find((d) => String(d.id) === departamentoDetectadoId)?.nombre ||
    currentPedido.departamento ||
    'Sin nombre';

  const localidadRefNombre =
    localidadesActuales.find((l) => String(l.id) === localidadDetectadaId)?.nombre ||
    currentPreview?.data?.localidadUes?.nombre ||
    currentPedido.localidad ||
    'Sin nombre';

  const getPedidoLabel = (pedidoItem) => pedidoItem.numero_pedido || pedidoItem.id?.substring(0, 8);
  const isPedidoChecked = (pedidoId) => !!formsByPedidoId[pedidoId]?.checked;
  const isPedidoLoaded = (pedidoId) => {
    const preview = previewByPedidoId[pedidoId];
    return preview && preview.loading === false;
  };
  const getPedidoSidebarStatus = (pedidoId) => {
    const checked = isPedidoChecked(pedidoId);
    const loaded = isPedidoLoaded(pedidoId);
    const form = formsByPedidoId[pedidoId];
    const itemValidation = getFormValidation(form);
    if (form?.revision_contacto_pendiente) return { label: 'Contacto', tone: 'contact' };

    if (checked) return { label: 'Revisado', tone: 'ok' };
    if (!loaded) return { label: 'Cargando', tone: 'loading' };
    if (itemValidation.blockers.length > 0) return { label: 'Error', tone: 'error' };
    if (itemValidation.warnings.length > 0) return { label: 'Advertencia', tone: 'warn' };
    return { label: 'Pendiente', tone: 'pending' };
  };

  const sidebarSummary = useMemo(() => {
    const summary = {
      ok: 0,
      pending: 0,
      warn: 0,
      error: 0,
      contact: 0,
      loading: 0,
    };

    pedidos.forEach((pedidoItem) => {
      const tone = getPedidoSidebarStatus(pedidoItem.id).tone;
      summary[tone] = (summary[tone] || 0) + 1;
    });

    return summary;
  }, [pedidos, formsByPedidoId, previewByPedidoId]);

  const handleMarkOkAndNext = () => {
    if (!currentPedido || !canMarkCurrent) return;

    if (formsByPedidoId[currentPedido.id]?.revision_contacto_pendiente) {
      setValidationError('Este pedido está marcado como pendiente de contacto y no se puede marcar como revisado hasta resolverlo.');
      return;
    }

    if (!formsByPedidoId[currentPedido.id]?.checked) {
      setFormsByPedidoId((prev) => ({
        ...prev,
        [currentPedido.id]: {
          ...prev[currentPedido.id],
          checked: true,
        },
      }));

      if (typeof onReviewedChange === 'function') {
        onReviewedChange(currentPedido.id, true);
      }
    }

    if (isBatch) {
      if (currentVisiblePos >= 0 && currentVisiblePos < visibleIndexes.length - 1) {
        setCurrentIndex(visibleIndexes[currentVisiblePos + 1]);
      }
      return;
    }

    if (currentIndex < pedidos.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleGuardarRevisionContacto = async (pendiente) => {
    if (!currentPedido) return;

    const motivo = String(formsByPedidoId[currentPedido.id]?.revision_contacto_motivo || '').trim();
    if (pendiente && !motivo) {
      setValidationError('Debes escribir un motivo interno antes de marcar pendiente de contacto.');
      return;
    }

    if (typeof onUpdateRevisionContacto !== 'function') {
      setValidationError('No se pudo actualizar la revisión de contacto.');
      return;
    }

    const resultado = await onUpdateRevisionContacto(currentPedido.id, pendiente, motivo);
    if (!resultado?.success) {
      setValidationError(resultado?.error || 'No se pudo actualizar la revisión de contacto.');
      return;
    }

    setFormsByPedidoId((prev) => ({
      ...prev,
      [currentPedido.id]: {
        ...prev[currentPedido.id],
        revision_contacto_pendiente: pendiente,
        revision_contacto_motivo: pendiente ? motivo : '',
        checked: pendiente ? false : prev[currentPedido.id]?.checked,
      },
    }));

    if (pendiente && typeof onReviewedChange === 'function') {
      onReviewedChange(currentPedido.id, false);
    }

    setValidationError('');
  };

  return (
    <div className="modal modal-open">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>
            {isReclamoMode ? '🔄 ' : '🔍 '}
            Vista Previa de Datos - Orden #{currentPedido.numero_pedido || currentPedido.id?.substring(0, 8)}
            {isReclamoMode && <span style={{color: '#d93025', fontSize: '0.9em', marginLeft: '8px'}}>(RECLAMO - RCL)</span>}
          </h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        {isReclamoMode && (
          <div style={{
            background: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px',
            padding: '12px',
            margin: '0 16px 12px',
            fontSize: '13px'
          }}>
            <strong>⚠️ Modo Reclamo:</strong> Esta etiqueta se generará con referencia RCL{currentPedido.numero_pedido || currentPedido.id?.substring(0, 8)}. 
            Revisa y edita la dirección de envío si es necesario.
          </div>
        )}
        <div className="preview-topbar">
          {!isReclamoMode && (
            <div className="preview-counter">
              Pedido {isBatch ? Math.max(currentVisiblePos + 1, 1) : currentIndex + 1} de {isBatch ? pedidosVisibles.length : pedidos.length}
            </div>
          )}
          <div className="preview-nav-actions">
            {!isReclamoMode && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    if (isBatch) {
                      if (currentVisiblePos > 0) setCurrentIndex(visibleIndexes[currentVisiblePos - 1]);
                      return;
                    }
                    setCurrentIndex((i) => Math.max(0, i - 1));
                  }}
                  disabled={isBatch ? currentVisiblePos <= 0 : currentIndex === 0}
                >
                  ◀ Anterior
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    if (isBatch) {
                      if (currentVisiblePos >= 0 && currentVisiblePos < visibleIndexes.length - 1) setCurrentIndex(visibleIndexes[currentVisiblePos + 1]);
                      return;
                    }
                    setCurrentIndex((i) => Math.min(pedidos.length - 1, i + 1));
                  }}
                  disabled={isBatch ? (currentVisiblePos < 0 || currentVisiblePos >= visibleIndexes.length - 1) : currentIndex === pedidos.length - 1}
                >
                  Siguiente ▶
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleMarkOkAndNext} disabled={!canMarkCurrent}>✔ Marcar OK y siguiente</button>
              </>
            )}
            <button className={`btn btn-sm ${currentForm?.checked ? 'btn-success' : 'btn-warning'}`} onClick={toggleCurrentChecked}>
              {currentForm?.checked ? '✅ Revisado' : '☑ Marcar Revisado'}
            </button>
          </div>
        </div>
        
        <div className="modal-body">
          <div className="preview-layout">
            <aside className="preview-sidebar">
              <h4>{isBatch ? 'Pedidos' : 'Resumen'}</h4>
              <div className="preview-sidebar-summary">
                <span className="preview-sidebar-summary-pill ok">Revisados: {sidebarSummary.ok}</span>
                <span className="preview-sidebar-summary-pill pending">Pendientes: {sidebarSummary.pending}</span>
                <span className="preview-sidebar-summary-pill error">Errores: {sidebarSummary.error}</span>
                {sidebarSummary.contact > 0 && (
                  <span className="preview-sidebar-summary-pill contact">Contacto: {sidebarSummary.contact}</span>
                )}
                {sidebarSummary.warn > 0 && (
                  <span className="preview-sidebar-summary-pill warn">Advertencias: {sidebarSummary.warn}</span>
                )}
              </div>
              {isBatch && currentConsolidacionGroup && currentConsolidacionConfig && (
                <div className="preview-section" style={{ marginBottom: '0.75rem' }}>
                  <h4 style={{ marginBottom: '0.4rem' }}>💡 Sugerencia de consolidación</h4>
                  <span className="preview-hint" style={{ display: 'block', marginBottom: '0.45rem' }}>
                    Coinciden por celular o email y comparten el mismo estado de preparación. Es una sugerencia: tú decides activarla.
                  </span>
                  <div style={{ border: '1px solid #99f6e4', borderRadius: '8px', padding: '0.45rem', marginBottom: '0.45rem', background: '#ffffff' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.35rem' }}>
                      <input
                        type="checkbox"
                        checked={!!currentConsolidacionConfig.enabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          setConsolidacionConfigByGroup((prev) => ({
                            ...prev,
                            [currentConsolidacionGroup.groupId]: {
                              enabled,
                              principalId: prev[currentConsolidacionGroup.groupId]?.principalId || currentConsolidacionGroup.defaultPrincipalId,
                            },
                          }));
                        }}
                      />
                      <span>Consolidar {currentConsolidacionGroup.pedidoIds.length} pedidos en 1 etiqueta</span>
                    </label>

                    {currentConsolidacionConfig.enabled && (
                      <div className="preview-field preview-field-column" style={{ marginBottom: 0 }}>
                        <strong>Pedido principal:</strong>
                        <select
                          value={currentConsolidacionConfig.principalId}
                          onChange={(e) => {
                            const principalId = e.target.value;
                            setConsolidacionConfigByGroup((prev) => ({
                              ...prev,
                              [currentConsolidacionGroup.groupId]: {
                                ...prev[currentConsolidacionGroup.groupId],
                                enabled: true,
                                principalId,
                              },
                            }));
                          }}
                        >
                          {currentConsolidacionGroup.pedidoIds.map((pid) => {
                            const pedido = pedidos.find((p) => p.id === pid);
                            return (
                              <option key={pid} value={pid}>
                                #{getPedidoLabel(pedido || { id: pid })}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isBatch ? (
                <div className="preview-sidebar-list">
                  {pedidosVisibles.map((pedidoItem) => {
                    const active = pedidoItem.id === currentPedido?.id;
                    const status = getPedidoSidebarStatus(pedidoItem.id);

                    return (
                      <button
                        key={pedidoItem.id}
                        className={`preview-sidebar-item ${active ? 'active' : ''}`}
                        onClick={() => {
                          const index = pedidos.findIndex((p) => p.id === pedidoItem.id);
                          if (index >= 0) setCurrentIndex(index);
                        }}
                      >
                        <span className="preview-sidebar-item-main">#{getPedidoLabel(pedidoItem)}</span>
                        <span className={`preview-sidebar-item-status ${status.tone}`}>
                          {status.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="preview-sidebar-single">
                  <div className="preview-sidebar-single-row">
                    <span>Orden</span>
                    <strong>#{getPedidoLabel(currentPedido)}</strong>
                  </div>
                  <div className="preview-sidebar-single-row">
                    <span>Cliente</span>
                    <strong>{currentPedido.cliente_nombre || 'Sin nombre'}</strong>
                  </div>
                  <div className="preview-sidebar-single-row">
                    <span>Estado</span>
                    <span className={`preview-sidebar-item-status ${getPedidoSidebarStatus(currentPedido.id).tone}`}>
                      {getPedidoSidebarStatus(currentPedido.id).label}
                    </span>
                  </div>
                  <div className="preview-sidebar-single-note">
                    Revisa y ajusta los datos antes de generar la etiqueta.
                  </div>
                </div>
              )}
            </aside>

            <div className="preview-content">
          <div className={`preview-validation-banner ${currentValidation.blockers.length > 0 ? 'error' : currentValidation.warnings.length > 0 ? 'warn' : 'ok'}`}>
            {currentValidation.blockers.length > 0 && `${currentValidation.blockers.length} error(es) bloqueante(s)`}
            {currentValidation.blockers.length === 0 && currentValidation.warnings.length > 0 && `${currentValidation.warnings.length} advertencia(s)`}
            {currentValidation.blockers.length === 0 && currentValidation.warnings.length === 0 && 'Todo OK para este pedido'}
          </div>

          {(currentValidation.blockers.length > 0 || currentValidation.warnings.length > 0) && (
            <div className="preview-validation-list">
              {currentValidation.blockers.map((msg) => <span key={`b-${msg}`} className="tag-error">{msg}</span>)}
              {currentValidation.warnings.map((msg) => <span key={`w-${msg}`} className="tag-warn">{msg}</span>)}
            </div>
          )}

          <div className="preview-section preview-section-contact-review">
            <h4>📞 Nota Interna de Contacto</h4>
            <div className="preview-field preview-field-column">
              <strong>Motivo interno:</strong>
              <textarea
                rows={3}
                value={currentForm?.revision_contacto_motivo || ''}
                onChange={(e) => {
                  if (!currentPedido) return;
                  const value = e.target.value;
                  setFormsByPedidoId((prev) => ({
                    ...prev,
                    [currentPedido.id]: {
                      ...prev[currentPedido.id],
                      revision_contacto_motivo: value,
                    },
                  }));
                }}
                placeholder="Ej: confirmar nro de puerta, apto o referencias de entrega"
              />
              <span className="preview-hint">Esta nota es interna y se muestra en la tabla para seguimiento rápido.</span>
            </div>
            <div className="preview-contact-actions">
              <button className="btn btn-warning btn-sm" onClick={() => handleGuardarRevisionContacto(true)}>
                ⚠️ Marcar Pendiente Contacto
              </button>
              <button className="btn btn-success btn-sm" onClick={() => handleGuardarRevisionContacto(false)}>
                ✅ Contacto Resuelto
              </button>
              {currentForm?.revision_contacto_pendiente && (
                <span className="preview-contact-state">Bloqueado para generar hasta resolver contacto</span>
              )}
            </div>
          </div>

          {/* Destinatario */}
          <div className="preview-section">
            <h4>📦 Destinatario</h4>
            <div className="preview-field">
              <strong>Nombre:</strong>
              <span>{currentPedido.cliente_nombre}</span>
            </div>
            <div className="preview-field">
              <strong>Teléfono:</strong>
              <span>{currentPedido.cliente_telefono}</span>
            </div>
            <div className="preview-field">
              <strong>Email:</strong>
              <span>{currentPedido.cliente_email}</span>
            </div>
          </div>

          {/* Dirección */}
          <div className="preview-section">
            <h4>📍 Dirección de Envío</h4>
            <div className="preview-field">
              <strong>Dirección:</strong>
              <span>{currentPedido.direccion_envio}</span>
            </div>
            <div className="preview-field">
              <strong>Localidad:</strong>
              <span>{currentPedido.localidad}</span>
            </div>
            <div className="preview-field">
              <strong>Departamento:</strong>
              <span>{currentPedido.departamento}</span>
            </div>
            <div className="preview-field">
              <strong>Código Postal:</strong>
              <span>{currentPedido.codigo_postal}</span>
            </div>

            {/* Validación localidad UES */}
            <div className="preview-field" style={{ alignItems: 'flex-start', gap: '8px', marginTop: '8px' }}>
              <strong>🔎 Localidad UES:</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                {(() => {
                  const geo = geoResultadoByPedidoId[currentPedido.id];
                  if (!geo) return (
                    <span style={{ color: '#888', fontSize: '13px' }}>Sin validar</span>
                  );
                  if (geo.loading) return (
                    <span style={{ color: '#888', fontSize: '13px' }}>🔍 Validando...</span>
                  );
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      {(geo.barrioGoogleMaps || geo.localidadGoogleMaps || geo.google) && (
                        <span style={{ fontSize: '12px', color: '#555' }}>
                          🗺️ Google Maps → barrio: <em>{geo.barrioGoogleMaps || geo.google?.barrio || '—'}</em> | localidad: <em>{geo.localidadGoogleMaps || geo.google?.localidad || '—'}</em>
                        </span>
                      )}
                      {!geo.ok
                        ? <span style={{ color: '#c62828', fontSize: '13px' }}>⚠️ {geo.error}</span>
                        : <span style={{ color: '#2e7d32', fontSize: '13px' }}>✅ <strong>{geo.nombre}</strong> (ID: {geo.ues_id}, Dep: {geo.departamento_id})</span>
                      }
                    </div>
                  );
                })()}
                <button
                  onClick={handleGeocodificar}
                  disabled={geocodificando}
                  style={{
                    marginTop: '4px',
                    padding: '4px 10px',
                    fontSize: '12px',
                    cursor: geocodificando ? 'not-allowed' : 'pointer',
                    opacity: geocodificando ? 0.6 : 1,
                    alignSelf: 'flex-start',
                  }}
                >
                  {geocodificando
                    ? '🔍 Validando...'
                    : geoResultadoByPedidoId[currentPedido.id]?.loading
                      ? '🔍 Validando...'
                      : geoResultadoByPedidoId[currentPedido.id]
                        ? '🔄 Re-validar'
                        : '🔍 Validar localidad'
                  }
                </button>
              </div>
            </div>
          </div>

          <div className="preview-section preview-section-processed">
            <h4>🧭 Dirección Procesada (UES)</h4>
            {currentPreview?.loading && (
              <p className="preview-loading">Cargando payload real de UES...</p>
            )}
            {!currentPreview?.loading && currentPreview?.error && (
              <div className="preview-error-banner" style={{
                background: '#fff3cd',
                border: '2px solid #ff9800',
                borderRadius: '4px',
                padding: '12px',
                marginBottom: '16px',
                fontSize: '14px'
              }}>
                <strong>⚠️ No se pudo detectar automáticamente la localidad:</strong>
                <p style={{margin: '8px 0 0 0', fontSize: '13px', color: '#666'}}>
                  {currentPreview.error}
                </p>
                <p style={{margin: '8px 0 0 0', fontSize: '13px', fontWeight: 'bold', color: '#d93025'}}>
                  👉 Por favor, verifica manualmente que la <strong>Localidad</strong> sea la correcta{!currentForm?.payloadDireccion?.departamento_id && ' y el Departamento'}. 
                  Los demás campos ya están precargados y son editables en caso de que se requiera.
                </p>
              </div>
            )}
            {!currentPreview?.loading && currentForm && (
              <>
                <div className="preview-edit-grid">
                  <h5>guardarDireccion</h5>

                  <div className="preview-field">
                    <strong>Tipo de entrega:</strong>
                    <select
                      value={currentForm.tipoEntrega || 'domicilio'}
                      onChange={(e) => handleTipoEntregaChange(e.target.value)}
                    >
                      <option value="domicilio">A domicilio</option>
                      <option value="pickup">Pickup UES</option>
                    </select>
                  </div>

                  {currentForm.tipoEntrega === 'pickup' && (
                    <div className="preview-field preview-field-column">
                      <strong>Punto de retiro:</strong>
                      <select
                        value={currentForm.puntoRetiroId || ''}
                        onChange={(e) => handlePuntoRetiroChange(e.target.value)}
                      >
                        <option value="">Seleccionar punto de retiro</option>
                        {puntosRetiroActuales.map((point) => (
                          <option key={point.id} value={point.id}>
                            {point.nombre}{point.direccion ? ` — ${point.direccion}` : ''}
                          </option>
                        ))}
                      </select>
                      <span className="preview-hint">
                        {puntosRetiroActuales.length > 0
                          ? `${puntosRetiroActuales.length} puntos disponibles en el departamento seleccionado`
                          : currentDepartamentoId
                            ? 'Sin puntos de retiro para este departamento'
                            : 'Seleccioná un departamento para ver los puntos disponibles'}
                      </span>
                    </div>
                  )}

                  <div className="preview-field">
                    <strong>Calle:</strong>
                    <input
                      value={currentForm.payloadDireccion?.calle || ''}
                      onChange={(e) => updateCurrentForm('payloadDireccion', 'calle', e.target.value)}
                      disabled={currentForm.tipoEntrega === 'pickup'}
                    />
                  </div>
                  <div className="preview-field">
                    <strong>Nro puerta:</strong>
                    <input
                      value={currentForm.payloadDireccion?.nro_puerta || ''}
                      onChange={(e) => updateCurrentForm('payloadDireccion', 'nro_puerta', e.target.value)}
                      disabled={currentForm.tipoEntrega === 'pickup'}
                    />
                    {currentForm.tipoEntrega !== 'pickup' && numeroPuertaSugerido && currentForm.payloadDireccion?.nro_puerta?.toLowerCase() === 's/n' && (
                      <span className="preview-ref" style={{color: '#ff9800', fontWeight: 'bold'}}>
                        💡 Sug: s/n (verificar número real)
                      </span>
                    )}
                  </div>
                  <div className="preview-field">
                    <strong>Apartamento:</strong>
                    <input
                      value={currentForm.payloadDireccion?.numero_apartamento || ''}
                      onChange={(e) => updateCurrentForm('payloadDireccion', 'numero_apartamento', e.target.value)}
                      disabled={currentForm.tipoEntrega === 'pickup'}
                    />
                  </div>
                  <div className="preview-field">
                    <strong>Departamento ID:</strong>
                    <select
                      value={currentForm.payloadDireccion?.departamento_id || ''}
                      onChange={(e) => handleDepartamentoChange(e.target.value)}
                    >
                      <option value="">Seleccionar departamento</option>
                      {departamentoDetectadoId && !departamentoEnOpciones && (
                        <option value={departamentoDetectadoId}>Detectado ({departamentoDetectadoId})</option>
                      )}
                      {departamentos.map((dep) => (
                        <option key={dep.id} value={dep.id}>{dep.id} - {dep.nombre}</option>
                      ))}
                    </select>
                    <span className="preview-ref">Ref: {departamentoRefNombre}</span>
                  </div>
                  <div className="preview-field">
                    <strong>Localidad ID:</strong>
                    <select
                      value={currentForm.payloadDireccion?.localidad_id || ''}
                      onChange={(e) => updateCurrentForm('payloadDireccion', 'localidad_id', e.target.value)}
                    >
                      <option value="">Seleccionar localidad</option>
                      {localidadDetectadaId && !localidadEnOpciones && (
                        <option value={localidadDetectadaId}>Detectada ({localidadDetectadaId})</option>
                      )}
                      {localidadesActuales.map((loc) => (
                        <option key={loc.id} value={loc.id}>{loc.id} - {loc.nombre}</option>
                      ))}
                    </select>
                    {localidadSugerida && currentPreview?.error ? (
                      <span className="preview-ref" style={{color: '#1976d2', fontWeight: 'bold'}}>
                        💡 Sug: {localidadSugerida.nombre} ({Math.round(localidadSugerida.score)}% match)
                      </span>
                    ) : (
                      <span className="preview-ref">Ref: {localidadRefNombre}</span>
                    )}
                  </div>
                  <div className="preview-field preview-field-column preview-observaciones">
                    <strong>Observaciones de direccion:</strong>
                    <span className="preview-hint">Se envia a UES en guardarDireccion.observaciones.</span>
                    <textarea
                      rows={5}
                      value={currentForm.payloadDireccion?.observaciones || ''}
                      onChange={(e) => updateCurrentForm('payloadDireccion', 'observaciones', e.target.value)}
                      disabled={currentForm.tipoEntrega === 'pickup'}
                    />
                  </div>
                </div>

                <div className="preview-edit-grid preview-edit-grid-spaced">
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowTechnicalDetails((v) => !v)}>
                    {showTechnicalDetails ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
                  </button>
                </div>

                {showTechnicalDetails && (
                <div className="preview-edit-grid preview-edit-grid-spaced">
                  <h5>guardarEnvio</h5>

                  <div className="preview-field">
                    <strong>Referencia:</strong>
                    <input value={currentForm.payloadEnvio?.referencia || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'referencia', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Nombre recibe:</strong>
                    <input value={currentForm.payloadEnvio?.nombre_recibe || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'nombre_recibe', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Teléfono recibe:</strong>
                    <input value={currentForm.payloadEnvio?.telefono_recibe || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'telefono_recibe', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Email recibe:</strong>
                    <input value={currentForm.payloadEnvio?.email_recibe || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'email_recibe', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Servicio ID:</strong>
                    <input value={currentForm.payloadEnvio?.servicio_id || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'servicio_id', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Dir remitente ID:</strong>
                    <input value={currentForm.payloadEnvio?.direccion_remitente_id || ''} onChange={(e) => updateCurrentForm('payloadEnvio', 'direccion_remitente_id', e.target.value)} />
                  </div>

                  <div className="preview-field preview-field-column">
                    <strong>Destino:</strong>
                    <span className="preview-readonly">
                      {currentForm.tipoEntrega === 'pickup'
                        ? 'Se completa automáticamente con el punto de retiro seleccionado.'
                        : 'Se completa automáticamente con el ID retornado por guardarDireccion.'}
                    </span>
                  </div>

                  <h5>guia[0]</h5>
                  <div className="preview-field">
                    <strong>Comentario:</strong>
                    <input value={currentForm.guia?.comentario || ''} onChange={(e) => updateCurrentForm('guia', 'comentario', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Peso:</strong>
                    <input value={currentForm.guia?.peso || ''} onChange={(e) => updateCurrentForm('guia', 'peso', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>CI:</strong>
                    <input value={currentForm.guia?.ci || ''} onChange={(e) => updateCurrentForm('guia', 'ci', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Valor declarado:</strong>
                    <input value={currentForm.guia?.valor_declarado || ''} onChange={(e) => updateCurrentForm('guia', 'valor_declarado', e.target.value)} />
                  </div>
                </div>
                )}
              </>
            )}
          </div>

          {/* Información del envío */}
          <div className="preview-section">
            <h4>📊 Información del Envío</h4>
            <div className="preview-field">
              <strong>Fecha Pedido:</strong>
              <span>{currentPedido.fecha_pedido ? new Date(currentPedido.fecha_pedido).toLocaleDateString('es-UY') : '-'}</span>
            </div>
            <div className="preview-field">
              <strong>Estado:</strong>
              <span>{currentPedido.estado}</span>
            </div>
            <div className="preview-field">
              <strong>Costo Envío:</strong>
              <span>${parseFloat(currentPedido.costo_envio_cliente || 0).toFixed(2)}</span>
            </div>
            <div className="preview-field">
              <strong>Express:</strong>
              <span>{currentPedido.direccion_envio_express ? 'Sí' : 'No'}</span>
            </div>
          </div>

          {/* Notas si existen */}
          {currentPedido.notas && (
            <div className="preview-section">
              <h4>📝 Notas</h4>
              <p className="preview-notes-text">
                {currentPedido.notas}
              </p>
            </div>
          )}

          {validationError && <div className="preview-error preview-error-spaced">{validationError}</div>}

          <div className="preview-alert">
            {isBatch
              ? `⚠️ Marca como "Revisado" solo los pedidos que quieras generar (${checkedCount}/${pedidos.length}).`
              : '⚠️ Verifica que todos los datos sean correctos antes de generar la etiqueta'}
          </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleConfirmClick}>
            {isReclamoMode ? '🔄 Generar Etiqueta RCL' : isBatch ? '✅ Confirmar y Generar Todos' : '✅ Confirmar y Generar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DatosPreviewModal;
