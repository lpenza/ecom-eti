// Firma por defecto cuando el alias no tiene una cargada en la base.
// Copia de firmaPorDefecto() en src/components/EmailsPanel.jsx: si cambia una,
// cambiar la otra.
const FIRMA_EMAIL_DEFAULT = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;margin-top:18px;background:#fff8fb;">
  <tr>
    <td style="border-left:4px solid #6d1f3a;padding:16px 20px;vertical-align:middle;">
      <img src="https://i.imgur.com/WbP8QZX.png" alt="VELINNE" width="165" style="display:block;border:0;outline:none;text-decoration:none;">
    </td>
    <td style="padding:14px 20px;vertical-align:top;border-left:1px solid #ead9df;">
      <div style="font-size:15px;font-weight:700;color:#3a2530;">Flor &#128156;</div>
      <div style="font-size:12px;color:#7b2f4d;margin-bottom:8px;">Equipo Velinne | Atenci&oacute;n personalizada</div>
      <div style="font-size:12px;color:#76636d;margin-bottom:8px;">U&ntilde;as de Gel UV &middot; Ediciones limitadas</div>
      <div style="font-size:12px;color:#3a2530;line-height:1.8;">
        &#127760; <a href="https://www.velinneuy.com" style="color:#7b2f4d;text-decoration:none;">www.velinneuy.com</a><br>
        &#128231; <a href="mailto:velinneuy@gmail.com" style="color:#7b2f4d;text-decoration:none;">velinneuy@gmail.com</a><br>
        &#128241; <a href="tel:+59895406741" style="color:#7b2f4d;text-decoration:none;">+598 95 406 741</a>
      </div>
      <div style="font-size:11px;font-style:italic;color:#a0356a;margin-top:8px;">Preventas activas &middot; Unidades limitadas</div>
    </td>
  </tr>
</table>`;

// Agrega la firma al cuerpo: si la plantilla es un documento completo, antes
// de </body>; si no, al final.
function agregarFirma(html, firma) {
  if (!firma) return html;
  const cuerpo = String(html || '');
  const idx = cuerpo.search(/<\/body\s*>/i);
  if (idx === -1) return cuerpo + firma;
  return cuerpo.slice(0, idx) + firma + cuerpo.slice(idx);
}

module.exports = { FIRMA_EMAIL_DEFAULT, agregarFirma };
