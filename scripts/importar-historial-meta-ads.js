// Importa el historial de acciones de las tareas programadas viejas
// (acciones-ejecutadas.md) a meta_ads_actividad, con origen 'historial'.
// La auditoría de decisiones y la detección de ganadores caídos lo usan para
// tener contexto desde el primer día.
//
// Uso:
//   node scripts/importar-historial-meta-ads.js <ruta a acciones-ejecutadas.md>            (simula)
//   node scripts/importar-historial-meta-ads.js <ruta a acciones-ejecutadas.md> --guardar  (inserta)
//
// Es idempotente: no vuelve a insertar una acción ya importada (misma fecha,
// entidad y tipo). Para deshacerlo: DELETE FROM meta_ads_actividad WHERE origen = 'historial';

require('dotenv').config();
const fs = require('fs');
const supabaseService = require('../services/supabaseService');

const [ruta, flag] = process.argv.slice(2);
if (!ruta) {
  console.error('Uso: node scripts/importar-historial-meta-ads.js <acciones-ejecutadas.md> [--guardar]');
  process.exit(1);
}
const guardar = flag === '--guardar';

// "1.392,00" → 1392
const numero = (s) => (s == null ? null : Number(String(s).replace(/\./g, '').replace(',', '.')));

function parsear(texto) {
  const acciones = [];
  let fecha = null;
  for (const linea of texto.split(/\r?\n/)) {
    const h = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(linea);
    if (h) { fecha = h[1]; continue; }
    if (!fecha || !linea.startsWith('- **')) continue;
    const id = /\b(\d{15,20})\b/.exec(linea)?.[1];
    if (!id) continue;
    let tipo = null;
    if (/—\s*\*\*Pausado\*\*/.test(linea)) tipo = 'pausa';
    else if (/—\s*\*\*Escalado/.test(linea)) tipo = 'escalado';
    else if (/—\s*\*\*Reactivado/.test(linea)) tipo = 'activacion';
    if (!tipo) continue;
    let negrita = /^- \*\*(.+?)\*\*/.exec(linea)?.[1] || '';
    // Formato viejo: "- **2026-07-11 19:40** — Ad set "X" (ID …)": la negrita es la hora.
    const hora = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/.exec(negrita.trim());
    if (hora) negrita = /"([^"]+)"/.exec(linea)?.[1] || negrita;
    const nombre = negrita
      .replace(/^(Anuncio|Ad set|Campaña|Conjunto)\s+/i, '')
      .replace(/^"|"$/g, '')
      .trim();
    const antes = {};
    const cpa = /CPA\s+([\d.]+,\d+)/.exec(linea);
    const roas = /ROAS\s+([\d.]+,\d+)/.exec(linea);
    const gasto = /gasto\s+([\d.]+,\d+)\s*UYU/i.exec(linea);
    if (cpa) antes.cpa = numero(cpa[1]);
    if (roas) antes.roas = numero(roas[1]);
    if (gasto) antes.gasto = numero(gasto[1]);
    let despues = null;
    if (tipo === 'escalado') {
      const p = /\(([\d.]+,\d+)\s*→\s*([\d.]+,\d+)/.exec(linea);
      if (p) { antes.presupuesto = numero(p[1]); despues = { presupuesto: numero(p[2]) }; }
    }
    const nivel = /^- \*\*Anuncio/i.test(linea) ? 'anuncio' : /^- \*\*Campaña|ID campaña/i.test(linea) ? 'campania' : /^- \*\*Ad set|ad set \d/i.test(linea) ? 'conjunto' : null;
    acciones.push({
      at: hora ? `${hora[1]}T${hora[2].padStart(5, '0')}:00-03:00` : `${fecha}T12:00:00-03:00`,
      tipo,
      origen: 'historial',
      usuario: null,
      entidad_tipo: nivel,
      entidad_id: id,
      entidad_nombre: nombre.slice(0, 200),
      titulo: `${tipo === 'pausa' ? 'Pausado' : tipo === 'escalado' ? 'Escalado' : 'Reactivado'} (tarea vieja): ${nombre}`.slice(0, 250),
      detalle: linea.replace(/\*\*/g, '').replace(/^- /, '').slice(0, 600),
      antes: Object.keys(antes).length ? antes : null,
      despues,
    });
  }
  return acciones;
}

(async () => {
  const acciones = parsear(fs.readFileSync(ruta, 'utf8'));
  const porTipo = acciones.reduce((a, x) => ({ ...a, [x.tipo]: (a[x.tipo] || 0) + 1 }), {});
  const fechas = acciones.map(a => a.at.slice(0, 10)).sort();
  console.log(`Encontradas ${acciones.length} acciones:`, porTipo, `· del ${fechas[0]} al ${fechas.at(-1)}`);
  if (!guardar) {
    for (const a of acciones.slice(0, 5)) console.log(' ', a.at.slice(0, 10), a.tipo, a.entidad_id, a.entidad_nombre, JSON.stringify(a.antes));
    console.log('\nSimulación: no se guardó nada. Agregá --guardar para insertar.');
    return;
  }
  const existentes = await supabaseService.listarActividadMetaAds({ desde: '2026-01-01T00:00:00Z', limite: 5000, tipos: ['pausa', 'escalado', 'activacion'] });
  const ya = new Set(existentes.filter(e => e.origen === 'historial').map(e => `${e.at.slice(0, 10)}|${e.entidad_id}|${e.tipo}`));
  let insertadas = 0;
  for (const a of acciones) {
    if (ya.has(`${a.at.slice(0, 10)}|${a.entidad_id}|${a.tipo}`)) continue;
    await supabaseService.registrarActividadMetaAds(a);
    insertadas++;
  }
  console.log(`Insertadas ${insertadas} (ya estaban ${acciones.length - insertadas}).`);
})().catch(err => { console.error(err); process.exit(1); });
