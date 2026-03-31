import React from 'react';

function PDFPreviewModal({ pdfUrl, onClose }) {
  const handleDescargar = () => {
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `etiqueta-${Date.now()}.pdf`;
    a.click();
  };

  return (
    <div className="modal modal-open">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Vista Previa de Etiqueta PDF</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        
        <div className="modal-body">
          <iframe 
            src={pdfUrl}
            title="Vista previa de etiqueta PDF" 
            className="pdf-preview-frame"
          />
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn btn-primary" onClick={handleDescargar}>
            📥 Descargar
          </button>
        </div>
      </div>
    </div>
  );
}

export default PDFPreviewModal;
