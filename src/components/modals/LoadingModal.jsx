import React from 'react';

function LoadingModal({ text = 'Procesando...' }) {
  return (
    <div className="modal" style={{ display: 'flex' }}>
      <div className="modal-content">
        <div className="spinner"></div>
        <p>{text}</p>
      </div>
    </div>
  );
}

export default LoadingModal;
