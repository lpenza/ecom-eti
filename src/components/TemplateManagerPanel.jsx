import React, { useMemo, useState, useEffect, useRef } from 'react';

function TemplateManagerPanel({
  templates = [],
  htmlTemplates = [],
  activeTemplateId,
  activeHtmlTemplateId,
  onActiveTemplateChange,
  onActiveHtmlTemplateChange,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  onDuplicateTemplate,
  onBackToFollowUp,
  mostrarToast,
}) {
  const [templateMode, setTemplateMode] = useState('whatsapp'); // whatsapp | html
  const [showPreview, setShowPreview] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState('');

  // Estado local para edición sin causar re-renders
  const [localName, setLocalName] = useState('');
  const [localBody, setLocalBody] = useState('');
  const nameTimeoutRef = useRef(null);
  const bodyTimeoutRef = useRef(null);

  const sampleData = {
    cliente_nombre: 'María García',
    cliente_email: 'maria@ejemplo.com',
    numero_pedido: '#12345',
    direccion_envio: 'Av. Corrientes 1234, Piso 2',
    localidad: 'Buenos Aires',
    departamento: 'CABA',
    tracking: 'ARG123456789',
    tracking_url: 'https://www.correoargentino.com.ar/seguimiento',
    dias_transcurridos: '5',
    fecha_objetivo: '10/04/2026',
    motivo_contacto: 'datos de envío incompletos',
  };

  const previewHtml = useMemo(() => {
    if (!localBody) return '<p style="color:#999;font-family:sans-serif">Escribí el HTML en el editor para ver la vista previa.</p>';
    return Object.entries(sampleData).reduce(
      (html, [key, val]) => html.replaceAll(`{{${key}}}`, val),
      localBody
    );
  }, [localBody]);
  
  const templateVars = [
    '{{cliente_nombre}}',
    '{{cliente_email}}',
    '{{numero_pedido}}',
    '{{direccion_envio}}',
    '{{localidad}}',
    '{{departamento}}',
    '{{tracking}}',
    '{{tracking_url}}',
    '{{dias_transcurridos}}',
    '{{fecha_objetivo}}',
    '{{motivo_contacto}}',
  ];

  const currentTemplates = templateMode === 'html' ? htmlTemplates : templates;
  const currentActiveId = templateMode === 'html' ? activeHtmlTemplateId : activeTemplateId;

  const activeTemplate = useMemo(
    () => currentTemplates.find((tpl) => tpl.id === currentActiveId) || currentTemplates[0] || null,
    [currentTemplates, currentActiveId]
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
      await onCreateTemplate({ name, content, kind: templateMode });
      setNewName('');
      setNewBody('');
    } catch (error) {
      console.error('Error creando plantilla:', error);
    }
  };

  const handleDelete = async () => {
    if (!activeTemplate) return;
    if (currentTemplates.length <= 1) {
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
        await onUpdateTemplate(activeTemplate.id, { name: newName }, templateMode);
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
        await onUpdateTemplate(activeTemplate.id, { content: newBody }, templateMode);
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
            <p>Gestiona plantillas de WhatsApp y plantillas HTML completas para email masivo.</p>
          </div>
          <div className="template-manager-top-actions">
            <button type="button" className="btn btn-secondary" onClick={onBackToFollowUp}>
              Volver a Follow-Up
            </button>
          </div>
        </div>

        <div className="template-manager-top-actions" style={{ marginBottom: '12px' }}>
          <button
            type="button"
            className={`btn ${templateMode === 'whatsapp' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTemplateMode('whatsapp')}
          >
            💬 Plantillas WhatsApp
          </button>
          <button
            type="button"
            className={`btn ${templateMode === 'html' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTemplateMode('html')}
          >
            ✉️ Plantillas HTML Email
          </button>
        </div>

        <div className="template-manager-grid">
          <section className="template-manager-card template-manager-card-main">
            <div className="template-manager-card-head">
              <h4>{templateMode === 'html' ? 'Plantilla HTML activa' : 'Plantilla WhatsApp activa'}</h4>
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
              onChange={(e) => {
                if (templateMode === 'html') {
                  onActiveHtmlTemplateChange?.(e.target.value);
                  return;
                }
                onActiveTemplateChange?.(e.target.value);
              }}
            >
              {currentTemplates.map((tpl) => (
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
                  <label className="module-label" htmlFor="tpl-manager-body">
                    {templateMode === 'html' ? 'HTML completo' : 'Mensaje'}
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="template-manager-counter">{(localBody || '').length} caracteres</span>
                    {templateMode === 'html' && (
                      <button
                        type="button"
                        className={`btn btn-sm ${showPreview ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setShowPreview((v) => !v)}
                        title={showPreview ? 'Volver al editor' : 'Ver vista previa con datos de ejemplo'}
                      >
                        {showPreview ? '✏️ Editar' : '👁 Vista previa'}
                      </button>
                    )}
                  </div>
                </div>
                {templateMode === 'html' && showPreview ? (
                  <iframe
                    title="Vista previa HTML"
                    sandbox=""
                    srcDoc={previewHtml}
                    style={{
                      width: '100%',
                      height: '480px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      background: '#fff',
                    }}
                  />
                ) : (
                  <textarea
                    id="tpl-manager-body"
                    className="module-input"
                    rows={templateMode === 'html' ? 18 : 12}
                    value={localBody}
                    onChange={(e) => handleBodyChange(e.target.value)}
                  />
                )}
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
                rows={templateMode === 'html' ? 10 : 8}
                placeholder={templateMode === 'html'
                  ? 'Pegá HTML completo con estilos inline o bloques <style> y variables {{...}}'
                  : 'Usa variables como {{cliente_nombre}}, {{numero_pedido}}, etc.'}
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
