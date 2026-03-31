import React, { useMemo, useState } from 'react';

function TemplateManagerPanel({
  templates = [],
  activeTemplateId,
  onActiveTemplateChange,
  onTemplatesChange,
  onBackToFollowUp,
  mostrarToast,
}) {
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState('');

  const templateVars = [
    '{{cliente_nombre}}',
    '{{numero_pedido}}',
    '{{tracking}}',
    '{{dias_transcurridos}}',
    '{{fecha_objetivo}}',
  ];

  const activeTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === activeTemplateId) || templates[0] || null,
    [templates, activeTemplateId]
  );

  const handleCreate = () => {
    const name = String(newName || '').trim();
    const body = String(newBody || '').trim();

    if (!name || !body) {
      mostrarToast?.('Completa nombre y contenido para crear la plantilla', 'warning');
      return;
    }

    const next = {
      id: `tpl-${Date.now()}`,
      name,
      body,
    };

    onTemplatesChange((prev) => [...prev, next]);
    onActiveTemplateChange?.(next.id);
    setNewName('');
    setNewBody('');
    mostrarToast?.('✅ Plantilla creada', 'success');
  };

  const handleDelete = () => {
    if (!activeTemplate) return;
    if (templates.length <= 1) {
      mostrarToast?.('Debe existir al menos una plantilla', 'warning');
      return;
    }

    onTemplatesChange((prev) => prev.filter((tpl) => tpl.id !== activeTemplate.id));
    const fallback = templates.find((tpl) => tpl.id !== activeTemplate.id);
    onActiveTemplateChange?.(fallback?.id || '');
    mostrarToast?.('🗑️ Plantilla eliminada', 'info');
  };

  return (
    <div className="main-content template-manager-shell">
      <div className="module-panel template-manager-panel">
        <div className="template-manager-header">
          <div>
            <h3>Plantillas de Mensajes</h3>
            <p>Gestiona las plantillas para el Follow-Up. La creacion y mantenimiento viven en este modulo.</p>
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
              {activeTemplate && (
                <button type="button" className="btn btn-danger btn-sm" onClick={handleDelete}>
                  Eliminar plantilla
                </button>
              )}
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
                  value={activeTemplate.name}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    onTemplatesChange((prev) => prev.map((tpl) => (
                      tpl.id === activeTemplate.id ? { ...tpl, name: nextName } : tpl
                    )));
                  }}
                />

                <div className="template-manager-subhead">
                  <label className="module-label" htmlFor="tpl-manager-body">Mensaje</label>
                  <span className="template-manager-counter">{activeTemplate.body.length} caracteres</span>
                </div>
                <textarea
                  id="tpl-manager-body"
                  className="module-input"
                  rows={12}
                  value={activeTemplate.body}
                  onChange={(e) => {
                    const nextBody = e.target.value;
                    onTemplatesChange((prev) => prev.map((tpl) => (
                      tpl.id === activeTemplate.id ? { ...tpl, body: nextBody } : tpl
                    )));
                  }}
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
                placeholder="Usa variables como {{cliente_nombre}}, {{numero_pedido}}, {{dias_transcurridos}}"
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
