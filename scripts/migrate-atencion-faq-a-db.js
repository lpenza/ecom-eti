/**
 * Migración única: copia los 90+ casos curados en código (src/data/atencionFaq.js)
 * a la tabla atencion_faq_casos en Supabase, para que la Guía de Atención sea
 * 100% editable desde el panel (Editar/Eliminar en cualquier caso, no sólo en
 * los agregados nuevos).
 *
 * Requiere que la tabla ya exista: corré sql/create_atencion_faq_casos.sql en
 * el editor SQL de Supabase antes de ejecutar este script.
 *
 * Es re-ejecutable sin duplicar: si un caso con ese id ya está en la tabla, se
 * saltea (a menos que se pase --forzar, que lo pisa con el contenido del código).
 *
 * Uso (desde la raíz del proyecto, con SUPABASE_URL/SUPABASE_KEY en .env):
 *   node scripts/migrate-atencion-faq-a-db.js
 *   node scripts/migrate-atencion-faq-a-db.js --forzar
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabaseService = require('../services/supabaseService');

const FORZAR = process.argv.includes('--forzar');

// src/data/atencionFaq.js es un módulo ES (usa `export const`) pensado para el
// bundle de Vite; Node (CommonJS, sin "type": "module" en package.json) no
// puede hacerle require() directo. Como el archivo son sólo literales de datos,
// alcanza con quitarle el `export` y evaluarlo como CommonJS.
function cargarCategoriasCurdas() {
  const srcPath = path.join(__dirname, '../src/data/atencionFaq.js');
  let src = fs.readFileSync(srcPath, 'utf8');
  src = src.split('// Lista plana')[0]; // no necesitamos el flatMap, la armamos acá
  src = src.replace('export const atencionFaqCategorias', 'const atencionFaqCategorias');
  src += '\nmodule.exports = { atencionFaqCategorias };';

  const moduloFalso = { exports: {} };
  const fn = new Function('module', 'exports', src); // eslint-disable-line no-new-func
  fn(moduloFalso, moduloFalso.exports);
  return moduloFalso.exports.atencionFaqCategorias;
}

async function main() {
  const categorias = cargarCategoriasCurdas();
  const totalSituaciones = categorias.reduce((acc, c) => acc + c.situaciones.length, 0);
  console.log(`📖 ${categorias.length} temas, ${totalSituaciones} situaciones a migrar${FORZAR ? ' (--forzar: pisa las que ya existan)' : ''}.`);

  const existentes = await supabaseService.obtenerAtencionFaqCasos();
  const idsExistentes = new Set(existentes.map((c) => c.id));

  let creados = 0;
  let actualizados = 0;
  let saltados = 0;
  let fallidos = 0;

  for (const categoria of categorias) {
    for (const situacion of categoria.situaciones) {
      const payload = {
        id: situacion.id,
        categoria_id: categoria.id,
        categoria_nombre: categoria.nombre,
        categoria_icon: categoria.icon,
        categoria_descripcion: categoria.descripcion || null,
        pregunta: situacion.pregunta,
        regla: situacion.regla || null,
        respuesta: situacion.respuesta || null,
        variantes: situacion.variantes || [],
        escalar: situacion.escalar || null,
        no_prometer: situacion.noPrometer || null,
        dato_a_confirmar: situacion.datoAConfirmar || null,
        tags: situacion.tags || [],
        fuente: situacion.fuente || null,
        creado_por: 'migracion-inicial',
      };

      try {
        if (idsExistentes.has(situacion.id)) {
          if (!FORZAR) {
            saltados += 1;
            continue;
          }
          await supabaseService.actualizarAtencionFaqCaso(situacion.id, payload);
          actualizados += 1;
        } else {
          await supabaseService.crearAtencionFaqCaso(payload);
          creados += 1;
        }
      } catch (err) {
        fallidos += 1;
        console.error(`  ❌ ${situacion.id}: ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Migración terminada — creados: ${creados}, actualizados: ${actualizados}, saltados (ya existían): ${saltados}, fallidos: ${fallidos}`);
}

main().catch((err) => {
  console.error('Error fatal en la migración:', err.message);
  process.exit(1);
});
