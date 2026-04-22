import React from 'react';

function Header({ stats, activeFilter, onFilterChange, onActualizar, onLoginUES, uesAuthenticated, currentUser }) {
  const esAdmin = currentUser?.role === 'admin';
  return (
    <header className="header">
      <div className="header-top">
        <div className="logo">
          <p>Sistema de Gestión de Envíos</p>
          {esAdmin && <p className="header-flow">Flujo: Sincronizar → Validar → Crear etiquetas → Marcar despachado → Enviar Fulfillment</p>}
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary header-btn" onClick={onActualizar}>
            ♻️ Actualizar
          </button>
          {esAdmin && (
            <>
              <button
                className={`btn header-btn ${uesAuthenticated ? 'btn-success' : 'btn-warning'}`}
                onClick={onLoginUES}
                disabled={uesAuthenticated}
              >
                {uesAuthenticated ? '✅ UES Conectado' : '🔐 Login UES'}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="stats" id="stats">
        {esAdmin && (
          <>
            <button
              className={`stat-card stat-card-warning ${activeFilter === 'porValidar' ? 'stat-card-active' : ''}`}
              onClick={() => onFilterChange?.('porValidar')}
              type="button"
            >
              <div className="stat-value">{stats.porValidar}</div>
              <div className="stat-label">Por Validar</div>
            </button>
            <button
              className={`stat-card stat-card-reclamo ${activeFilter === 'reclamosPendientes' ? 'stat-card-active' : ''}`}
              onClick={() => onFilterChange?.('reclamosPendientes')}
              type="button"
            >
              <div className="stat-value">{stats.reclamosPendientes || 0}</div>
              <div className="stat-label">Reclamos Pendientes</div>
            </button>
            <button
              className={`stat-card stat-card-contact ${activeFilter === 'pendientesContacto' ? 'stat-card-active' : ''}`}
              onClick={() => onFilterChange?.('pendientesContacto')}
              type="button"
            >
              <div className="stat-value">{stats.pendientesContacto || 0}</div>
              <div className="stat-label">Pendientes Contacto</div>
            </button>
          </>
        )}
        <button
          className={`stat-card stat-card-pickup ${activeFilter === 'pickup' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('pickup')}
          type="button"
        >
          <div className="stat-value">{stats.pickup || 0}</div>
          <div className="stat-label">🏪 Pick-UP</div>
        </button>
        <button
          className={`stat-card stat-card-recibilo ${activeFilter === 'recibilo' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('recibilo')}
          type="button"
        >
          <div className="stat-value">{stats.recibilo || 0}</div>
          <div className="stat-label">⚡ Recibilo Hoy</div>
        </button>
        <button
          className={`stat-card stat-card-neutral ${activeFilter === 'etiquetasGeneradas' ? 'stat-card-active' : ''}`}
          onClick={() => onFilterChange?.('etiquetasGeneradas')}
          type="button"
        >
          <div className="stat-value">{stats.etiquetasGeneradas}</div>
          <div className="stat-label">Etiquetas Generadas</div>
        </button>
        {esAdmin && (
          <button
            className={`stat-card stat-card-danger ${activeFilter === 'revisionManual' ? 'stat-card-active' : ''}`}
            onClick={() => onFilterChange?.('revisionManual')}
            type="button"
          >
            <div className="stat-value">{stats.revisionManual || 0}</div>
            <div className="stat-label">Revision Manual</div>
          </button>
        )}
        {esAdmin && (
          <button
            className={`stat-card stat-card-despachado ${activeFilter === 'despachados' ? 'stat-card-active' : ''}`}
            onClick={() => onFilterChange?.('despachados')}
            type="button"
          >
            <div className="stat-value">{stats.despachados || 0}</div>
            <div className="stat-label">🚀 Despachados</div>
          </button>
        )}
        {esAdmin && (
          <button
            className={`stat-card stat-card-neutral ${activeFilter === 'enviados' ? 'stat-card-active' : ''}`}
            onClick={() => onFilterChange?.('enviados')}
            type="button"
          >
            <div className="stat-value">{stats.enviados || 0}</div>
            <div className="stat-label">✅ Procesados</div>
          </button>
        )}
      </div>
      {stats.trackingAlert && (
        <div className={`header-alert ${stats.trackingBreakdown?.descuadre ? 'header-alert-danger' : 'header-alert-warning'}`}>
          <strong>Atencion tracking:</strong>{' '}
          Etiquetas generadas: {stats.trackingBreakdown?.total || 0} | Automatico: {stats.trackingBreakdown?.automatico || 0} | WhatsApp: {stats.trackingBreakdown?.whatsapp || 0} | Revision manual: {stats.trackingBreakdown?.revisionManual || 0}
          {stats.trackingBreakdown?.descuadre && ' | Hay un descuadre en la clasificacion, revisar logica de canales.'}
        </div>
      )}
    </header>
  );
}

export default Header;
