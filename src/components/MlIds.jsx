import React, { useState } from 'react';

// Número de venta y de envío de MercadoLibre, a la vista, para buscar el pedido
// en el panel de ML sin abrir nada. En un carrito ML muestra el pack como número
// de venta (es el que aparece en "Ventas" de ML); el order_id queda en el title.
// Click en un número = copiarlo.
export default function MlIds({ pedido, compact = false }) {
  const [copiado, setCopiado] = useState(null);
  if (!pedido || pedido.origen !== 'mercadolibre') return null;

  const venta = pedido.ml_pack_id || pedido.ml_order_id;
  const envio = pedido.ml_shipment_id;
  if (!venta && !envio) return null;

  const copiar = async (e, valor, clave) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(valor));
      setCopiado(clave);
      setTimeout(() => setCopiado((c) => (c === clave ? null : c)), 1200);
    } catch {
      /* sin permiso de portapapeles: el número igual se ve */
    }
  };

  const tituloVenta = pedido.ml_pack_id && pedido.ml_order_id && pedido.ml_pack_id !== pedido.ml_order_id
    ? `Venta (carrito) ${pedido.ml_pack_id} — orden ${pedido.ml_order_id}. Click para copiar`
    : 'Número de venta de MercadoLibre. Click para copiar';

  return (
    <div className={`ml-ids${compact ? ' ml-ids-compact' : ''}`}>
      {venta && (
        <button type="button" className="ml-id" title={tituloVenta} onClick={(e) => copiar(e, venta, 'venta')}>
          <span className="ml-id-label">Venta</span>
          <span className="ml-id-valor">{copiado === 'venta' ? '¡copiado!' : venta}</span>
        </button>
      )}
      <button
        type="button"
        className={`ml-id${envio ? '' : ' ml-id-vacio'}`}
        title={envio ? 'Número de envío de MercadoLibre. Click para copiar' : 'Todavía sin envío asignado por ML (se despacha por nuestra cuenta)'}
        onClick={envio ? (e) => copiar(e, envio, 'envio') : undefined}
        disabled={!envio}
      >
        <span className="ml-id-label">Envío</span>
        <span className="ml-id-valor">{copiado === 'envio' ? '¡copiado!' : envio || 'sin envío ML'}</span>
      </button>
    </div>
  );
}
