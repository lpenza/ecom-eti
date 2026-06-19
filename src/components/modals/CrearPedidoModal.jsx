import React, { useEffect, useMemo, useState } from 'react';
import { buscarProductosAtencion, crearPedidoAtencion } from '../../services/api';

// Modal para que atención al cliente arme un pedido eligiendo productos del catálogo de
// Shopify y obtenga el link de checkout (invoice_url del Draft Order) para pasárselo al cliente.
export default function CrearPedidoModal({ onClose, mostrarToast }) {
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [lineItems, setLineItems] = useState([]); // [{ key, variantId, nombre, precio, quantity }]
  const [cliente, setCliente] = useState({ nombre: '', email: '', telefono: '', nota: '' });
  const [creando, setCreando] = useState(false);
  const [checkout, setCheckout] = useState(null); // { checkoutUrl, name, total, currency }
  const [copiado, setCopiado] = useState(false);

  // Búsqueda de productos con debounce contra el servidor.
  useEffect(() => {
    const q = busqueda.trim();
    if (q.length < 2) { setResultados([]); return; }
    let cancelado = false;
    setBuscando(true);
    const timer = setTimeout(async () => {
      try {
        const res = await buscarProductosAtencion(q);
        if (cancelado) return;
        setResultados(res?.success ? (res.data || []) : []);
        if (res && !res.success) mostrarToast?.(res.error || 'Error buscando productos', 'error');
      } catch (err) {
        if (!cancelado) mostrarToast?.(`Error: ${err.message}`, 'error');
      } finally {
        if (!cancelado) setBuscando(false);
      }
    }, 400);
    return () => { cancelado = true; clearTimeout(timer); };
  }, [busqueda, mostrarToast]);

  const agregarVariante = (producto, variante) => {
    setLineItems((prev) => {
      const existente = prev.find((li) => li.variantId === variante.id);
      if (existente) {
        return prev.map((li) => li.variantId === variante.id ? { ...li, quantity: li.quantity + 1 } : li);
      }
      const nombre = variante.titulo ? `${producto.titulo} — ${variante.titulo}` : producto.titulo;
      return [...prev, {
        key: variante.id,
        variantId: variante.id,
        nombre,
        sku: variante.sku,
        precio: variante.precio,
        quantity: 1,
      }];
    });
  };

  const cambiarCantidad = (key, delta) => {
    setLineItems((prev) => prev
      .map((li) => li.key === key ? { ...li, quantity: Math.max(1, li.quantity + delta) } : li)
    );
  };

  const setCantidad = (key, value) => {
    const n = Math.max(1, parseInt(value, 10) || 1);
    setLineItems((prev) => prev.map((li) => li.key === key ? { ...li, quantity: n } : li));
  };

  const quitarItem = (key) => setLineItems((prev) => prev.filter((li) => li.key !== key));

  const subtotal = useMemo(
    () => lineItems.reduce((acc, li) => acc + (parseFloat(li.precio) || 0) * li.quantity, 0),
    [lineItems]
  );

  const handleCrear = async () => {
    if (lineItems.length === 0) {
      mostrarToast?.('Agregá al menos un producto', 'warning');
      return;
    }
    setCreando(true);
    try {
      const res = await crearPedidoAtencion({
        lineItems: lineItems.map((li) => ({ variantId: li.variantId, quantity: li.quantity })),
        email: cliente.email.trim(),
        nombre: cliente.nombre.trim(),
        telefono: cliente.telefono.trim(),
        nota: cliente.nota.trim(),
      });
      if (res?.success && res.data?.checkoutUrl) {
        setCheckout(res.data);
        mostrarToast?.('✅ Pedido creado. Link de checkout listo.', 'success');
      } else {
        mostrarToast?.(res?.error || 'No se pudo crear el pedido', 'error');
      }
    } catch (err) {
      mostrarToast?.(`Error: ${err.message}`, 'error');
    } finally {
      setCreando(false);
    }
  };

  const copiarLink = async () => {
    if (!checkout?.checkoutUrl) return;
    try {
      await navigator.clipboard.writeText(checkout.checkoutUrl);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      mostrarToast?.('No se pudo copiar. Copialo manualmente.', 'warning');
    }
  };

  const enviarWhatsApp = () => {
    const digits = cliente.telefono.replace(/\D/g, '');
    const texto = encodeURIComponent(`¡Hola! Te dejo el link para completar tu compra: ${checkout.checkoutUrl}`);
    const base = digits ? `https://wa.me/${digits}?text=${texto}` : `https://wa.me/?text=${texto}`;
    window.open(base, '_blank');
  };

  const money = (valor) => {
    const n = parseFloat(valor) || 0;
    return `$ ${n.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="modal modal-open" onClick={onClose}>
      <div className="modal-content modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🛒 Crear pedido en Shopify</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {checkout ? (
            // ── Resultado: link de checkout ──────────────────────────────────
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div style={{
                background: '#e8f5e9', border: '1px solid #81c784', borderRadius: 10,
                padding: '1rem', textAlign: 'center',
              }}>
                <div style={{ fontSize: 14, color: '#2e7d32', fontWeight: 600 }}>
                  ✅ Pedido {checkout.name} creado
                </div>
                <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
                  Total: {money(checkout.total)} {checkout.currency || ''}
                </div>
              </div>

              <label style={{ fontWeight: 600, fontSize: 13 }}>Link de checkout para el cliente</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="module-input" readOnly value={checkout.checkoutUrl} style={{ flex: 1 }} />
                <button className="btn btn-primary btn-sm" onClick={copiarLink} style={{ whiteSpace: 'nowrap' }}>
                  {copiado ? '✅ Copiado' : '📋 Copiar'}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a className="btn btn-secondary btn-sm" href={checkout.checkoutUrl} target="_blank" rel="noopener noreferrer">
                  🔗 Abrir checkout
                </a>
                <button className="btn btn-secondary btn-sm" onClick={enviarWhatsApp}>
                  💬 Enviar por WhatsApp
                </button>
              </div>

              <p style={{ fontSize: 12, color: '#777', margin: 0 }}>
                El pedido queda como <strong>borrador</strong> en Shopify y se confirma automáticamente
                cuando el cliente paga desde este link.
              </p>
            </div>
          ) : (
            // ── Armado del pedido ────────────────────────────────────────────
            <>
              <div>
                <label style={{ fontWeight: 600, fontSize: 13 }}>Buscar producto</label>
                <input
                  className="module-input"
                  placeholder="Nombre o SKU del producto…"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  style={{ marginTop: 4 }}
                  autoFocus
                />
                {buscando && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Buscando…</div>}

                {resultados.length > 0 && (
                  <div style={{
                    border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 6,
                    maxHeight: 220, overflowY: 'auto',
                  }}>
                    {resultados.map((prod) => (
                      <div key={prod.id} style={{ padding: '6px 10px', borderBottom: '1px solid #f1f1f1' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {prod.imagen && (
                            <img src={prod.imagen} alt="" width={28} height={28}
                              style={{ borderRadius: 4, objectFit: 'cover' }} />
                          )}
                          <strong style={{ fontSize: 13 }}>{prod.titulo}</strong>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                          {prod.variantes.map((v) => (
                            <button
                              key={v.id}
                              className="btn btn-secondary btn-sm"
                              onClick={() => agregarVariante(prod, v)}
                              title={v.disponible ? 'Agregar al pedido' : 'Sin stock'}
                              style={{ fontSize: 12, opacity: v.disponible ? 1 : 0.6 }}
                            >
                              + {v.titulo || 'Único'} · {money(v.precio)}
                              {v.stock !== null ? ` (${v.stock})` : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Ítems del pedido */}
              <div>
                <label style={{ fontWeight: 600, fontSize: 13 }}>Productos en el pedido</label>
                {lineItems.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#999', padding: '8px 0' }}>
                    Todavía no agregaste productos.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                    {lineItems.map((li) => (
                      <div key={li.key} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        border: '1px solid #eee', borderRadius: 6, padding: '6px 8px',
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {li.nombre}
                          </div>
                          <div style={{ fontSize: 11, color: '#888' }}>
                            {money(li.precio)} c/u{li.sku ? ` · ${li.sku}` : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => cambiarCantidad(li.key, -1)}>−</button>
                          <input
                            value={li.quantity}
                            onChange={(e) => setCantidad(li.key, e.target.value)}
                            inputMode="numeric"
                            style={{ width: 42, textAlign: 'center', padding: '2px 4px' }}
                          />
                          <button className="btn btn-secondary btn-sm" onClick={() => cambiarCantidad(li.key, 1)}>+</button>
                        </div>
                        <div style={{ width: 80, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>
                          {money((parseFloat(li.precio) || 0) * li.quantity)}
                        </div>
                        <button className="btn-close" onClick={() => quitarItem(li.key)} title="Quitar">✕</button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, fontWeight: 700, fontSize: 14, paddingTop: 4 }}>
                      <span>Subtotal:</span>
                      <span>{money(subtotal)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Datos del cliente (opcionales) */}
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  Datos del cliente (opcional)
                </summary>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                  <input className="module-input" placeholder="Nombre"
                    value={cliente.nombre} onChange={(e) => setCliente((c) => ({ ...c, nombre: e.target.value }))} />
                  <input className="module-input" placeholder="Teléfono"
                    value={cliente.telefono} onChange={(e) => setCliente((c) => ({ ...c, telefono: e.target.value }))} />
                  <input className="module-input" placeholder="Email" type="email"
                    value={cliente.email} onChange={(e) => setCliente((c) => ({ ...c, email: e.target.value }))}
                    style={{ gridColumn: '1 / -1' }} />
                  <input className="module-input" placeholder="Nota interna (opcional)"
                    value={cliente.nota} onChange={(e) => setCliente((c) => ({ ...c, nota: e.target.value }))}
                    style={{ gridColumn: '1 / -1' }} />
                </div>
              </details>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '1rem 1.5rem' }}>
          {checkout ? (
            <button className="btn btn-primary" onClick={onClose}>Listo</button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose} disabled={creando}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCrear} disabled={creando || lineItems.length === 0}>
                {creando ? 'Creando…' : '🔗 Crear y generar link de checkout'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
