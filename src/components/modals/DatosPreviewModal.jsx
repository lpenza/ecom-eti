import React, { useEffect, useMemo, useState } from 'react';
import {
  obtenerCatalogoDepartamentosUES,
  obtenerCatalogoLocalidadesUES,
  obtenerPayloadPreviewUES,
} from '../../services/api';

function DatosPreviewModal({ pedidos = [], selectedPedidoIds = [], initialIndex = 0, onReviewedChange, onClose, onConfirm }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [departamentos, setDepartamentos] = useState([]);
  const [localidadesByDep, setLocalidadesByDep] = useState({});
  const [previewByPedidoId, setPreviewByPedidoId] = useState({});
  const [formsByPedidoId, setFormsByPedidoId] = useState({});
  const [validationError, setValidationError] = useState('');
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  const currentPedido = pedidos[currentIndex] || null;
  const currentPreview = currentPedido ? previewByPedidoId[currentPedido.id] : null;
  const currentForm = currentPedido ? formsByPedidoId[currentPedido.id] : null;

  const currentDepartamentoId = String(currentForm?.payloadDireccion?.departamento_id || '');
  const localidadesActuales = useMemo(() => {
    if (!currentDepartamentoId) return [];
    return localidadesByDep[currentDepartamentoId] || [];
  }, [localidadesByDep, currentDepartamentoId]);

  const isBatch = pedidos.length > 1;
  const checkedCount = Object.values(formsByPedidoId).filter((f) => f?.checked).length;

  const getFormValidation = (form) => {
    if (!form) {
      return { blockers: ['Cargando datos del pedido'], warnings: [] };
    }

    const blockers = [];
    const warnings = [];

    if (!String(form.payloadDireccion?.calle || '').trim()) blockers.push('Falta calle');
    if (!String(form.payloadDireccion?.nro_puerta || '').trim()) blockers.push('Falta número de puerta');
    if (!String(form.payloadDireccion?.departamento_id || '').trim()) blockers.push('Falta departamento');
    if (!String(form.payloadDireccion?.localidad_id || '').trim()) blockers.push('Falta localidad');
    if (!String(form.payloadEnvio?.nombre_recibe || '').trim()) blockers.push('Falta nombre destinatario');
    if (!String(form.payloadEnvio?.telefono_recibe || '').trim()) blockers.push('Falta teléfono destinatario');

    if (!String(form.payloadEnvio?.email_recibe || '').trim()) warnings.push('Sin email destinatario');
    if (!String(form.payloadDireccion?.observaciones || '').trim()) warnings.push('Sin observaciones');

    return { blockers, warnings };
  };

  useEffect(() => {
    setCurrentIndex(initialIndex);
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

  const ensurePreviewLoaded = async (pedidoId) => {
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
            checked: selectedPedidoIds.includes(pedidoId),
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
    } catch (error) {
      setPreviewByPedidoId((prev) => ({
        ...prev,
        [pedidoId]: {
          loading: false,
          data: null,
          error: error.message || 'No se pudo obtener el preview UES',
        },
      }));
    }
  };

  useEffect(() => {
    if (!currentPedido) return;
    ensurePreviewLoaded(currentPedido.id);
  }, [currentPedido]);

  useEffect(() => {
    if (!currentDepartamentoId) return;
    loadLocalidades(currentDepartamentoId);
  }, [currentDepartamentoId]);

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

  const handleDepartamentoChange = async (value) => {
    updateCurrentForm('payloadDireccion', 'departamento_id', value);
    updateCurrentForm('payloadDireccion', 'localidad_id', '');
    await loadLocalidades(value);
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
    const items = pedidos.map((pedido) => {
      const form = formsByPedidoId[pedido.id];
      const validation = getFormValidation(form);
      return {
        pedidoId: pedido.id,
        checked: !!form?.checked,
        bypassValidation: !!form?.bypassValidation,
        blockers: validation.blockers,
        payloadOverrides: {
          payloadDireccion: form?.payloadDireccion || {},
          payloadEnvio: form?.payloadEnvio || {},
          guia: form?.guia || {},
        },
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
  const isPedidoLoaded = (pedidoId) => !!previewByPedidoId[pedidoId]?.data;

  const handleMarkOkAndNext = () => {
    if (!currentPedido || !canMarkCurrent) return;

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

    if (currentIndex < pedidos.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  };

  return (
    <div className="modal" style={{ display: 'flex' }}>
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>🔍 Vista Previa de Datos - Orden #{currentPedido.numero_pedido || currentPedido.id?.substring(0, 8)}</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <div className="preview-topbar">
          <div className="preview-counter">
            Pedido {currentIndex + 1} de {pedidos.length}
          </div>
          <div className="preview-nav-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))} disabled={currentIndex === 0}>◀ Anterior</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCurrentIndex((i) => Math.min(pedidos.length - 1, i + 1))} disabled={currentIndex === pedidos.length - 1}>Siguiente ▶</button>
            <button className="btn btn-primary btn-sm" onClick={handleMarkOkAndNext} disabled={!canMarkCurrent}>✔ Marcar OK y siguiente</button>
            <button className={`btn btn-sm ${currentForm?.checked ? 'btn-success' : 'btn-warning'}`} onClick={toggleCurrentChecked}>
              {currentForm?.checked ? '✅ Revisado' : '☑ Marcar Revisado'}
            </button>
          </div>
        </div>
        
        <div className="modal-body">
          <div className={`preview-layout ${isBatch ? 'preview-layout-batch' : ''}`}>
            {isBatch && (
              <aside className="preview-sidebar">
                <h4>Pedidos</h4>
                <div className="preview-sidebar-list">
                  {pedidos.map((pedidoItem, index) => {
                    const active = index === currentIndex;
                    const checked = isPedidoChecked(pedidoItem.id);
                    const loaded = isPedidoLoaded(pedidoItem.id);
                    const itemValidation = getFormValidation(formsByPedidoId[pedidoItem.id]);

                    return (
                      <button
                        key={pedidoItem.id}
                        className={`preview-sidebar-item ${active ? 'active' : ''}`}
                        onClick={() => setCurrentIndex(index)}
                      >
                        <span className="preview-sidebar-item-main">#{getPedidoLabel(pedidoItem)}</span>
                        <span className={`preview-sidebar-item-status ${checked ? 'ok' : 'pending'}`}>
                          {checked
                            ? 'Revisado'
                            : !loaded
                              ? 'Cargando'
                              : itemValidation.blockers.length > 0
                                ? 'Error'
                                : itemValidation.warnings.length > 0
                                  ? 'Advertencia'
                                  : 'Pendiente'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>
            )}

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
          </div>

          <div className="preview-section preview-section-processed">
            <h4>🧭 Dirección Procesada (UES)</h4>
            {currentPreview?.loading && (
              <p className="preview-loading">Cargando payload real de UES...</p>
            )}
            {!currentPreview?.loading && currentPreview?.error && (
              <p className="preview-error">{currentPreview.error}</p>
            )}
            {!currentPreview?.loading && !currentPreview?.error && currentForm && (
              <>
                <div className="preview-edit-grid">
                  <h5>guardarDireccion</h5>

                  <div className="preview-field">
                    <strong>Calle:</strong>
                    <input value={currentForm.payloadDireccion?.calle || ''} onChange={(e) => updateCurrentForm('payloadDireccion', 'calle', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Nro puerta:</strong>
                    <input value={currentForm.payloadDireccion?.nro_puerta || ''} onChange={(e) => updateCurrentForm('payloadDireccion', 'nro_puerta', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Apartamento:</strong>
                    <input value={currentForm.payloadDireccion?.numero_apartamento || ''} onChange={(e) => updateCurrentForm('payloadDireccion', 'numero_apartamento', e.target.value)} />
                  </div>
                  <div className="preview-field">
                    <strong>Departamento ID:</strong>
                    <select value={currentForm.payloadDireccion?.departamento_id || ''} onChange={(e) => handleDepartamentoChange(e.target.value)}>
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
                    <select value={currentForm.payloadDireccion?.localidad_id || ''} onChange={(e) => updateCurrentForm('payloadDireccion', 'localidad_id', e.target.value)}>
                      <option value="">Seleccionar localidad</option>
                      {localidadDetectadaId && !localidadEnOpciones && (
                        <option value={localidadDetectadaId}>Detectada ({localidadDetectadaId})</option>
                      )}
                      {localidadesActuales.map((loc) => (
                        <option key={loc.id} value={loc.id}>{loc.id} - {loc.nombre}</option>
                      ))}
                    </select>
                    <span className="preview-ref">Ref: {localidadRefNombre}</span>
                  </div>
                  <div className="preview-field preview-field-column preview-observaciones">
                    <strong>Observaciones de direccion:</strong>
                    <span className="preview-hint">Se envia a UES en guardarDireccion.observaciones.</span>
                    <textarea rows={5} value={currentForm.payloadDireccion?.observaciones || ''} onChange={(e) => updateCurrentForm('payloadDireccion', 'observaciones', e.target.value)} />
                  </div>
                </div>

                <div className="preview-edit-grid" style={{ marginTop: '1rem' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowTechnicalDetails((v) => !v)}>
                    {showTechnicalDetails ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
                  </button>
                </div>

                {showTechnicalDetails && (
                <div className="preview-edit-grid" style={{ marginTop: '1rem' }}>
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
                    <span className="preview-readonly">Se completa automáticamente con el ID retornado por guardarDireccion.</span>
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
              <p style={{ margin: '0.5rem 0', fontSize: '0.9rem', color: '#666' }}>
                {currentPedido.notas}
              </p>
            </div>
          )}

          {validationError && <div className="preview-error" style={{ marginTop: '0.75rem' }}>{validationError}</div>}

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
            {isBatch ? '✅ Confirmar y Generar Todos' : '✅ Confirmar y Generar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DatosPreviewModal;
