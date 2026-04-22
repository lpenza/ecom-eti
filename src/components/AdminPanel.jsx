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

export default function AdminPanel() {
  const [usuarios, setUsuarios] = useState([]);
  const [montos, setMontos] = useState({});
  const [guardando, setGuardando] = useState({});
  const [reporte, setReporte] = useState([]);
  const [desde, setDesde] = useState(inicioMes);
  const [hasta, setHasta] = useState(hoy);
  const [loadingReporte, setLoadingReporte] = useState(false);
  const [toast, setToast] = useState({ msg: '', tipo: 'ok' });
  const [nuevoUsuario, setNuevoUsuario] = useState(nuevoUsuarioVacio);
  const [creando, setCreando] = useState(false);
  const [errorCrear, setErrorCrear] = useState('');

  const mostrarToast = (msg, tipo = 'ok') => {
    setToast({ msg, tipo });
    setTimeout(() => setToast({ msg: '', tipo: 'ok' }), 3000);
  };

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

  const totalGeneral = reporte.reduce((s, r) => s + r.total, 0);

  return (
    <div className="admin-panel">
      {toast.msg && (
        <div className={`admin-toast ${toast.tipo === 'error' ? 'admin-toast-error' : ''}`}>
          {toast.msg}
        </div>
      )}

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
    </div>
  );
}
