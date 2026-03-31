import React from 'react';

function Header({ stats, activeFilter, onFilterChange, onActualizar, onLoginUES, uesAuthenticated }) {
  return (
    <header className="header">
      <div className="header-top">
        <div className="logo">
          <p>Sistema de Gestión de Envíos</p>
          <p className="header-flow">Flujo: Sincronizar → Validar → Enviar Tracking</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary header-btn" onClick={onActualizar}>
            ♻️ Actualizar
          </button>
          <button 
            className={`btn header-btn ${uesAuthenticated ? 'btn-success' : 'btn-warning'}`}
            onClick={onLoginUES}
            disabled={uesAuthenticated}
          >
            {uesAuthenticated ? '✅ UES Conectado' : '🔐 Login UES'}
          </button>
        </div>
      </div>
      <div className="stats" id="stats">
        <button
          className={`stat-card stat-card-warning ${activeFilter === 'porValidar' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('porValidar')}
          type="button"
        >
          <div className="stat-value">{stats.porValidar}</div>
          <div className="stat-label">Por Validar</div>
        </button>
        <button
          className={`stat-card stat-card-neutral ${activeFilter === 'etiquetasGeneradas' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('etiquetasGeneradas')}
          type="button"
        >
          <div className="stat-value">{stats.etiquetasGeneradas}</div>
          <div className="stat-label">Etiquetas Generadas</div>
        </button>
        <button
          className={`stat-card stat-card-success ${activeFilter === 'pendientesFulfillment' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('pendientesFulfillment')}
          type="button"
        >
          <div className="stat-value">{stats.pendientesFulfillment}</div>
          <div className="stat-label">Pendientes Envio Tracking</div>
        </button>
        <button
          className={`stat-card stat-card-neutral ${activeFilter === 'enviados' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('enviados')}
          type="button"
        >
          <div className="stat-value">{stats.enviados || 0}</div>
          <div className="stat-label">✔️ Notificados</div>
        </button>
      </div>
    </header>
  );
}

export default Header;
