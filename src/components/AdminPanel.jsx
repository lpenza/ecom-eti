import React, { useState, useEffect, useCallback } from 'react';

const API = '/api';

function fetchAdmin(url, options = {}) {
  const token = localStorage.getItem('velinne_token');
  return fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...options,
  }).then((r) => r.json());
}

const hoy = new Date().toISOString().slice(0, 10);
const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

const nuevoUsuarioVacio = { nombre: '', email: '', password: '', role: 'user' };
const nuevoProductoVacio = { nombre: '', descripcion: '', sku: '', precio: '', activo: true };

const ESTADOS_PEDIDO = ['pendiente', 'etiqueta_generada', 'despachado', 'enviado', 'cancelado'];
const TIPOS_ENVIO = ['estandar', 'pickup_local', 'recibilo_hoy'];

export default function AdminPanel() {
  const [tab, setTab] = useState('usuarios'); // usuarios | productos | pedidos

  // ── Usuarios ──
  const [usuarios, setUsuarios] = useState([]);
  const [montos, setMontos] = useState({});
  const [guardando, setGuardando] = useState({});
  const [reporte, setReporte] = useState([]);
  const [desde, setDesde] = useState(inicioMes);
  const [hasta, setHasta] = useState(hoy);
  const [loadingReporte, setLoadingReporte] = useState(false);
  const [nuevoUsuario, setNuevoUsuario] = useState(nuevoUsuarioVacio);
  const [creando, setCreando] = useState(false);
  const [errorCrear, setErrorCrear] = useState('');

  // ── Productos ──
  const [productos, setProductos] = useState([]);
  const [loadingProductos, setLoadingProductos] = useState(false);
  const [nuevoProducto, setNuevoProducto] = useState(nuevoProductoVacio);
  const [creandoProducto, setCreandoProducto] = useState(false);
  const [errorProducto, setErrorProducto] = useState('');
  const [editandoProducto, setEditandoProducto] = useState(null); // id del producto en edición
  const [editProductoForm, setEditProductoForm] = useState({});
  const [guardandoProducto, setGuardandoProducto] = useState({});

  // ── Pedidos ──
  const [pedidosBusqueda, setPedidosBusqueda] = useState('');
  const [pedidosResultados, setPedidosResultados] = useState([]);
  const [loadingPedidos, setLoadingPedidos] = useState(false);
  const [pedidoEditando, setPedidoEditando] = useState(null); // objeto pedido
  const [pedidoForm, setPedidoForm] = useState({});
  const [guardandoPedido, setGuardandoPedido] = useState(false);
  const [errorPedido, setErrorPedido] = useState('');

  const [toast, setToast] = useState({ msg: '', tipo: 'ok' });

  const mostrarToast = (msg, tipo = 'ok') => {
    setToast({ msg, tipo });
    setTimeout(() => setToast({ msg: '', tipo: 'ok' }), 3000);
  };

  // ── Carga de usuarios ──
  const cargarUsuarios = useCallback(() => {
    fetchAdmin('/admin/usuarios').then((res) => {
      if (res.success) {
        setUsuarios(res.usuarios);
        setMontos((prev) => {
          const m = { ...prev };
          res.usuarios.forEach((u) => { if (!(u.id in m)) m[u.id] = u.monto_por_pedido ?? 0; });
          return m;
        });
      }
    });
  }, []);

  useEffect(() => { cargarUsuarios(); }, [cargarUsuarios]);

  const cargarReporte = useCallback(() => {
    setLoadingReporte(true);
    fetchAdmin(`/admin/reporte?desde=${desde}&hasta=${hasta}`)
      .then((res) => { if (res.success) setReporte(res.reporte); })
      .finally(() => setLoadingReporte(false));
  }, [desde, hasta]);

  useEffect(() => { cargarReporte(); }, [cargarReporte]);

  // ── Carga de productos ──
  const cargarProductos = useCallback(() => {
    setLoadingProductos(true);
    fetchAdmin('/admin/productos')
      .then((res) => { if (res.success) setProductos(res.productos); })
      .catch(() => mostrarToast('Error cargando productos', 'error'))
      .finally(() => setLoadingProductos(false));
  }, []);

  useEffect(() => {
    if (tab === 'productos') cargarProductos();
  }, [tab, cargarProductos]);

  // ── Handlers usuarios ──
  async function guardarMonto(userId) {
    setGuardando((g) => ({ ...g, [userId]: true }));
    const res = await fetchAdmin(`/admin/usuarios/${userId}/monto`, {
      method: 'PUT',
      body: JSON.stringify({ monto_por_pedido: montos[userId] }),
    });
    setGuardando((g) => ({ ...g, [userId]: false }));
    if (res.success) {
      mostrarToast('Monto guardado');
      cargarReporte();
    } else {
      mostrarToast(res.error || 'Error al guardar', 'error');
    }
  }

  async function handleCrearUsuario(e) {
    e.preventDefault();
    setErrorCrear('');
    setCreando(true);
    const res = await fetchAdmin('/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify(nuevoUsuario),
    });
    setCreando(false);
    if (res.success) {
      mostrarToast(`Usuario ${res.usuario.nombre} creado`);
      setNuevoUsuario(nuevoUsuarioVacio);
      cargarUsuarios();
    } else {
      setErrorCrear(res.error || 'Error al crear usuario');
    }
  }

  // ── Handlers productos ──
  async function handleCrearProducto(e) {
    e.preventDefault();
    setErrorProducto('');
    setCreandoProducto(true);
    const res = await fetchAdmin('/admin/productos', {
      method: 'POST',
      body: JSON.stringify(nuevoProducto),
    });
    setCreandoProducto(false);
    if (res.success) {
      mostrarToast(`Producto "${res.producto.nombre}" creado`);
      setNuevoProducto(nuevoProductoVacio);
      cargarProductos();
    } else {
      setErrorProducto(res.error || 'Error al crear producto');
    }
  }

  function iniciarEditarProducto(prod) {
    setEditandoProducto(prod.id);
    setEditProductoForm({
      nombre: prod.nombre,
      descripcion: prod.descripcion || '',
      sku: prod.sku || '',
      precio: prod.precio ?? '',
      activo: prod.activo,
    });
  }

  async function guardarEdicionProducto(id) {
    setGuardandoProducto((g) => ({ ...g, [id]: true }));
    const res = await fetchAdmin(`/admin/productos/${id}`, {
      method: 'PUT',
      body: JSON.stringify(editProductoForm),
    });
    setGuardandoProducto((g) => ({ ...g, [id]: false }));
    if (res.success) {
      mostrarToast('Producto actualizado');
      setEditandoProducto(null);
      cargarProductos();
    } else {
      mostrarToast(res.error || 'Error al guardar', 'error');
    }
  }

  async function eliminarProducto(id, nombre) {
    if (!window.confirm(`¿Eliminar el producto "${nombre}"?`)) return;
    const res = await fetchAdmin(`/admin/productos/${id}`, { method: 'DELETE' });
    if (res.success) {
      mostrarToast('Producto eliminado');
      cargarProductos();
    } else {
      mostrarToast(res.error || 'Error al eliminar', 'error');
    }
  }

  // ── Handlers pedidos ──
  const buscarPedidos = useCallback(async () => {
    setLoadingPedidos(true);
    const res = await fetchAdmin(`/admin/pedidos?q=${encodeURIComponent(pedidosBusqueda)}`);
    setLoadingPedidos(false);
    if (res.success) setPedidosResultados(res.pedidos);
    else mostrarToast(res.error || 'Error buscando pedidos', 'error');
  }, [pedidosBusqueda]);

  useEffect(() => {
    if (tab === 'pedidos') buscarPedidos();
  }, [tab]);

  function iniciarEditarPedido(pedido) {
    setPedidoEditando(pedido);
    setPedidoForm({
      cliente_nombre: pedido.cliente_nombre || '',
      cliente_email: pedido.cliente_email || '',
      cliente_telefono: pedido.cliente_telefono || '',
      direccion_envio: pedido.direccion_envio || '',
      localidad: pedido.localidad || '',
      departamento: pedido.departamento || '',
      codigo_postal: pedido.codigo_postal || '',
      estado: pedido.estado || 'pendiente',
      tipo_envio: pedido.tipo_envio || 'estandar',
      motivo_reenvio: pedido.motivo_reenvio || '',
    });
    setErrorPedido('');
  }

  async function guardarPedido() {
    setGuardandoPedido(true);
    setErrorPedido('');
    const res = await fetchAdmin(`/admin/pedidos/${pedidoEditando.id}`, {
      method: 'PUT',
      body: JSON.stringify(pedidoForm),
    });
    setGuardandoPedido(false);
    if (res.success) {
      mostrarToast(`Pedido #${pedidoEditando.numero_pedido} actualizado`);
      setPedidoEditando(null);
      buscarPedidos();
    } else {
      setErrorPedido(res.error || 'Error al guardar pedido');
    }
  }

  const totalGeneral = reporte.reduce((s, r) => s + r.total, 0);

  return (
    <div className="admin-panel">
      {toast.msg && (
        <div className={`admin-toast ${toast.tipo === 'error' ? 'admin-toast-error' : ''}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="admin-tabs">
        <button className={`admin-tab${tab === 'usuarios' ? ' admin-tab-active' : ''}`} onClick={() => setTab('usuarios')}>
          Usuarios
        </button>
        <button className={`admin-tab${tab === 'productos' ? ' admin-tab-active' : ''}`} onClick={() => setTab('productos')}>
          Productos
        </button>
        <button className={`admin-tab${tab === 'pedidos' ? ' admin-tab-active' : ''}`} onClick={() => setTab('pedidos')}>
          Pedidos
        </button>
      </div>

      {/* ══════════════ TAB USUARIOS ══════════════ */}
      {tab === 'usuarios' && (
        <>
          {/* ── Agregar usuario ── */}
          <section className="admin-section">
            <h2 className="admin-section-title">Agregar usuario</h2>
            <p className="admin-section-desc">Creá un nuevo usuario para acceder al sistema.</p>
            <form className="admin-nuevo-form" onSubmit={handleCrearUsuario}>
              <div className="admin-nuevo-fields">
                <div className="admin-field">
                  <label>Nombre</label>
                  <input
                    type="text"
                    placeholder="Nombre completo"
                    value={nuevoUsuario.nombre}
                    onChange={(e) => setNuevoUsuario((u) => ({ ...u, nombre: e.target.value }))}
                    required
                  />
                </div>
                <div className="admin-field">
                  <label>Email</label>
                  <input
                    type="email"
                    placeholder="correo@ejemplo.com"
                    value={nuevoUsuario.email}
                    onChange={(e) => setNuevoUsuario((u) => ({ ...u, email: e.target.value }))}
                    required
                  />
                </div>
                <div className="admin-field">
                  <label>Contraseña</label>
                  <input
                    type="password"
                    placeholder="Contraseña"
                    value={nuevoUsuario.password}
                    onChange={(e) => setNuevoUsuario((u) => ({ ...u, password: e.target.value }))}
                    required
                    minLength={6}
                  />
                </div>
                <div className="admin-field">
                  <label>Rol</label>
                  <select
                    value={nuevoUsuario.role}
                    onChange={(e) => setNuevoUsuario((u) => ({ ...u, role: e.target.value }))}
                  >
                    <option value="user">Usuario</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
              </div>
              {errorCrear && <div className="admin-error">{errorCrear}</div>}
              <button className="btn btn-primary" type="submit" disabled={creando}>
                {creando ? 'Creando...' : '+ Crear usuario'}
              </button>
            </form>
          </section>

          {/* ── Montos por pedido ── */}
          <section className="admin-section">
            <h2 className="admin-section-title">Monto por pedido armado</h2>
            <p className="admin-section-desc">Configurá cuánto cobra cada usuario por cada pedido que despacha.</p>
            <div className="admin-users-grid">
              {usuarios.filter((u) => u.role === 'user').map((u) => (
                <div key={u.id} className="admin-user-card">
                  <div className="admin-user-info">
                    <span className="admin-user-name">{u.nombre}</span>
                    <span className="admin-user-email">{u.email}</span>
                  </div>
                  <div className="admin-monto-row">
                    <span className="admin-currency">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="admin-monto-input"
                      value={montos[u.id] ?? 0}
                      onChange={(e) => setMontos((m) => ({ ...m, [u.id]: e.target.value }))}
                    />
                    <button
                      className="btn btn-primary admin-save-btn"
                      onClick={() => guardarMonto(u.id)}
                      disabled={guardando[u.id]}
                    >
                      {guardando[u.id] ? '...' : 'Guardar'}
                    </button>
                  </div>
                </div>
              ))}
              {usuarios.filter((u) => u.role === 'user').length === 0 && (
                <p className="admin-rep-empty">No hay usuarios con rol "Usuario" aún.</p>
              )}
            </div>
          </section>

          {/* ── Reporte de producción ── */}
          <section className="admin-section">
            <h2 className="admin-section-title">Reporte de producción</h2>
            <div className="admin-reporte-filtros">
              <label>
                Desde
                <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
              </label>
              <label>
                Hasta
                <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
              </label>
              <button className="btn btn-secondary" onClick={cargarReporte} disabled={loadingReporte}>
                {loadingReporte ? 'Cargando...' : '🔄 Actualizar'}
              </button>
            </div>

            <table className="admin-reporte-table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Pedidos armados</th>
                  <th>Monto por pedido</th>
                  <th>Total a pagar</th>
                </tr>
              </thead>
              <tbody>
                {reporte.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="admin-rep-nombre">{r.nombre}</span>
                      <span className="admin-rep-email">{r.email}</span>
                    </td>
                    <td className="admin-rep-num">{r.pedidos_armados}</td>
                    <td className="admin-rep-num">${Number(r.monto_por_pedido).toFixed(2)}</td>
                    <td className="admin-rep-total">${Number(r.total).toFixed(2)}</td>
                  </tr>
                ))}
                {reporte.length === 0 && (
                  <tr><td colSpan={4} className="admin-rep-empty">No hay datos para el período seleccionado</td></tr>
                )}
              </tbody>
              {reporte.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={3} className="admin-rep-total-label">Total general</td>
                    <td className="admin-rep-total admin-rep-total-bold">${totalGeneral.toFixed(2)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </section>
        </>
      )}

      {/* ══════════════ TAB PRODUCTOS ══════════════ */}
      {tab === 'productos' && (
        <>
          {/* ── Agregar producto ── */}
          <section className="admin-section">
            <h2 className="admin-section-title">Agregar producto</h2>
            <p className="admin-section-desc">Agregá un nuevo producto al catálogo interno.</p>
            <form className="admin-nuevo-form" onSubmit={handleCrearProducto}>
              <div className="admin-nuevo-fields">
                <div className="admin-field">
                  <label>Nombre *</label>
                  <input
                    type="text"
                    placeholder="Nombre del producto"
                    value={nuevoProducto.nombre}
                    onChange={(e) => setNuevoProducto((p) => ({ ...p, nombre: e.target.value }))}
                    required
                  />
                </div>
                <div className="admin-field">
                  <label>SKU</label>
                  <input
                    type="text"
                    placeholder="SKU-001"
                    value={nuevoProducto.sku}
                    onChange={(e) => setNuevoProducto((p) => ({ ...p, sku: e.target.value }))}
                  />
                </div>
                <div className="admin-field">
                  <label>Precio</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={nuevoProducto.precio}
                    onChange={(e) => setNuevoProducto((p) => ({ ...p, precio: e.target.value }))}
                  />
                </div>
                <div className="admin-field">
                  <label>Estado</label>
                  <select
                    value={nuevoProducto.activo ? 'true' : 'false'}
                    onChange={(e) => setNuevoProducto((p) => ({ ...p, activo: e.target.value === 'true' }))}
                  >
                    <option value="true">Activo</option>
                    <option value="false">Inactivo</option>
                  </select>
                </div>
              </div>
              <div className="admin-field" style={{ maxWidth: '100%' }}>
                <label>Descripción</label>
                <textarea
                  className="admin-textarea"
                  placeholder="Descripción opcional..."
                  rows={2}
                  value={nuevoProducto.descripcion}
                  onChange={(e) => setNuevoProducto((p) => ({ ...p, descripcion: e.target.value }))}
                />
              </div>
              {errorProducto && <div className="admin-error">{errorProducto}</div>}
              <button className="btn btn-primary" type="submit" disabled={creandoProducto}>
                {creandoProducto ? 'Creando...' : '+ Agregar producto'}
              </button>
            </form>
          </section>

          {/* ── Lista de productos ── */}
          <section className="admin-section">
            <div className="admin-section-header-row">
              <h2 className="admin-section-title" style={{ margin: 0 }}>Catálogo de productos</h2>
              <button className="btn btn-secondary btn-sm" onClick={cargarProductos} disabled={loadingProductos}>
                {loadingProductos ? 'Cargando...' : '🔄 Actualizar'}
              </button>
            </div>

            {loadingProductos && <p className="admin-rep-empty">Cargando...</p>}

            {!loadingProductos && productos.length === 0 && (
              <p className="admin-rep-empty">No hay productos en el catálogo todavía.</p>
            )}

            {!loadingProductos && productos.length > 0 && (
              <table className="admin-reporte-table admin-productos-table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>SKU</th>
                    <th>Precio</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {productos.map((prod) => (
                    <React.Fragment key={prod.id}>
                      <tr className={editandoProducto === prod.id ? 'admin-row-editing' : ''}>
                        <td>
                          <span className="admin-rep-nombre">{prod.nombre}</span>
                          {prod.descripcion && <span className="admin-rep-email">{prod.descripcion}</span>}
                        </td>
                        <td>{prod.sku || <span className="admin-rep-empty" style={{ padding: 0 }}>—</span>}</td>
                        <td className="admin-rep-num">
                          {prod.precio != null ? `$${Number(prod.precio).toFixed(2)}` : '—'}
                        </td>
                        <td>
                          <span className={`admin-badge ${prod.activo ? 'admin-badge-ok' : 'admin-badge-off'}`}>
                            {prod.activo ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => editandoProducto === prod.id ? setEditandoProducto(null) : iniciarEditarProducto(prod)}
                            >
                              {editandoProducto === prod.id ? 'Cancelar' : 'Editar'}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => eliminarProducto(prod.id, prod.nombre)}
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>

                      {editandoProducto === prod.id && (
                        <tr className="admin-row-edit-form">
                          <td colSpan={5}>
                            <div className="admin-edit-inline">
                              <div className="admin-nuevo-fields">
                                <div className="admin-field">
                                  <label>Nombre *</label>
                                  <input
                                    type="text"
                                    value={editProductoForm.nombre}
                                    onChange={(e) => setEditProductoForm((f) => ({ ...f, nombre: e.target.value }))}
                                  />
                                </div>
                                <div className="admin-field">
                                  <label>SKU</label>
                                  <input
                                    type="text"
                                    value={editProductoForm.sku}
                                    onChange={(e) => setEditProductoForm((f) => ({ ...f, sku: e.target.value }))}
                                  />
                                </div>
                                <div className="admin-field">
                                  <label>Precio</label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={editProductoForm.precio}
                                    onChange={(e) => setEditProductoForm((f) => ({ ...f, precio: e.target.value }))}
                                  />
                                </div>
                                <div className="admin-field">
                                  <label>Estado</label>
                                  <select
                                    value={editProductoForm.activo ? 'true' : 'false'}
                                    onChange={(e) => setEditProductoForm((f) => ({ ...f, activo: e.target.value === 'true' }))}
                                  >
                                    <option value="true">Activo</option>
                                    <option value="false">Inactivo</option>
                                  </select>
                                </div>
                              </div>
                              <div className="admin-field" style={{ maxWidth: '100%' }}>
                                <label>Descripción</label>
                                <textarea
                                  className="admin-textarea"
                                  rows={2}
                                  value={editProductoForm.descripcion}
                                  onChange={(e) => setEditProductoForm((f) => ({ ...f, descripcion: e.target.value }))}
                                />
                              </div>
                              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => guardarEdicionProducto(prod.id)}
                                  disabled={guardandoProducto[prod.id]}
                                >
                                  {guardandoProducto[prod.id] ? 'Guardando...' : 'Guardar cambios'}
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setEditandoProducto(null)}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* ══════════════ TAB PEDIDOS ══════════════ */}
      {tab === 'pedidos' && (
        <section className="admin-section">
          <h2 className="admin-section-title">Editar pedidos</h2>
          <p className="admin-section-desc">Buscá un pedido por número, nombre, email o teléfono del cliente.</p>

          <div className="admin-pedidos-search-row">
            <input
              className="admin-pedidos-search-input"
              type="text"
              placeholder="Buscar pedido..."
              value={pedidosBusqueda}
              onChange={(e) => setPedidosBusqueda(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscarPedidos()}
            />
            <button className="btn btn-primary" onClick={buscarPedidos} disabled={loadingPedidos}>
              {loadingPedidos ? 'Buscando...' : 'Buscar'}
            </button>
          </div>

          {/* Modal de edición */}
          {pedidoEditando && (
            <div className="admin-modal-overlay" onClick={() => setPedidoEditando(null)}>
              <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
                <div className="admin-modal-header">
                  <h3>Editar pedido #{pedidoEditando.numero_pedido}</h3>
                  <button className="btn-close" onClick={() => setPedidoEditando(null)}>&times;</button>
                </div>
                <div className="admin-modal-body">
                  <div className="admin-nuevo-fields">
                    <div className="admin-field">
                      <label>Nombre del cliente</label>
                      <input
                        type="text"
                        value={pedidoForm.cliente_nombre}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, cliente_nombre: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Email</label>
                      <input
                        type="email"
                        value={pedidoForm.cliente_email}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, cliente_email: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Teléfono</label>
                      <input
                        type="text"
                        value={pedidoForm.cliente_telefono}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, cliente_telefono: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Estado</label>
                      <select
                        value={pedidoForm.estado}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, estado: e.target.value }))}
                      >
                        {ESTADOS_PEDIDO.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                    <div className="admin-field">
                      <label>Tipo de envío</label>
                      <select
                        value={pedidoForm.tipo_envio}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, tipo_envio: e.target.value }))}
                      >
                        {TIPOS_ENVIO.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="admin-field">
                      <label>Dirección de envío</label>
                      <input
                        type="text"
                        value={pedidoForm.direccion_envio}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, direccion_envio: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Localidad</label>
                      <input
                        type="text"
                        value={pedidoForm.localidad}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, localidad: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Departamento</label>
                      <input
                        type="text"
                        value={pedidoForm.departamento}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, departamento: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field">
                      <label>Código postal</label>
                      <input
                        type="text"
                        value={pedidoForm.codigo_postal}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, codigo_postal: e.target.value }))}
                      />
                    </div>
                    <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
                      <label>Motivo / especificación del reclamo</label>
                      <textarea
                        className="admin-textarea"
                        rows={3}
                        value={pedidoForm.motivo_reenvio}
                        onChange={(e) => setPedidoForm((f) => ({ ...f, motivo_reenvio: e.target.value }))}
                        placeholder="Ej: incluir cable USB + manual de garantía"
                      />
                    </div>
                  </div>
                  {errorPedido && <div className="admin-error">{errorPedido}</div>}
                </div>
                <div className="admin-modal-footer">
                  <button className="btn btn-secondary" onClick={() => setPedidoEditando(null)}>Cancelar</button>
                  <button className="btn btn-primary" onClick={guardarPedido} disabled={guardandoPedido}>
                    {guardandoPedido ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Resultados */}
          {!loadingPedidos && pedidosResultados.length === 0 && (
            <p className="admin-rep-empty">
              {pedidosBusqueda ? 'No se encontraron pedidos.' : 'Ingresá un término para buscar pedidos.'}
            </p>
          )}

          {pedidosResultados.length > 0 && (
            <table className="admin-reporte-table admin-pedidos-table">
              <thead>
                <tr>
                  <th>N° Pedido</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th>Dirección</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pedidosResultados.map((p) => (
                  <tr key={p.id}>
                    <td><strong>#{p.numero_pedido}</strong></td>
                    <td>
                      <span className="admin-rep-nombre">{p.cliente_nombre || '—'}</span>
                      <span className="admin-rep-email">{p.cliente_email || p.cliente_telefono || '—'}</span>
                    </td>
                    <td>
                      <span className={`admin-badge admin-badge-estado-${p.estado}`}>{p.estado}</span>
                    </td>
                    <td>
                      <span className="admin-rep-nombre">{p.direccion_envio || '—'}</span>
                      <span className="admin-rep-email">{[p.localidad, p.departamento].filter(Boolean).join(', ') || '—'}</span>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => iniciarEditarPedido(p)}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
