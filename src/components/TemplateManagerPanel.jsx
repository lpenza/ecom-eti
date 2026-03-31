import React, { useMemo, useState, useEffect, useRef } from 'react';

function TemplateManagerPanel({
  templates = [],
  activeTemplateId,
  onActiveTemplateChange,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  onDuplicateTemplate,
  onBackToFollowUp,
  mostrarToast,
}) {
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState('');
  
  // Estado local para edición sin causar re-renders
  const [localName, setLocalName] = useState('');
  const [localBody, setLocalBody] = useState('');
  const nameTimeoutRef = useRef(null);
  const bodyTimeoutRef = useRef(null);

  const templateVars = [
    '{{cliente_nombre}}',
    '{{numero_pedido}}',
    '{{tracking}}',
    '{{tracking_url}}',
    '{{dias_transcurridos}}',
    '{{fecha_objetivo}}',
  ];

  const activeTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === activeTemplateId) || templates[0] || null,
    [templates, activeTemplateId]
  );

  // Sincronizar estado local cuando cambia la plantilla activa
  useEffect(() => {
    console.log('🔄 Plantilla activa cambió:', activeTemplate);
    if (activeTemplate) {
      setLocalName(activeTemplate.name || '');
      setLocalBody(activeTemplate.content || '');
      console.log('✅ Local state actualizado:', { name: activeTemplate.name, content: activeTemplate.content });
    }
  }, [activeTemplate?.id]); // Solo cuando cambia de plantilla, no en cada edit

  // Limpiar timeouts al desmontar
  useEffect(() => {
    return () => {
      if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current);
      if (bodyTimeoutRef.current) clearTimeout(bodyTimeoutRef.current);
    };
  }, []);

  const handleCreate = async () => {
    const name = String(newName || '').trim();
    const content = String(newBody || '').trim();

    if (!name || !content) {
      mostrarToast?.('Completa nombre y contenido para crear la plantilla', 'warning');
      return;
    }

    try {
      await onCreateTemplate({ name, content });
      setNewName('');
      setNewBody('');
    } catch (error) {
      console.error('Error creando plantilla:', error);
    }
  };

  const handleDelete = async () => {
    if (!activeTemplate) return;
    if (templates.length <= 1) {
      mostrarToast?.('Debe existir al menos una plantilla', 'warning');
      return;
    }

    try {
      await onDeleteTemplate(activeTemplate.id);
    } catch (error) {
      console.error('Error eliminando plantilla:', error);
    }
  };

  const handleDuplicate = async () => {
    if (!activeTemplate) return;

    try {
      await onDuplicateTemplate(activeTemplate);
    } catch (error) {
      console.error('Error duplicando plantilla:', error);
    }
  };

  const handleNameChange = (newName) => {
    if (!activeTemplate) return;
    
    // Actualizar estado local inmediatamente
    setLocalName(newName);
    
    // Cancelar timeout anterior
    if (nameTimeoutRef.current) {
      clearTimeout(nameTimeoutRef.current);
    }
    
    // Guardar en DB después de 500ms de inactividad
    nameTimeoutRef.current = setTimeout(async () => {
      try {
        await onUpdateTemplate(activeTemplate.id, { name: newName });
      } catch (error) {
        console.error('Error actualizando nombre:', error);
      }
    }, 500);
  };

  const handleBodyChange = (newBody) => {
    if (!activeTemplate) return;
    
    // Actualizar estado local inmediatamente
    setLocalBody(newBody);
    
    // Cancelar timeout anterior
    if (bodyTimeoutRef.current) {
      clearTimeout(bodyTimeoutRef.current);
    }
    
    // Guardar en DB después de 500ms de inactividad
    bodyTimeoutRef.current = setTimeout(async () => {
      try {
        await onUpdateTemplate(activeTemplate.id, { content: newBody });
      } catch (error) {
        console.error('Error actualizando contenido:', error);
      }
    }, 500);
  };

  return (
    <div className="main-content template-manager-shell">
      <div className="module-panel template-manager-panel">
        <div className="template-manager-header">
          <div>
            <h3>Plantillas de Mensajes</h3>
            <p>Gestiona las plantillas para Follow-Up y Notificaciones de Tracking.</p>
          </div>
          <div className="template-manager-top-actions">
            <button type="button" className="btn btn-secondary" onClick={onBackToFollowUp}>
              Volver a Follow-Up
            </button>
          </div>
        </div>

        <div className="template-manager-grid">
          <section className="template-manager-card template-manager-card-main">
            <div className="template-manager-card-head">
              <h4>Plantilla activa</h4>
              <div style={{ display: 'flex', gap: '8px' }}>
                {activeTemplate && (
                  <>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleDuplicate}>
                      Duplicar
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={handleDelete}>
                      Eliminar
                    </button>
                  </>
                )}
              </div>
            </div>

            <label className="module-label" htmlFor="tpl-manager-active">Seleccion</label>
            <select
              id="tpl-manager-active"
              className="module-input"
              value={activeTemplate?.id || ''}
              onChange={(e) => onActiveTemplateChange?.(e.target.value)}
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>

            {activeTemplate && (
              <>
                <label className="module-label" htmlFor="tpl-manager-name">Nombre</label>
                <input
                  id="tpl-manager-name"
                  className="module-input"
                  value={localName}
                  onChange={(e) => handleNameChange(e.target.value)}
                />

                <div className="template-manager-subhead">
                  <label className="module-label" htmlFor="tpl-manager-body">Mensaje</label>
                  <span className="template-manager-counter">{(localBody || '').length} caracteres</span>
                </div>
                <textarea
                  id="tpl-manager-body"
                  className="module-input"
                  rows={12}
                  value={localBody}
                  onChange={(e) => handleBodyChange(e.target.value)}
                />
              </>
            )}
          </section>

          <div className="template-manager-side">
            <section className="template-manager-card">
              <h4>Nueva plantilla</h4>
              <label className="module-label" htmlFor="tpl-manager-new-name">Nombre</label>
              <input
                id="tpl-manager-new-name"
                className="module-input"
                placeholder="Ej: Seguimiento Pago Pendiente"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />

              <label className="module-label" htmlFor="tpl-manager-new-body">Texto</label>
              <textarea
                id="tpl-manager-new-body"
                className="module-input"
                rows={8}
                placeholder="Usa variables como {{cliente_nombre}}, {{numero_pedido}}, etc."
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
              />

              <div className="template-manager-actions">
                <button type="button" className="btn btn-primary" onClick={handleCreate}>
                  Crear plantilla
                </button>
              </div>
            </section>

            <section className="template-manager-card template-manager-card-info">
              <h4>Variables disponibles</h4>
              <p className="template-manager-help">Usalas dentro del mensaje para personalizar automaticamente cada envio.</p>
              <div className="template-manager-vars">
                {templateVars.map((v) => (
                  <span key={v}>{v}</span>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TemplateManagerPanel;
