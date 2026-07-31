import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  cargarLiquidacionFacturacion,
  obtenerLiquidacionesFacturacion,
  obtenerReporteFacturacion,
  eliminarLiquidacionFacturacion,
  marcarRevisionLineaFacturacion,
  obtenerConfigFacturacion,
  guardarTarifaFacturacion,
  guardarParametrosFacturacion,
} from '../services/api';
import { formatFechaHoraUy, formatFechaUy } from '../utils/fechas';

const PROVEEDOR_LABEL = {
  marcopostal: 'MarcoPostal',
  ues: 'UES',
};

const ESTADOS_REVISION = [
  { valor: 'pendiente',   label: 'Pendiente' },
  { valor: 'reclamado',   label: 'Reclamado' },
  { valor: 'justificado', label: 'Justificado' },
  { valor: 'acreditado',  label: 'Acreditado' },
];

// Los importes son pesos uruguayos: siempre con dos decimales y separador de miles.
const fmtMoneda = (n) =>
  Number(n ?? 0).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Money({ valor, className = '' }) {
  return <span className={`fact-money ${className}`}>$ {fmtMoneda(valor)}</span>;
}

export default function FacturacionPanel({ mostrarToast }) {
  const [reporte, setReporte] = useState(null);        // resultado del dry-run o de una liquidación guardada
  const [liquidaciones, setLiquidaciones] = useState([]);
  const [config, setConfig] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [archivoPendiente, setArchivoPendiente] = useState(null); // { filename, contenidoBase64 }
  const [dragActivo, setDragActivo] = useState(false);
  const [filtroFlag, setFiltroFlag] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [mostrarConfig, setMostrarConfig] = useState(false);
  // Cantidad de levantes a facturar cuando el usuario la corrige contra el PDF de UES.
  // null = usar la que trae el reporte (los registrados en la app).
  const [levantesCantidad, setLevantesCantidad] = useState(null);
  const inputFileRef = useRef(null);

  const cargarLiquidaciones = useCallback(async () => {
    try {
      setLiquidaciones(await obtenerLiquidacionesFacturacion());
    } catch (err) {
      mostrarToast?.(err.message || 'Error cargando liquidaciones', 'error');
    }
  }, [mostrarToast]);

  const cargarConfig = useCallback(async () => {
    try {
      setConfig(await obtenerConfigFacturacion());
    } catch (err) {
      mostrarToast?.(err.message || 'Error cargando configuración', 'error');
    }
  }, [mostrarToast]);

  useEffect(() => { cargarLiquidaciones(); cargarConfig(); }, [cargarLiquidaciones, cargarConfig]);

  // ── Subida de archivo ──────────────────────────────────────────────────────
  // Se lee como ArrayBuffer y se manda en base64: el backend es el que parsea, así la
  // lógica de los formatos vive en un solo lugar.
  const leerArchivo = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binario = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      resolve(btoa(binario));
    };
    reader.readAsArrayBuffer(file);
  });

  const procesarArchivo = useCallback(async (file) => {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      mostrarToast?.('El archivo tiene que ser un Excel (.xlsx)', 'error');
      return;
    }

    setSubiendo(true);
    setFiltroFlag(null);
    setBusqueda('');
    setLevantesCantidad(null);
    try {
      const contenidoBase64 = await leerArchivo(file);
      const res = await cargarLiquidacionFacturacion({ filename: file.name, contenidoBase64, guardar: false });
      setReporte(res);
      setArchivoPendiente({ filename: file.name, contenidoBase64 });
      mostrarToast?.(
        `${PROVEEDOR_LABEL[res.proveedor] || res.proveedor}: ${res.lineas.length} líneas leídas`,
        'success'
      );
    } catch (err) {
      mostrarToast?.(err.message || 'Error procesando el archivo', 'error');
    } finally {
      setSubiendo(false);
      if (inputFileRef.current) inputFileRef.current.value = '';
    }
  }, [mostrarToast]);

  // Al corregir la cantidad de levantes se vuelve a pedir el reporte (sin guardar) para
  // que los totales los siga calculando el backend y no haya dos implementaciones del
  // mismo cálculo. Con debounce para no disparar una llamada por tecla.
  useEffect(() => {
    if (levantesCantidad === null || !archivoPendiente) return undefined;
    const timer = setTimeout(async () => {
      try {
        setReporte(await cargarLiquidacionFacturacion({
          ...archivoPendiente,
          guardar: false,
          levantesCantidad,
        }));
      } catch (err) {
        mostrarToast?.(err.message || 'Error recalculando los levantes', 'error');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [levantesCantidad, archivoPendiente, mostrarToast]);

  async function handleGuardar(forzar = false) {
    if (!archivoPendiente) return;
    setGuardando(true);
    let reintentarForzando = false;
    try {
      const res = await cargarLiquidacionFacturacion({
        ...archivoPendiente,
        guardar: true,
        forzar,
        levantesCantidad,
      });
      setReporte(res);
      setArchivoPendiente(null);
      mostrarToast?.(`Liquidación #${res.liquidacion.id} guardada`, 'success');
      await cargarLiquidaciones();
    } catch (err) {
      // 409 = el mismo archivo ya se cargó antes; se ofrece guardarlo igual.
      if (err.status === 409 && !forzar) {
        const previa = err.response?.liquidacionPrevia;
        const fecha = previa?.created_at ? formatFechaUy(previa.created_at) : 'antes';
        reintentarForzando = window.confirm(`Este archivo ya se cargó el ${fecha}. ¿Guardarlo igual?`);
        if (!reintentarForzando) {
          mostrarToast?.('Liquidación cancelada', 'warning');
        }
      } else {
        mostrarToast?.(err.message || 'Error guardando la liquidación', 'error');
      }
    } finally {
      setGuardando(false);
    }
    if (reintentarForzando) await handleGuardar(true);
  }

  async function abrirLiquidacion(id) {
    setCargando(true);
    setFiltroFlag(null);
    setLevantesCantidad(null);
    setBusqueda('');
    try {
      setReporte(await obtenerReporteFacturacion(id));
      setArchivoPendiente(null);
    } catch (err) {
      mostrarToast?.(err.message || 'Error abriendo la liquidación', 'error');
    } finally {
      setCargando(false);
    }
  }

  async function handleEliminar(id) {
    if (!window.confirm(`¿Eliminar la liquidación #${id} y todas sus líneas?`)) return;
    try {
      await eliminarLiquidacionFacturacion(id);
      mostrarToast?.('Liquidación eliminada', 'success');
      if (reporte?.liquidacion?.id === id) setReporte(null);
      await cargarLiquidaciones();
    } catch (err) {
      mostrarToast?.(err.message || 'Error eliminando la liquidación', 'error');
    }
  }

  async function handleRevision(linea, estado) {
    if (!linea.id) {
      mostrarToast?.('Guardá la liquidación antes de marcar líneas', 'warning');
      return;
    }
    try {
      await marcarRevisionLineaFacturacion(linea.id, estado);
      setReporte((prev) => ({
        ...prev,
        lineas: prev.lineas.map((l) => (l.id === linea.id ? { ...l, revisionEstado: estado } : l)),
      }));
    } catch (err) {
      mostrarToast?.(err.message || 'Error marcando la línea', 'error');
    }
  }

  // ── Filtrado de la tabla ───────────────────────────────────────────────────
  const lineasFiltradas = useMemo(() => {
    const lineas = reporte?.lineas || [];
    const term = busqueda.trim().toLowerCase().replace(/^#/, '');
    return lineas.filter((l) => {
      if (filtroFlag && !l.flags?.some((f) => f.tipo === filtroFlag)) return false;
      if (!term) return true;
      return [l.guia, l.orden, l.destinatario, l.localidad, l.pedidoNumero]
        .some((v) => String(v || '').toLowerCase().includes(term));
    });
  }, [reporte, filtroFlag, busqueda]);

  const resumen = reporte?.resumen;

  return (
    <div className="fact-panel">
      <div className="fact-header">
        <div>
          <h2 className="fact-title">🧾 Control de Facturación</h2>
          <p className="fact-sub">
            Subí el Excel mensual de UES o MarcoPostal para detectar cobros duplicados, guías sin
            pedido en la app e importes fuera de tarifa. Los importes de MarcoPostal vienen sin IVA;
            acá se muestran neto, IVA y total.
          </p>
        </div>
        <div className="fact-header-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setMostrarConfig((v) => !v)}>
            ⚙️ Tarifas y parámetros
          </button>
        </div>
      </div>

      {mostrarConfig && (
        <ConfigFacturacion
          config={config}
          onRecargar={cargarConfig}
          mostrarToast={mostrarToast}
        />
      )}

      {/* Zona de subida */}
      <div
        className={`fact-drop ${dragActivo ? 'fact-drop-activa' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragActivo(true); }}
        onDragLeave={() => setDragActivo(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActivo(false);
          procesarArchivo(e.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={inputFileRef}
          type="file"
          accept=".xlsx,.xls"
          className="fact-drop-input"
          onChange={(e) => procesarArchivo(e.target.files?.[0])}
        />
        <div className="fact-drop-icon">📄</div>
        <div className="fact-drop-texto">
          {subiendo ? 'Leyendo el archivo…' : 'Arrastrá el Excel acá o hacé click para elegirlo'}
        </div>
        <div className="fact-drop-hint">Se detecta solo si es de UES o de MarcoPostal</div>
      </div>

      {reporte && (
        <>
          {/* Cabecera del reporte */}
          <div className="fact-reporte-head">
            <div>
              <span className={`fact-proveedor fact-proveedor-${reporte.proveedor}`}>
                {PROVEEDOR_LABEL[reporte.proveedor] || reporte.proveedor}
              </span>
              <span className="fact-reporte-meta">
                {reporte.lineas.length} líneas
                {reporte.periodo?.desde && (
                  <> · {formatFechaUy(reporte.periodo.desde)} a {formatFechaUy(reporte.periodo.hasta)}</>
                )}
                {reporte.liquidacion?.archivo_nombre && <> · {reporte.liquidacion.archivo_nombre}</>}
              </span>
            </div>
            {archivoPendiente && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleGuardar(false)}
                disabled={guardando}
              >
                {guardando ? 'Guardando…' : '💾 Guardar liquidación'}
              </button>
            )}
          </div>

          {(reporte.avisos || []).map((aviso) => (
            <div key={aviso.tipo} className="fact-aviso">⚠️ {aviso.mensaje}</div>
          ))}

          {/* Resumen económico */}
          {resumen && (
            <div className="fact-resumen">
              <div className="fact-card">
                <div className="fact-card-label">Total facturado</div>
                <div className="fact-card-valor"><Money valor={resumen.totalGeneral.total} /></div>
                <div className="fact-card-detalle">
                  Neto <Money valor={resumen.totalGeneral.neto} /> · IVA <Money valor={resumen.totalGeneral.iva} />
                  {resumen.levantes?.total > 0 && (
                    <> · incluye <Money valor={resumen.levantes.total} /> de levantes</>
                  )}
                </div>
              </div>

              {resumen.levantes && (
                <div className={`fact-card fact-card-levantes ${resumen.levantes.enSistema !== resumen.levantes.enDetalle ? 'fact-card-alerta' : ''}`}>
                  <div className="fact-card-label">Solicitudes de levante</div>
                  <div className="fact-card-valor"><Money valor={resumen.levantes.total} /></div>
                  <div className="fact-card-detalle">
                    <label className="fact-levante-input">
                      <input
                        type="number"
                        min="0"
                        className="fact-input-num"
                        value={levantesCantidad ?? resumen.levantes.cantidad}
                        onChange={(e) => setLevantesCantidad(e.target.value === '' ? null : Number(e.target.value))}
                        disabled={reporte.guardado}
                        title={reporte.guardado ? 'La liquidación ya está guardada' : 'Ajustalo a lo que diga el PDF de UES'}
                      />
                      × <Money valor={resumen.levantes.costoUnitario} />
                    </label>
                    <div>
                      En tu sistema: <strong>{resumen.levantes.enSistema}</strong> ·
                      {' '}en el detalle de UES: <strong>{resumen.levantes.enDetalle}</strong>
                    </div>
                  </div>
                </div>
              )}

              {resumen.pickup.cantidad > 0 && (
                <div className="fact-card fact-card-pickup">
                  <div className="fact-card-label">PickUp — gasto no contemplado</div>
                  <div className="fact-card-valor"><Money valor={resumen.pickup.total} /></div>
                  <div className="fact-card-detalle">
                    {resumen.pickup.cantidad} retiros · neto <Money valor={resumen.pickup.neto} />
                  </div>
                </div>
              )}

              {resumen.realVsContable && (
                <div className="fact-card fact-card-contable">
                  <div className="fact-card-label">Montevideo: real vs contable</div>
                  <div className={`fact-card-valor ${resumen.realVsContable.diferencia >= 0 ? 'fact-pos' : 'fact-neg'}`}>
                    {resumen.realVsContable.diferencia >= 0 ? '+' : '−'}
                    {' '}$ {fmtMoneda(Math.abs(resumen.realVsContable.diferencia))}
                  </div>
                  <div className="fact-card-detalle">
                    {resumen.realVsContable.cantidad} envíos · contable{' '}
                    <Money valor={resumen.realVsContable.totalContable} /> vs real{' '}
                    <Money valor={resumen.realVsContable.totalReal} />
                  </div>
                </div>
              )}

              <div className="fact-card fact-card-reclamo">
                <div className="fact-card-label">A reclamar</div>
                <div className="fact-card-valor"><Money valor={resumen.aReclamar.total} /></div>
                <div className="fact-card-detalle">{resumen.aReclamar.cantidad} línea(s) observada(s)</div>
              </div>
            </div>
          )}

          {/* Desglose por servicio */}
          {resumen?.desglose?.length > 0 && (
            <div className="fact-desglose">
              <table className="fact-table">
                <thead>
                  <tr>
                    <th>Servicio</th>
                    <th>Zona</th>
                    <th className="fact-num">Cant.</th>
                    <th className="fact-num">Neto</th>
                    <th className="fact-num">IVA</th>
                    <th className="fact-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {resumen.desglose.map((d) => (
                    <tr key={`${d.servicio}|${d.categoriaZona}`}>
                      <td>{d.servicio}</td>
                      <td>{d.categoriaZona === '*' ? '—' : d.categoriaZona}</td>
                      <td className="fact-num">{d.cantidad}</td>
                      <td className="fact-num"><Money valor={d.neto} /></td>
                      <td className="fact-num"><Money valor={d.iva} /></td>
                      <td className="fact-num"><Money valor={d.total} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Chips de hallazgos + buscador */}
          <div className="fact-toolbar">
            <button
              type="button"
              className={`fact-chip ${filtroFlag === null ? 'fact-chip-activo' : ''}`}
              onClick={() => setFiltroFlag(null)}
            >
              Todas ({reporte.lineas.length})
            </button>
            {(resumen?.flags || []).map((f) => (
              <button
                key={f.tipo}
                type="button"
                className={`fact-chip fact-chip-${f.severidad} ${filtroFlag === f.tipo ? 'fact-chip-activo' : ''}`}
                onClick={() => setFiltroFlag(filtroFlag === f.tipo ? null : f.tipo)}
              >
                {f.label} ({f.cantidad})
              </button>
            ))}
            <input
              className="fact-search"
              placeholder="Buscar por orden, guía o destinatario…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>

          {/* Tabla de líneas */}
          <div className="fact-body">
            <table className="fact-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Guía</th>
                  <th>Orden</th>
                  <th>Destinatario</th>
                  <th>Servicio</th>
                  <th className="fact-num">Neto</th>
                  <th className="fact-num">IVA</th>
                  <th className="fact-num">Total</th>
                  <th>Hallazgos</th>
                  <th>Revisión</th>
                </tr>
              </thead>
              <tbody>
                {lineasFiltradas.map((l) => (
                  <tr key={l.id || `${l.guia}-${l.filaExcel}`} className={l.flags?.some((f) => f.reclamable) ? 'fact-row-alerta' : ''}>
                    <td className="fact-nowrap">{l.fecha ? formatFechaHoraUy(l.fecha) : '—'}</td>
                    <td className="fact-mono">{l.guia}</td>
                    <td className="fact-mono">
                      {l.orden ? `#${l.orden}` : '—'}
                      {l.pedidoNumero && l.pedidoNumero !== l.orden && (
                        <span className="fact-pedido-match"> → {l.pedidoNumero}</span>
                      )}
                    </td>
                    <td>{l.destinatario || '—'}</td>
                    <td className="fact-servicio">
                      {l.servicio || '—'}
                      {l.zona && <span className="fact-zona"> · {l.zona}</span>}
                    </td>
                    <td className="fact-num"><Money valor={l.importeNeto} /></td>
                    <td className="fact-num"><Money valor={l.iva} /></td>
                    <td className="fact-num"><Money valor={l.importeTotal} /></td>
                    <td>
                      {(l.flags || []).length === 0 ? (
                        <span className="fact-ok">✓</span>
                      ) : (
                        l.flags.map((f) => (
                          <span key={f.tipo} className={`fact-badge fact-badge-${f.severidad}`} title={f.detalle || ''}>
                            {f.label}
                          </span>
                        ))
                      )}
                    </td>
                    <td>
                      <select
                        className="fact-select"
                        value={l.revisionEstado || 'pendiente'}
                        onChange={(e) => handleRevision(l, e.target.value)}
                        disabled={!l.id}
                        title={l.id ? '' : 'Guardá la liquidación para poder marcar líneas'}
                      >
                        {ESTADOS_REVISION.map((e) => (
                          <option key={e.valor} value={e.valor}>{e.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lineasFiltradas.length === 0 && (
              <div className="fact-vacio">No hay líneas que coincidan con el filtro.</div>
            )}
          </div>
        </>
      )}

      {/* Liquidaciones anteriores */}
      <div className="fact-historial">
        <h3 className="fact-historial-titulo">Liquidaciones anteriores</h3>
        {liquidaciones.length === 0 ? (
          <p className="fact-sub">Todavía no hay ninguna liquidación guardada.</p>
        ) : (
          <table className="fact-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Proveedor</th>
                <th>Archivo</th>
                <th>Período</th>
                <th className="fact-num">Líneas</th>
                <th className="fact-num">Total</th>
                <th>Cargado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {liquidaciones.map((liq) => (
                <tr key={liq.id} className={reporte?.liquidacion?.id === liq.id ? 'fact-row-activa' : ''}>
                  <td className="fact-mono">{liq.id}</td>
                  <td>{PROVEEDOR_LABEL[liq.proveedor] || liq.proveedor}</td>
                  <td>{liq.archivo_nombre}</td>
                  <td className="fact-nowrap">
                    {liq.periodo_desde ? `${formatFechaUy(liq.periodo_desde)} → ${formatFechaUy(liq.periodo_hasta)}` : '—'}
                  </td>
                  <td className="fact-num">{liq.total_filas}</td>
                  <td className="fact-num"><Money valor={liq.total_con_iva} /></td>
                  <td className="fact-nowrap">{formatFechaUy(liq.created_at)}</td>
                  <td className="fact-acciones">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => abrirLiquidacion(liq.id)} disabled={cargando}>
                      Ver
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => handleEliminar(liq.id)}>
                      Borrar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Tarifas y parámetros ─────────────────────────────────────────────────────

function ConfigFacturacion({ config, onRecargar, mostrarToast }) {
  const [drafts, setDrafts] = useState({});
  const [params, setParams] = useState({});
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!config) return;
    setDrafts(Object.fromEntries((config.tarifas || []).map((t) => [t.id, String(t.importe)])));
    setParams(Object.fromEntries((config.parametros || []).map((p) => [p.clave, p.valor])));
  }, [config]);

  if (!config) return <div className="module-panel module-panel-tight">Cargando configuración…</div>;

  async function handleGuardarTarifa(tarifa) {
    const importe = Number(drafts[tarifa.id]);
    if (!Number.isFinite(importe) || importe < 0) {
      mostrarToast?.('El importe tiene que ser un número válido', 'error');
      return;
    }
    setGuardando(true);
    try {
      await guardarTarifaFacturacion({ ...tarifa, importe });
      mostrarToast?.('Tarifa actualizada', 'success');
      await onRecargar();
    } catch (err) {
      mostrarToast?.(err.message || 'Error guardando la tarifa', 'error');
    } finally {
      setGuardando(false);
    }
  }

  async function handleGuardarParametros() {
    setGuardando(true);
    try {
      await guardarParametrosFacturacion(params);
      mostrarToast?.('Parámetros actualizados', 'success');
      await onRecargar();
    } catch (err) {
      mostrarToast?.(err.message || 'Error guardando los parámetros', 'error');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="module-panel module-panel-tight fact-config">
      <h3>Tarifas</h3>
      <p>
        UES no manda importe en el Excel: sus líneas se valorizan con esta tarifa. En MarcoPostal
        la tarifa se usa para detectar cobros que no corresponden.
      </p>
      <table className="fact-table">
        <thead>
          <tr>
            <th>Proveedor</th>
            <th>Servicio</th>
            <th>Zona</th>
            <th className="fact-num">Importe</th>
            <th>IVA</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(config.tarifas || []).map((t) => (
            <tr key={t.id}>
              <td>{PROVEEDOR_LABEL[t.proveedor] || t.proveedor}</td>
              <td>{t.servicio === '*' ? 'Todos' : t.servicio}</td>
              <td>{t.categoria_zona === '*' ? 'Todas' : t.categoria_zona}</td>
              <td className="fact-num">
                <input
                  className="fact-input-num"
                  value={drafts[t.id] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                />
              </td>
              <td>{t.incluye_iva ? 'Incluido' : 'Se suma'}</td>
              <td>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => handleGuardarTarifa(t)} disabled={guardando}>
                  Guardar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Parámetros</h3>
      <div className="module-grid">
        {(config.parametros || []).map((p) => (
          <label key={p.clave} className="fact-param">
            <span className="fact-param-label">{p.descripcion || p.clave}</span>
            <input
              className="module-input"
              value={params[p.clave] ?? ''}
              onChange={(e) => setParams((prev) => ({ ...prev, [p.clave]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <button type="button" className="btn btn-primary" onClick={handleGuardarParametros} disabled={guardando}>
        Guardar parámetros
      </button>
    </div>
  );
}
