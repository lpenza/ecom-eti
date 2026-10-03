// Cliente de Claude para las tareas de la Fase 4 del piloto de Meta Ads
// (brief creativo, resumen mensual, chequeo de políticas). Dos pasos por tarea:
//   1. investigar(): análisis en texto, con búsqueda web del lado del servidor
//      cuando hace falta (resultados con fuentes).
//   2. estructurar(): extrae del informe las decisiones en JSON validado contra
//      un schema (structured outputs), para convertirlas en propuestas.
// Requiere ANTHROPIC_API_KEY en el entorno.

const AnthropicSDK = require('@anthropic-ai/sdk');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const MODELO = process.env.META_ADS_IA_MODELO || 'claude-opus-5-5';

let cliente = null;
function obtenerCliente() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY: las tareas de redacción e investigación usan la API de Claude');
    err.status = 503;
    throw err;
  }
  if (!cliente) cliente = new Anthropic();
  return cliente;
}

function configurado() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function errorClaro(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('La API key de Anthropic es inválida');
  if (err instanceof Anthropic.RateLimitError) return new Error('Límite de uso de la API de Claude: reintentá en unos minutos');
  if (err instanceof Anthropic.APIError) return new Error(`API de Claude (${err.status}): ${err.message}`);
  return err;
}

// Sumar el uso de tokens de todas las llamadas de una tarea (para mostrar el costo).
function acumularUso(total, usage) {
  if (!usage) return total;
  return {
    entrada: total.entrada + (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
    salida: total.salida + (usage.output_tokens || 0),
    busquedas: total.busquedas + (usage.server_tool_use?.web_search_requests || 0),
  };
}

/**
 * Análisis en texto. Con `web` habilita la búsqueda web del lado del servidor.
 * Devuelve { texto, fuentes: [{ titulo, url }], uso, modelo }.
 */
async function investigar({ sistema, prompt, web = false, maxBusquedas = 8, effort = 'high', dominios = null }) {
  const client = obtenerCliente();
  const messages = [{ role: 'user', content: prompt }];
  const tools = web
    ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxBusquedas, ...(dominios ? { allowed_domains: dominios } : {}) }]
    : undefined;
  let uso = { entrada: 0, salida: 0, busquedas: 0 };
  const fuentes = new Map();
  let ultimo = null;
  // Un turno con búsquedas largas puede pausarse (pause_turn): se reanuda
  // devolviendo el turno del asistente tal cual.
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    let mensaje;
    try {
      const stream = client.beta.messages.stream({
        model: MODELO,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // si el modelo declina, el servidor reintenta con otro
        thinking: { type: 'adaptive' },
        output_config: { effort },
        system: sistema,
        messages,
        ...(tools ? { tools } : {}),
      });
      mensaje = await stream.finalMessage();
    } catch (err) {
      throw errorClaro(err);
    }
    uso = acumularUso(uso, mensaje.usage);
    ultimo = mensaje;
    for (const bloque of mensaje.content) {
      if (bloque.type === 'web_search_tool_result' && Array.isArray(bloque.content)) {
        for (const r of bloque.content) if (r.url) fuentes.set(r.url, { titulo: r.title || r.url, url: r.url });
      }
    }
    if (mensaje.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: mensaje.content });
      continue;
    }
    break;
  }
  if (ultimo.stop_reason === 'refusal') throw new Error('Claude no pudo completar este análisis (rechazo de seguridad)');
  const texto = ultimo.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!texto) throw new Error(`Claude no devolvió texto (stop_reason: ${ultimo.stop_reason})`);
  return { texto, fuentes: [...fuentes.values()], uso, modelo: ultimo.model };
}

/**
 * Extrae datos estructurados de un texto, validados contra `schema` (JSON Schema
 * con additionalProperties: false y required en cada objeto).
 */
async function estructurar({ sistema, instruccion, texto, schema }) {
  const client = obtenerCliente();
  let mensaje;
  try {
    mensaje = await client.beta.messages.create({
      model: MODELO,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: sistema,
      messages: [{ role: 'user', content: `${instruccion}\n\n<informe>\n${texto}\n</informe>` }],
    });
  } catch (err) {
    throw errorClaro(err);
  }
  if (mensaje.stop_reason === 'refusal') throw new Error('Claude no pudo estructurar el informe (rechazo de seguridad)');
  if (mensaje.stop_reason === 'max_tokens') throw new Error('La respuesta estructurada se cortó por longitud');
  const json = mensaje.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { datos: JSON.parse(json), uso: acumularUso({ entrada: 0, salida: 0, busquedas: 0 }, mensaje.usage) };
}

module.exports = { investigar, estructurar, configurado, acumularUso, MODELO };
