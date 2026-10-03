// Resumen del Rulebook de Velinne para dar contexto a Claude en las tareas de
// la Fase 4 (brief creativo, resumen mensual, chequeo de políticas). Se arma
// con los parámetros vigentes del panel, así nunca queda desincronizado.

function resumenRulebook(p) {
  const ofertas = p.ofertas.map(o => `- ${o.tag}${o.defecto ? ' (por defecto)' : ''}: ${o.nombre}, CPA objetivo ${o.cpaObjetivo} UYU, CPA máximo ${o.cpaMaximo} UYU`).join('\n');
  return `Cuenta de Meta Ads de Velinne (uñas semicuradas de gel, Uruguay, moneda UYU). Marca de e-commerce chica; vende por Shopify.

Ofertas y CPA (la oferta se identifica por un tag en mayúsculas en el nombre de campaña o ad set):
${ofertas}

Reglas de pausa (§2): pausar si CPA > máximo de su oferta o ROAS < ${p.roasPausa}, con confianza (${p.volumenMinimo}+ compras o gasto ≥ ${p.gastoMinimoCpa}× el CPA objetivo). No tocar entidades con menos de ${p.noTocarDias} días. Caídas nuevas se confirman con una segunda lectura. Con 2+ anuncios activos se evalúa por anuncio, nunca el ad set entero. Un cambio por vez en conjuntos con aprendizaje compartido. Retargeting tiene piso de cobertura por segmento (intención alta vs engagement general). Frecuencia máxima ${p.frecuenciaFrio} en frío y ${p.frecuenciaRetargeting} en retargeting.

Escalado (§3): CPA bajo el objetivo y ROAS > ${p.roasEscalado} sostenido 7 días; subir +${p.escaladoPct}% cada ${p.escaladoCadenciaDias} días como mínimo, siempre bajo 20% (más es "edición significativa" y reinicia el aprendizaje). Elasticidad aceptable: el CPA no debe subir más de ${p.elasticidadMaxPct}% por paso.

Testeo (§6.1): cada tanda de creativos es una carpeta "SICH n" en Drive con subcarpetas "A. ÁNGULO". Cada archivo VELn va a un ad set ABO de ${p.testeoPresupuesto} UYU/día en la campaña "TESTEO - SICH n", arranque sábado 05:00. El ángulo vive en el creativo (imagen o video); el copy es fijo en toda la cuenta. Nivel temprano: a los ${p.testeoCheckpointDias} días o ${p.testeoCheckpointGastoPct}% del CPA objetivo gastado se mira CTR (mínimo ${p.ctrMinimo}%), hook de video y costo por carrito.

Graduación (§6.2): un ganador de testeo pasa a la CBO de su tanda ("CBO - PRE - SICH n", ad set BROAD) y se duplica a los 2 ad sets de retargeting. Agregar anuncios a un ad set reinicia su aprendizaje: una edición cada ${p.cadenciaAdsetDias} días.

Gate de testeo (§6.4): con el CPA de cuenta de 7 días sobre el objetivo, el testeo nuevo arranca con ${p.testeoAmarillaPct}% del presupuesto; sobre el máximo, se crea pausado.

Estructura recomendada por Meta en 2026 (actualización "Andromeda"): una CBO con un ad set BROAD y 15-25+ creativos; el lever principal es el volumen y la diversidad de creativos, no la segmentación.

Modo de trabajo: todo cambio de inversión lo aprueba un admin desde el panel. Ningún parámetro del Rulebook se cambia sin aprobación.`;
}

module.exports = { resumenRulebook };
