const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Clase de error personalizada para errores de validación
class ValidationError extends Error {
  constructor(message, field = null, originalValue = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.originalValue = originalValue;
    this.isValidationError = true;
  }
}

// Polyfill para Node.js 16
if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = fetch.Headers;
  globalThis.Request = fetch.Request;
  globalThis.Response = fetch.Response;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let uesContextSnapshotCache = null;

function getUesDepartamentosLocalidadesSnapshot() {
  if (uesContextSnapshotCache !== null) {
    return uesContextSnapshotCache;
  }

  try {
    const contextPath = path.join(process.cwd(), 'ues_getContext.json');
    if (!fs.existsSync(contextPath)) {
      uesContextSnapshotCache = [];
      return uesContextSnapshotCache;
    }

    const raw = fs.readFileSync(contextPath, 'utf8');
    const parsed = JSON.parse(raw);
    const snapshot = Array.isArray(parsed?.departamentos_localidades)
      ? parsed.departamentos_localidades
      : [];

    uesContextSnapshotCache = snapshot;
    return uesContextSnapshotCache;
  } catch (error) {
    uesContextSnapshotCache = [];
    return uesContextSnapshotCache;
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function findBestLocalidadMatch(localidadKey, candidates, maxDistance = 2) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let best = null;

  for (const candidate of candidates) {
    const candidateName = String(candidate?.nombre || candidate?.localidad_nombre || '').trim();
    if (!candidateName) continue;

    const distance = levenshteinDistance(localidadKey, normalizeText(candidateName));
    if (!best || distance < best.distance) {
      best = { candidate, distance };
      if (distance === 0) break;
    }
  }

  if (!best || best.distance > maxDistance) return null;
  return best.candidate;
}

function buildCustomerKeyFromPedido(pedido = {}) {
  const email = normalizeEmail(pedido.cliente_email);
  if (email) return `email:${email}`;

  const phone = normalizePhoneDigits(pedido.cliente_telefono);
  if (phone) return `phone:${phone}`;

  const name = normalizeText(pedido.cliente_nombre);
  if (name) return `name:${name}`;

  return `pedido:${pedido.id || 'unknown'}`;
}

class SupabaseService {
  isMissingRelationError(error, relationName) {
    const msg = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '');
    return (
      code === '42P01' ||
      msg.includes(`relation \"${relationName}\"`) ||
      msg.includes(`table 'public.${relationName}'`)
    );
  }

  buildCustomerKey(pedido = {}) {
    return buildCustomerKeyFromPedido(pedido);
  }

  async obtenerDepartamentosUes() {
    const snapshot = getUesDepartamentosLocalidadesSnapshot();
    if (snapshot.length > 0) {
      return snapshot
        .map((dep) => ({
          id: String(dep.departamento_id),
          nombre: dep.departamento_nombre || `Departamento ${dep.departamento_id}`,
        }))
        .sort((a, b) => Number(a.id) - Number(b.id));
    }

    // Fallback: consultar directamente a UES en lugar de Supabase
    try {
      const uesService = require('./uesService');
      const uesContext = await uesService.obtenerContextoUES();
      const depLocalidades = uesContext.departamentos_localidades || [];
      
      return depLocalidades
        .map((dep) => ({
          id: String(dep.departamento_id),
          nombre: dep.departamento_nombre || `Departamento ${dep.departamento_id}`,
        }))
        .sort((a, b) => Number(a.id) - Number(b.id));
    } catch (error) {
      console.error('⚠️ No se pudo obtener catálogo de UES, fallback vacío:', error.message);
      return [];
    }
  }

  async obtenerLocalidadesUes(departamentoId = null) {
    const snapshot = getUesDepartamentosLocalidadesSnapshot();
    if (snapshot.length > 0) {
      const flattened = snapshot.flatMap((dep) => {
        const localidades = Array.isArray(dep.localidades) ? dep.localidades : [];
        return localidades.map((loc) => ({
          id: String(loc.localidad_id),
          nombre: loc.localidad_nombre,
          departamento_id: String(dep.departamento_id),
          departamento_nombre: dep.departamento_nombre || `Departamento ${dep.departamento_id}`,
        }));
      });

      const filtered = departamentoId
        ? flattened.filter((loc) => String(loc.departamento_id) === String(departamentoId))
        : flattened;

      return filtered.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')));
    }

    // Fallback: consultar directamente a UES en lugar de Supabase
    try {
      const uesService = require('./uesService');
      const uesContext = await uesService.obtenerContextoUES();
      const depLocalidades = uesContext.departamentos_localidades || [];
      
      const flattened = depLocalidades.flatMap((dep) => {
        const localidades = Array.isArray(dep.localidades) ? dep.localidades : [];
        return localidades.map((loc) => ({
          id: String(loc.localidad_id),
          nombre: loc.localidad_nombre,
          departamento_id: String(dep.departamento_id),
          departamento_nombre: dep.departamento_nombre || `Departamento ${dep.departamento_id}`,
        }));
      });

      const filtered = departamentoId
        ? flattened.filter((loc) => String(loc.departamento_id) === String(departamentoId))
        : flattened;

      return filtered.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')));
    } catch (error) {
      console.error('⚠️ No se pudo obtener localidades de UES, fallback vacío:', error.message);
      return [];
    }
  }

  // Buscar localidad UES por nombre + departamento_id (numérico) o nombre de departamento.
  // Cuando departamentoRef es un número o string numérico, lo usa como ID directamente.
  async buscarLocalidadUesPorId(localidad, departamentoRef) {
    const esId = departamentoRef != null && !isNaN(String(departamentoRef).trim());
    if (esId) {
      const depId = String(departamentoRef).trim();
      console.log(`🔎 [buscarLocalidadUesPorId] localidad="${localidad}" departamento_id=${depId}`);

      const normalizedKey = normalizeText(localidad);
      const snapshot = getUesDepartamentosLocalidadesSnapshot();

      if (snapshot.length > 0) {
        const dep = snapshot.find((d) => String(d.departamento_id) === depId);
        const localidades = dep?.localidades || [];
        console.log(`   snapshot: ${localidades.length} localidades en dep ${depId}`);

        const exact = localidades.find((loc) => normalizeText(loc.localidad_nombre) === normalizedKey);
        if (exact) {
          console.log(`   ✅ exacto: ${exact.localidad_nombre} (${exact.localidad_id})`);
          return { ues_id: String(exact.localidad_id), departamento_id: Number(depId), nombre: exact.localidad_nombre };
        }

        const fuzzyPool = localidades.map((loc) => ({
          localidad_id: loc.localidad_id,
          localidad_nombre: loc.localidad_nombre,
          departamento_id: depId,
        }));
        const fuzzy = findBestLocalidadMatch(normalizedKey, fuzzyPool);
        if (fuzzy) {
          console.log(`   ✅ fuzzy: ${fuzzy.localidad_nombre} (${fuzzy.localidad_id})`);
          return { ues_id: String(fuzzy.localidad_id), departamento_id: Number(depId), nombre: fuzzy.localidad_nombre };
        }
        console.log(`   ⚠️ sin match en snapshot para "${localidad}" en dep ${depId}`);
      }

      // Fallback DB filtrada por departamento_id
      const { data, error } = await supabase
        .from('localidades_ues')
        .select('ues_id, departamento_id, nombre')
        .ilike('nombre', `%${String(localidad).trim()}%`)
        .eq('departamento_id', depId)
        .limit(5);
      if (error) throw error;
      console.log(`   DB resultados:`, data?.map((d) => d.nombre));
      if (data && data.length > 0) return data[0];

      throw new ValidationError(
        `No se encontró localidad UES para: "${localidad}" en departamento ID ${depId}`,
        'localidad',
        { localidad, departamento_id: depId }
      );
    }
    // Sin ID numérico: delegar a la búsqueda por nombre
    return this.buscarLocalidadUes(localidad, departamentoRef);
  }

  // Buscar localidad UES por nombre para obtener IDs requeridos por dispatcher.
  async buscarLocalidadUes(localidad, departamento) {
    if (!localidad) {
      throw new ValidationError(
        'Localidad no informada en el pedido. Por favor, completa la localidad.',
        'localidad',
        null
      );
    }

    const normalizedLocalidad = String(localidad).trim();
    const normalizedLocalidadKey = normalizeText(localidad);
    const normalizedDepartamentoKey = normalizeText(departamento);

    const snapshot = getUesDepartamentosLocalidadesSnapshot();

    let preferredDepartamentoId = null;
    if (snapshot.length > 0 && normalizedDepartamentoKey) {
      const depMatch = snapshot.find(
        (dep) => normalizeText(dep.departamento_nombre) === normalizedDepartamentoKey
      );
      if (depMatch) {
        preferredDepartamentoId = String(depMatch.departamento_id);
      }
    }

    if (snapshot.length > 0) {
      const departamentosCandidates = preferredDepartamentoId
        ? snapshot.filter((dep) => String(dep.departamento_id) === preferredDepartamentoId)
        : snapshot;

      for (const dep of departamentosCandidates) {
        const localidades = Array.isArray(dep.localidades) ? dep.localidades : [];
        const exact = localidades.find(
          (loc) => normalizeText(loc.localidad_nombre) === normalizedLocalidadKey
        );

        if (exact) {
          return {
            ues_id: String(exact.localidad_id),
            departamento_id: Number(dep.departamento_id),
            nombre: exact.localidad_nombre,
          };
        }
      }

      // Fallback difuso para tolerar typos menores (ej: Monteviddo -> Montevideo)
      const fuzzyPool = departamentosCandidates.flatMap((dep) => {
        const localidades = Array.isArray(dep.localidades) ? dep.localidades : [];
        return localidades.map((loc) => ({
          localidad_id: loc.localidad_id,
          localidad_nombre: loc.localidad_nombre,
          departamento_id: dep.departamento_id,
        }));
      });

      const fuzzy = findBestLocalidadMatch(normalizedLocalidadKey, fuzzyPool);
      if (fuzzy) {
        return {
          ues_id: String(fuzzy.localidad_id),
          departamento_id: Number(fuzzy.departamento_id),
          nombre: fuzzy.localidad_nombre,
        };
      }
    }

    // 1) Intento exacto (case-insensitive)
    let query = supabase
      .from('localidades_ues')
      .select('ues_id, departamento_id, nombre')
      .ilike('nombre', normalizedLocalidad)
      .limit(1);

    if (preferredDepartamentoId) {
      query = query.eq('departamento_id', preferredDepartamentoId);
    }

    let { data, error } = await query;
    if (error) {
      throw error;
    }

    // 2) Fallback por coincidencia parcial
    if (!data || data.length === 0) {
      let partialQuery = supabase
        .from('localidades_ues')
        .select('ues_id, departamento_id, nombre')
        .ilike('nombre', `%${normalizedLocalidad}%`)
        .limit(1);

      if (preferredDepartamentoId) {
        partialQuery = partialQuery.eq('departamento_id', preferredDepartamentoId);
      }

      const partial = await partialQuery;

      if (partial.error) {
        throw partial.error;
      }

      data = partial.data;

      // 3) Fallback final sin filtro de departamento, para no bloquear casos no mapeados.
      if ((!data || data.length === 0) && preferredDepartamentoId) {
        const globalPartial = await supabase
          .from('localidades_ues')
          .select('ues_id, departamento_id, nombre')
          .ilike('nombre', `%${normalizedLocalidad}%`)
          .limit(1);

        if (globalPartial.error) {
          throw globalPartial.error;
        }

        data = globalPartial.data;
      }
    }

    if (!data || data.length === 0) {
      // 4) Fallback difuso consultando DB cuando no hay snapshot utilizable
      let fuzzyQuery = supabase
        .from('localidades_ues')
        .select('ues_id, departamento_id, nombre');

      if (preferredDepartamentoId) {
        fuzzyQuery = fuzzyQuery.eq('departamento_id', preferredDepartamentoId);
      }

      const fuzzyResult = await fuzzyQuery;
      if (fuzzyResult.error) {
        throw fuzzyResult.error;
      }

      const fuzzy = findBestLocalidadMatch(normalizedLocalidadKey, fuzzyResult.data || []);
      if (fuzzy) {
        return fuzzy;
      }

      throw new ValidationError(
        `No se encontró localidad UES para: ${normalizedLocalidad}${departamento ? ` (${departamento})` : ''}. Por favor, verifica que la localidad y departamento sean correctos.`,
        'localidad',
        { localidad: normalizedLocalidad, departamento }
      );
    }

    return data[0];
  }

  // Obtener pedidos pendientes
  async obtenerPedidosPendientes() {
    try {
      console.log('📡 Consultando Supabase...');
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('etiqueta_generada', false)
        .eq('es_envio_express', false)
        .order('created_at', { ascending: true });
      
      if (error) {
        console.error('❌ Error de Supabase:', error);
        throw error;
      }
      
      console.log(`✅ Supabase devolvió ${data ? data.length : 0} pedidos`);
      console.log('📝 Primer pedido (muestra):', data && data[0] ? JSON.stringify(data[0], null, 2) : 'Sin datos');
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosPendientes:', error);
      throw error;
    }
  }

  // Obtener un pedido específico
  async obtenerPedido(pedidoId) {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();

    if (error) throw error;
    return data;
  }

  async obtenerPedidoPorNumero(numero) {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('numero_pedido', String(numero))
      .limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }

  // Obtener todos los pedidos activos (pendientes + con etiqueta, excluye procesados y reclamos)
  async obtenerPedidosActivos() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .neq('estado', 'enviado')
        .neq('estado', 'despachado')
        .neq('es_envio_express', true)
        .neq('es_reclamo', true)
        // Excluir tipos especiales que tienen su propio flujo
        .or('tipo_envio.is.null,tipo_envio.eq.estandar')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosActivos:', error);
      throw error;
    }
  }

  // Crear un pedido de reenvío a partir de un pedido existente
  async crearReenvio(pedidoOriginalId, datos) {
    try {
      const { data: original, error: fetchError } = await supabase
        .from('pedidos')
        .select('*')
        .eq('id', pedidoOriginalId)
        .single();

      if (fetchError) throw fetchError;

      // Contar reenvíos previos del mismo pedido para generar sufijo único
      const { count } = await supabase
        .from('pedidos')
        .select('id', { count: 'exact', head: true })
        .eq('pedido_origen_id', pedidoOriginalId);

      const sufijo = (count || 0) + 1;
      const numeroPedido = `RCL-${original.numero_pedido}${sufijo > 1 ? `-${sufijo}` : ''}`;

      const { data, error } = await supabase
        .from('pedidos')
        .insert({
          numero_pedido:    numeroPedido,
          cliente_nombre:   datos.cliente_nombre   || original.cliente_nombre,
          cliente_email:    datos.cliente_email    || original.cliente_email,
          cliente_telefono: datos.cliente_telefono || original.cliente_telefono,
          direccion_envio:  datos.direccion_envio  || original.direccion_envio,
          localidad:        datos.localidad        || original.localidad,
          departamento:     datos.departamento     || original.departamento,
          codigo_postal:    datos.codigo_postal    || original.codigo_postal,
          tipo_envio:       datos.tipo_envio       || 'estandar',
          estado:           'pendiente',
          etiqueta_generada: false,
          es_reenvio:       true,
          pedido_origen_id: pedidoOriginalId,
          motivo_reenvio:   datos.motivo_reenvio   || '',
          created_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en crearReenvio:', error);
      throw error;
    }
  }

  // Obtener pedidos de reenvío pendientes
  async obtenerPedidosReenvio() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('es_reenvio', true)
        .not('estado', 'in', '("enviado","despachado")')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosReenvio:', error);
      throw error;
    }
  }

  // Buscar pedidos por número, nombre, email o teléfono (para reenvíos)
  async buscarPedidos(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .or(
          `numero_pedido.ilike.%${term}%,cliente_nombre.ilike.%${term}%,cliente_email.ilike.%${term}%,cliente_telefono.ilike.%${term}%`
        )
        .eq('es_reenvio', false)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en buscarPedidos:', error);
      throw error;
    }
  }

  // Obtener pedidos Pick-UP (pendientes de despacho)
  async obtenerPedidosPickup() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('tipo_envio', 'pickup_local')
        .not('estado', 'in', '("enviado","despachado")')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosPickup:', error);
      throw error;
    }
  }

  // Obtener pedidos Recibilo Hoy (pendientes de despacho)
  async obtenerPedidosRecibilo() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('tipo_envio', 'recibilo_hoy')
        .not('estado', 'in', '("enviado","despachado")')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosRecibilo:', error);
      throw error;
    }
  }

  // Obtener pedidos para armado de operario:
  // incluye estandar, pickup, recibilo, express (siempre que tengan etiqueta y no esten cerrados).
  async obtenerPedidosParaArmado() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('etiqueta_generada', true)
        .is('notificacion_enviada_at', null)
        .neq('estado', 'enviado')
        .neq('estado', 'despachado')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosParaArmado:', error);
      throw error;
    }
  }

  // Crear un pedido de reenvío a partir de un pedido existente
  async crearReenvio(pedidoOriginalId, datos) {
    try {
      const { data: original, error: fetchError } = await supabase
        .from('pedidos')
        .select('*')
        .eq('id', pedidoOriginalId)
        .single();

      if (fetchError) throw fetchError;

      // Contar reenvíos previos del mismo pedido para generar sufijo único
      const { count } = await supabase
        .from('pedidos')
        .select('id', { count: 'exact', head: true })
        .eq('pedido_origen_id', pedidoOriginalId);

      const sufijo = (count || 0) + 1;
      const numeroPedido = `RCL-${original.numero_pedido}${sufijo > 1 ? `-${sufijo}` : ''}`;

      const { data, error } = await supabase
        .from('pedidos')
        .insert({
          numero_pedido:    numeroPedido,
          cliente_nombre:   datos.cliente_nombre   || original.cliente_nombre,
          cliente_email:    datos.cliente_email    || original.cliente_email,
          cliente_telefono: datos.cliente_telefono || original.cliente_telefono,
          direccion_envio:  datos.direccion_envio  || original.direccion_envio,
          localidad:        datos.localidad        || original.localidad,
          departamento:     datos.departamento     || original.departamento,
          codigo_postal:    datos.codigo_postal    || original.codigo_postal,
          tipo_envio:       datos.tipo_envio       || 'estandar',
          estado:           'pendiente',
          etiqueta_generada: false,
          es_reenvio:       true,
          pedido_origen_id: pedidoOriginalId,
          motivo_reenvio:   datos.motivo_reenvio   || '',
          created_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en crearReenvio:', error);
      throw error;
    }
  }

  // Obtener pedidos de reenvío pendientes
  async obtenerPedidosReenvio() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .eq('es_reenvio', true)
        .not('estado', 'in', '("enviado","despachado")')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosReenvio:', error);
      throw error;
    }
  }

  // Guardar link de Drive en un pedido
  async guardarLinkDrivePedido(pedidoId, linkDrive) {
    const { data, error } = await supabase
      .from('pedidos')
      .update({ link_etiqueta_drive: linkDrive, etiqueta_generada: true })
      .eq('id', pedidoId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Obtener pedidos listos para fulfillment en Shopify
  async obtenerPedidosParaFulfillment() {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('etiqueta_generada', true)
      .not('numero_seguimiento_ues', 'is', null)
      .neq('estado', 'enviado')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  // Calcular total de un pedido a partir de sus items
  _calcularTotalItems(items = []) {
    return items.reduce((sum, item) => {
      const precio = item.precio_venta_manual ?? item.precio_unitario ?? 0;
      return sum + (Number(precio) * (Number(item.cantidad) || 1));
    }, 0);
  }

  // Obtener pedidos despachados (marcados manualmente, sin fulfillment Shopify aún)
  async obtenerPedidosDespachados() {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('estado', 'despachado')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Obtener pedidos procesados (fulfillment enviado a Shopify)
  async obtenerPedidosEnviados() {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('estado', 'enviado')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Buscar pedidos por número, nombre, email o teléfono (para reenvíos)
  async buscarPedidos(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .or(
          `numero_pedido.ilike.%${term}%,cliente_nombre.ilike.%${term}%,cliente_email.ilike.%${term}%,cliente_telefono.ilike.%${term}%`
        )
        .eq('es_reenvio', false)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en buscarPedidos:', error);
      throw error;
    }
  }

  // Obtener todos los numero_pedido existentes en DB (para detectar pedidos nuevos en sync)
  async obtenerShopifyOrderIds() {
    const { data } = await supabase.from('pedidos').select('numero_pedido');
    return new Set((data || []).map((p) => String(p.numero_pedido)).filter(Boolean));
  }

  // Obtener reclamos pendientes de notificación (es_reclamo=true, etiqueta generada, sin notificar)
  async obtenerReclamosPendientes() {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('es_reclamo', true)
      .eq('etiqueta_generada', true)
      .eq('estado', 'pendiente')
      .is('notificacion_enviada_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Obtener pedidos candidatos para reclamo (items con total=0)
  async obtenerPedidosParaReclamo() {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*, pedido_items(precio_unitario, precio_venta_manual, cantidad)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return (data || [])
      .filter(p => {
        const items = p.pedido_items || [];
        if (items.length === 0) return false;
        return this._calcularTotalItems(items) === 0;
      })
      .map(({ pedido_items: _, ...p }) => p);
  }

  // Obtener pedidos candidatos para follow-up comercial
  // Si se pasa estado, filtra por ese estado puntual.
  // Si no se pasa, mantiene el criterio original (finalizados/notificados).
  async obtenerPedidosParaFollowUp(estado = '') {
    let query = supabase
      .from('pedidos')
      .select('*');

    const estadoNormalizado = String(estado || '').trim().toLowerCase();
    if (estadoNormalizado) {
      query = query.eq('estado', estadoNormalizado);
    } else {
      query = query.or('estado.eq.enviado,notificacion_enviada_at.not.is.null');
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async buscarPedidosPorNumero(numeroPedido = '') {
    const query = String(numeroPedido || '').trim();
    if (!query) return [];

    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .ilike('numero_pedido', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    return data || [];
  }

  async obtenerEstadosClientes(customerIds = []) {
    const ids = Array.from(new Set((customerIds || []).filter(Boolean)));
    if (ids.length === 0) return {};

    // Evitar URLs gigantes en `.in(...)` cuando hay cientos de clientes.
    const batchSize = 80;
    const byId = {};

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const { data, error } = await supabase
        .from('customer_states')
        .select('customer_id, state, updated_at')
        .in('customer_id', chunk);

      if (error) {
        // Si la tabla aun no existe, no romper el flujo operativo.
        if (this.isMissingRelationError(error, 'customer_states')) {
          return {};
        }
        throw error;
      }

      for (const row of data || []) {
        byId[row.customer_id] = {
          state: row.state,
          updated_at: row.updated_at,
        };
      }
    }

    return byId;
  }

  async obtenerPedidosFeedbackCampana({ from = '', to = '' } = {}) {
    let query = supabase
      .from('pedidos')
      .select('id, numero_pedido, cliente_nombre, cliente_email, cliente_telefono, followup_enviado_at, followup_retry_count')
      .select('id, numero_pedido, cliente_nombre, cliente_email, cliente_telefono, followup_enviado_at, followup_retry_count')
      .not('followup_enviado_at', 'is', null)
      .order('followup_enviado_at', { ascending: false })
      .limit(5000);

    if (from) {
      query = query.gte('followup_enviado_at', from);
    }
    if (to) {
      query = query.lte('followup_enviado_at', to);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async guardarEstadoCliente(customerId, state) {
    const now = new Date().toISOString();
    const payload = {
      customer_id: String(customerId),
      state,
      updated_at: now,
    };

    const { data, error } = await supabase
      .from('customer_states')
      .upsert(payload, { onConflict: 'customer_id' })
      .select()
      .single();

    if (error) {
      if (this.isMissingRelationError(error, 'customer_states')) {
        throw new Error('Falta crear tabla customer_states en Supabase');
      }
      throw error;
    }
    return data;
  }

  async obtenerNotasCliente(customerId) {
    const { data, error } = await supabase
      .from('customer_notes')
      .select('id, customer_id, content, created_at')
      .eq('customer_id', String(customerId))
      .order('created_at', { ascending: false });

    if (error) {
      // Si la tabla aun no existe, no romper el flujo operativo.
      if (this.isMissingRelationError(error, 'customer_notes')) {
        return [];
      }
      throw error;
    }
    return data || [];
  }

  async obtenerNotasBatch(customerIds = []) {
    const ids = Array.from(new Set((customerIds || []).filter(Boolean)));
    if (ids.length === 0) return {};

    const batchSize = 80;
    const byCustomer = {};

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const { data, error } = await supabase
        .from('customer_notes')
        .select('id, customer_id, content, created_at')
        .in('customer_id', chunk)
        .order('created_at', { ascending: false });

      if (error) {
        if (this.isMissingRelationError(error, 'customer_notes')) {
          return {};
        }
        throw error;
      }

      for (const note of data || []) {
        if (!byCustomer[note.customer_id]) byCustomer[note.customer_id] = [];
        byCustomer[note.customer_id].push(note);
      }
    }

    return byCustomer;
  }

  async agregarNotaCliente(customerId, content) {
    const payload = {
      customer_id: String(customerId),
      content: String(content || '').trim(),
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('customer_notes')
      .insert(payload)
      .select()
      .single();

    if (error) {
      if (this.isMissingRelationError(error, 'customer_notes')) {
        throw new Error('Falta crear tabla customer_notes en Supabase');
      }
      throw error;
    }
    return data;
  }

  async marcarFollowupEnviado(pedidoId) {
    const { data, error } = await supabase
      .from('pedidos')
      .update({ followup_enviado_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .select('id, followup_enviado_at')
      .single();

    if (error) throw error;
    return data;
  }

  async registrarReintentoFollowup(pedidoId) {
    const { data: current, error: fetchError } = await supabase
      .from('pedidos')
      .select('followup_retry_count')
      .eq('id', pedidoId)
      .single();

    if (fetchError) throw fetchError;

    const newCount = (current?.followup_retry_count ?? 0) + 1;

    const { data, error } = await supabase
      .from('pedidos')
      .update({
        followup_enviado_at: new Date().toISOString(),
        followup_retry_count: newCount,
      })
      .eq('id', pedidoId)
      .select('id, followup_enviado_at, followup_retry_count')
      .single();

    if (error) throw error;
    return data;
  }

  // Actualizar pedido
  async actualizarPedido(pedidoId, datos) {
    console.log('📝 Actualizando pedido:', pedidoId, 'con datos:', datos);
    const { data, error } = await supabase
      .from('pedidos')
      .update(datos)
      .eq('id', pedidoId)
      .select();
    
    if (error) {
      console.error('❌ Error actualizando pedido:', error);
      throw error;
    }
    
    console.log('✅ Pedido actualizado correctamente');
    return data[0];
  }

  // Sincronizar órdenes desde Shopify
  async sincronizarOrdenes(ordenes) {
    const googleMapsService = require('./googleMapsService');
    const resultados = [];

    for (const orden of ordenes) {
      try {
        const numeroPedido = String(orden.order_number);

        // Verificar si ya existe
        const { data: existente } = await supabase
          .from('pedidos')
          .select('id')
          .eq('numero_pedido', numeroPedido)
          .single();

        // Detectar tipo de envío desde Shopify shipping_lines
        const shippingTitle = String(orden.shipping_lines?.[0]?.title || '').toLowerCase();
        let tipoEnvio = 'estandar';
        if (shippingTitle.includes('pick-up') || shippingTitle.includes('pick up') || shippingTitle.includes('pickup')) {
          tipoEnvio = 'pickup_local';
        } else if (shippingTitle.includes('recibilo')) {
          tipoEnvio = 'recibilo_hoy';
        }

        if (existente) {
          // Actualizar (solo estado; no pisar tipo_envio si ya fue seteado)
          const { data } = await supabase
            .from('pedidos')
            .update({
              estado: this.mapearEstadoShopify(orden.fulfillment_status),
              updated_at: new Date().toISOString()
            })
            .eq('numero_pedido', numeroPedido)
            .select();

          resultados.push(data[0]);
        } else {
          // Crear nuevo
          const { data } = await supabase
            .from('pedidos')
            .insert({
              numero_pedido: numeroPedido,
              cliente_nombre: `${orden.customer?.first_name || ''} ${orden.customer?.last_name || ''}`.trim(),
              cliente_email: orden.customer?.email || '',
              cliente_telefono: orden.customer?.phone || orden.shipping_address?.phone || '',
              direccion_envio: orden.shipping_address?.address1 || '',
              localidad: orden.shipping_address?.city || '',
              departamento: orden.shipping_address?.province || '',
              codigo_postal: orden.shipping_address?.zip || '',
              estado: 'pendiente',
              tipo_envio: tipoEnvio,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .select();

          const pedidoNuevo = data[0];
          resultados.push(pedidoNuevo);

          // Geocodificar automáticamente el nuevo pedido
          if (pedidoNuevo?.id && orden.shipping_address?.address1) {
            try {
              const geoResult = await googleMapsService.geocodeAsync(
                orden.shipping_address.address1,
                orden.shipping_address.city || 'Montevideo',
                'Uruguay'
              );
              if (geoResult.exitoso) {
                await supabase.from('pedidos').update({
                  barrio_google_maps: geoResult.barrio || null,
                  localidad_detectada: geoResult.localidad || null,
                  latitud: geoResult.latitud || null,
                  longitud: geoResult.longitud || null,
                }).eq('id', pedidoNuevo.id);
              }
            } catch (geoError) {
              console.warn(`⚠️  No se pudo geocodificar orden ${orden.id}: ${geoError.message}`);
            }
          }
        }
      } catch (error) {
        console.error(`Error procesando orden ${orden.id}:`, error);
      }
    }

    return resultados;
  }

  // Obtener estadísticas
  async obtenerEstadisticas() {
    const { data: todos } = await supabase
      .from('pedidos')
      .select('estado', { count: 'exact' });
    
    const stats = {
      total: todos.length,
      pendientes: todos.filter(p => p.estado === 'pendiente').length,
      procesados: todos.filter(p => p.estado === 'etiqueta_generada').length,
      entregados: todos.filter(p => p.estado === 'entregado').length,
      cancelados: todos.filter(p => p.estado === 'cancelado').length
    };
    
    return stats;
  }

  mapearEstadoShopify(fulfillmentStatus) {
    const mapeo = {
      null: 'pendiente',
      'pending': 'pendiente',
      'in_progress': 'en_proceso',
      'fulfilled': 'entregado',
      'cancelled': 'cancelado'
    };
    return mapeo[fulfillmentStatus] || 'pendiente';
  }

  // ==================== GESTIÓN DE PLANTILLAS ====================

  // Función auxiliar para asegurar UTF-8 válido
  ensureUtf8(text) {
    // Supabase/PostgreSQL already uses UTF-8 — just return the string as-is.
    // The previous Buffer round-trip could replace lone surrogates (emoji) with '?'.
    if (!text) return text;
    return String(text);
  }

  // Obtener todas las plantillas
  async obtenerPlantillas() {
    try {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      
      // Asegurar UTF-8 en el contenido
      return (data || []).map(t => ({
        ...t,
        content: this.ensureUtf8(t.content)
      }));
    } catch (error) {
      console.error('Error al obtener plantillas:', error);
      throw error;
    }
  }

  // Crear una nueva plantilla
  async crearPlantilla(plantilla) {
    try {
      const { data, error } = await supabase
        .from('templates')
        .insert({
          name: plantilla.name,
          content: this.ensureUtf8(plantilla.content),
          is_active: plantilla.is_active || false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select();

      if (error) throw error;
      return data[0];
    } catch (error) {
      console.error('Error al crear plantilla:', error);
      throw error;
    }
  }

  // Actualizar una plantilla existente
  async actualizarPlantilla(id, cambios) {
    try {
      // Asegurar UTF-8 en el content si viene en los cambios
      const cambiosUtf8 = { ...cambios };
      if (cambiosUtf8.content) {
        cambiosUtf8.content = this.ensureUtf8(cambiosUtf8.content);
      }
      
      const { data, error } = await supabase
        .from('templates')
        .update({
          ...cambiosUtf8,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select();

      if (error) throw error;
      return data[0];
    } catch (error) {
      console.error('Error al actualizar plantilla:', error);
      throw error;
    }
  }

  // Eliminar una plantilla
  async eliminarPlantilla(id) {
    try {
      const { error } = await supabase
        .from('templates')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error al eliminar plantilla:', error);
      throw error;
    }
  }

  // Establecer plantilla activa (desactiva las demás)
  async establecerPlantillaActiva(id) {
    try {
      // Desactivar todas las plantillas
      await supabase
        .from('templates')
        .update({ is_active: false });

      // Activar la plantilla seleccionada
      const { data, error } = await supabase
        .from('templates')
        .update({ 
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select();

      if (error) throw error;
      return data[0];
    } catch (error) {
      console.error('Error al establecer plantilla activa:', error);
      throw error;
    }
  }

  // Inicializar plantillas por defecto si la tabla está vacía
  async inicializarPlantillasDefecto() {
    try {
      const plantillas = await this.obtenerPlantillas();
      
      if (plantillas.length === 0) {
        const plantillasDefecto = [
          {
            name: 'Seguimiento Nutritivo',
            content: 'Hola {{cliente_nombre}}! 🌱\n\n¿Cómo va tu experiencia con tu pedido #{{numero_pedido}}? Ya pasaron {{dias_transcurridos}} días. \n\nNos encantaría saber cómo te sentís y si tenés alguna consulta sobre tu plan nutricional. Estamos acá para acompañarte! 💚\n\n¿Hay algo en lo que podamos ayudarte?',
            is_active: true
          },
          {
            name: 'Notificación de Envío',
            content: '¡Hola {{cliente_nombre}}! 🚚\n\nTu pedido #{{numero_pedido}} ya está en camino.\n\n📦 Código de seguimiento: {{tracking}}\n🔗 Seguí tu envío acá: {{tracking_url}}\n\n¡Gracias por tu compra! 💚',
            is_active: false
          }
        ];

        for (const plantilla of plantillasDefecto) {
          await this.crearPlantilla(plantilla);
        }

        console.log('✅ Plantillas por defecto inicializadas en la base de datos');
      }
    } catch (error) {
      console.error('Error al inicializar plantillas por defecto:', error);
    }
  }

  // ── Auth helpers ─────────────────────────────────────────────────────────────
  async buscarUsuarioPorEmail(email) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .eq('activo', true)
      .limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  }

  async insertarUsuarios(usuarios) {
    const { error } = await supabase.from('users').insert(usuarios);
    if (error) throw error;
  }

  async contarUsuarios() {
    const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }

  // ── Admin helpers ─────────────────────────────────────────────────────────────
  async listarUsuarios() {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, nombre, role, activo, monto_por_pedido')
      .order('nombre');
    if (error) throw error;
    return data || [];
  }

  async crearUsuario({ email, nombre, password_hash, role }) {
    const { data, error } = await supabase
      .from('users')
      .insert({ email, nombre, password_hash, role, activo: true })
      .select('id, email, nombre, role')
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarMontoPorPedido(userId, monto) {
    const { error } = await supabase
      .from('users')
      .update({ monto_por_pedido: monto })
      .eq('id', userId);
    if (error) throw error;
  }

  async reportePedidosPorUsuario(desde, hasta) {
    const query = supabase
      .from('pedidos')
      .select('despachado_por_nombre, armado_at, notificacion_enviada_at, created_at')
      .in('estado', ['despachado', 'enviado'])
      .not('despachado_por_nombre', 'is', null);

    const { data, error } = await query;
    if (error) throw error;

    const desdeDate = desde ? new Date(`${desde}T00:00:00`) : null;
    const hastaDate = hasta ? new Date(`${hasta}T23:59:59`) : null;

    const dataFiltrada = (data || []).filter((p) => {
      const fechaProcesado = p.armado_at || p.notificacion_enviada_at || p.created_at;
      if (!fechaProcesado) return false;
      const fecha = new Date(fechaProcesado);
      if (desdeDate && fecha < desdeDate) return false;
      if (hastaDate && fecha > hastaDate) return false;
      return true;
    });

    const porUsuario = {};
    for (const p of dataFiltrada) {
      const nombre = p.despachado_por_nombre;
      porUsuario[nombre] = (porUsuario[nombre] || 0) + 1;
    }

    const usuarios = await this.listarUsuarios();
    return usuarios
      .filter((u) => u.role === 'user')
      .map((u) => ({
        id: u.id,
        nombre: u.nombre,
        email: u.email,
        monto_por_pedido: u.monto_por_pedido || 0,
        pedidos_armados: porUsuario[u.nombre] || 0,
        total: (u.monto_por_pedido || 0) * (porUsuario[u.nombre] || 0),
      }));
  }

  async obtenerPedidosArmadosPorUsuario(nombre, desde, hasta) {
    const query = supabase
      .from('pedidos')
      .select('id, numero_pedido, cliente_nombre, armado_at, notificacion_enviada_at, created_at, despachado_por_nombre')
      .in('estado', ['despachado', 'enviado'])
      .eq('despachado_por_nombre', nombre)
      .order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    const pedidosConFecha = (data || []).map((p) => ({
      ...p,
      fecha_procesado: p.armado_at || p.notificacion_enviada_at || p.created_at || null,
    }));

    const desdeDate = desde ? new Date(`${desde}T00:00:00`) : null;
    const hastaDate = hasta ? new Date(`${hasta}T23:59:59`) : null;

    const pedidosFiltrados = pedidosConFecha.filter((p) => {
      if (!p.fecha_procesado) return false;
      const fecha = new Date(p.fecha_procesado);
      if (desdeDate && fecha < desdeDate) return false;
      if (hastaDate && fecha > hastaDate) return false;
      return true;
    });

    const { data: users } = await supabase
      .from('users')
      .select('monto_por_pedido')
      .eq('nombre', nombre)
      .limit(1);

    const monto = users?.[0]?.monto_por_pedido || 0;
    const pedidos = pedidosFiltrados;
    return {
      pedidos,
      monto_por_pedido: monto,
      total: monto * pedidos.length,
    };
  }

  // ── contact_motivations ─────────────────────────────────────────────────────
  async obtenerMotivaciones() {
    const { data, error } = await supabase
      .from('contact_motivations')
      .select('phone, name, motivation, categoria, stage, summary_hash, analyzed_at')
      .order('analyzed_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async upsertMotivaciones(rows) {
    if (!rows || rows.length === 0) return;
    const { error } = await supabase
      .from('contact_motivations')
      .upsert(rows, { onConflict: 'phone' });
    if (error) throw error;
  }

  // ── Productos ────────────────────────────────────────────────────────────────

  async listarProductos() {
    const { data, error } = await supabase
      .from('productos')
      .select('*')
      .order('nombre', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async crearProducto({ nombre, descripcion = null, sku = null, precio = null, activo = true }) {
    const { data, error } = await supabase
      .from('productos')
      .insert({ nombre, descripcion, sku, precio, activo, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarProducto(id, campos) {
    const { data, error } = await supabase
      .from('productos')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminarProducto(id) {
    const { error } = await supabase.from('productos').delete().eq('id', id);
    if (error) throw error;
  }

  // ── Pedidos admin ────────────────────────────────────────────────────────────

  async buscarPedidosAdmin(q = '') {
    const termino = String(q || '').trim();
    let query = supabase
      .from('pedidos')
      .select('id, numero_pedido, cliente_nombre, cliente_email, cliente_telefono, direccion_envio, localidad, departamento, codigo_postal, estado, tipo_envio, etiqueta_generada, es_reclamo, created_at')
      .order('created_at', { ascending: false })
      .limit(30);

    if (termino) {
      query = query.or(
        `numero_pedido.ilike.%${termino}%,cliente_nombre.ilike.%${termino}%,cliente_email.ilike.%${termino}%,cliente_telefono.ilike.%${termino}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async actualizarPedidoAdmin(id, campos) {
    const camposPermitidos = [
      'cliente_nombre', 'cliente_email', 'cliente_telefono',
      'direccion_envio', 'localidad', 'departamento', 'codigo_postal',
      'estado', 'tipo_envio', 'motivo_reenvio',
    ];
    const update = {};
    for (const k of camposPermitidos) {
      if (k in campos) update[k] = campos[k];
    }
    const { data, error } = await supabase
      .from('pedidos')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ── MarcoPostal: mapeo de localidades_ues ────────────────────────────────────
  async obtenerBarriosMontevideo() {
    const { data, error } = await supabase
      .from('localidades_ues')
      .select('id, nombre, ues_id, marcopostal_id, marcopostal_nombre, marcopostal_cp')
      .eq('departamento_id', 18)
      .order('nombre');
    if (error) throw error;
    return data || [];
  }

  async buscarBarrioMarcoPostalPorNombre(nombre, { codigoPostal = null } = {}) {
    if (!nombre) return null;
    const norm = normalizeText(nombre);

    const { data, error } = await supabase
      .from('localidades_ues')
      .select('id, nombre, marcopostal_id, marcopostal_nombre, marcopostal_cp')
      .eq('departamento_id', 18)
      .not('marcopostal_id', 'is', null);
    if (error) throw error;

    if (!data || data.length === 0) return null;

    let candidates = data.filter((row) => normalizeText(row.nombre) === norm);
    if (candidates.length === 0) {
      candidates = data.filter((row) => normalizeText(row.nombre).includes(norm) || norm.includes(normalizeText(row.nombre)));
    }
    if (candidates.length === 0) return null;

    if (codigoPostal && candidates.length > 1) {
      const cpStr = String(codigoPostal).trim();
      const byCp = candidates.find((row) => String(row.marcopostal_cp || '').trim() === cpStr);
      if (byCp) return byCp;
    }
    return candidates[0];
  }

  async setMarcoPostalParaBarrio(id, mpId, mpNombre, mpCp = null) {
    const { data, error } = await supabase
      .from('localidades_ues')
      .update({
        marcopostal_id: mpId ? String(mpId) : null,
        marcopostal_nombre: mpNombre || null,
        marcopostal_cp: mpCp ? String(mpCp) : null,
        marcopostal_mapped_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async bulkSetMarcoPostal(rows) {
    if (!rows || rows.length === 0) return [];
    const now = new Date().toISOString();
    const results = [];
    for (const r of rows) {
      const { data, error } = await supabase
        .from('localidades_ues')
        .update({
          marcopostal_id: r.marcopostal_id ? String(r.marcopostal_id) : null,
          marcopostal_nombre: r.marcopostal_nombre || null,
          marcopostal_cp: r.marcopostal_cp ? String(r.marcopostal_cp) : null,
          marcopostal_mapped_at: now,
        })
        .eq('id', r.id)
        .select()
        .single();
      if (error) throw error;
      results.push(data);
    }
    return results;
  }

  // ── Color Trends ────────────────────────────────────────────────────────────
  //
  // Reconstruye el cache color_trends_cache leyendo movimientos_stock (tipo='venta')
  // como fuente de verdad (captura tanto ventas sueltas como colores embebidos en kits).
  //
  // Parametros:
  //   desde, hasta: ISO date strings (YYYY-MM-DD). Si ambos son null => full rebuild.
  //   Si solo `desde` esta seteado => recalcula [desde, hoy].
  //
  // Estrategia: borra el rango afectado y reinserta. Idempotente.
  async rebuildColorTrendsCache({ desde = null, hasta = null } = {}) {
    const startedAt = Date.now();

    // 1) Traer productos de categoria color (mapa id->label)
    const { data: productosColor, error: errProd } = await supabase
      .from('productos')
      .select('id, nombre, categoria')
      .ilike('categoria', 'color');
    if (errProd) throw errProd;
    const colorMap = new Map(); // producto_id -> { color_key, color_label }
    for (const p of productosColor || []) {
      const label = (p.nombre || '').trim();
      const key = label.toLowerCase();
      if (!label) continue;
      colorMap.set(p.id, { color_key: key, color_label: label });
    }
    if (colorMap.size === 0) {
      return { ok: true, productosColor: 0, filas: 0, ms: Date.now() - startedAt };
    }

    // 2) Traer movimientos de venta en el rango (paginar para no romper limites)
    const productoIds = Array.from(colorMap.keys());
    let movimientos = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
      let q = supabase
        .from('movimientos_stock')
        .select('producto_id, cantidad, referencia_id, fecha_movimiento')
        .eq('tipo', 'venta')
        .in('producto_id', productoIds)
        .order('fecha_movimiento', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (desde) q = q.gte('fecha_movimiento', desde);
      if (hasta) q = q.lte('fecha_movimiento', hasta + 'T23:59:59');
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      movimientos = movimientos.concat(data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    if (movimientos.length === 0) {
      return { ok: true, productosColor: colorMap.size, filas: 0, ms: Date.now() - startedAt };
    }

    // 3) Para clasificar contexto, necesitamos saber que pedidos tienen items de kit
    //    y cuantos colores distintos hay por pedido.
    const pedidoIds = Array.from(new Set(movimientos.map(m => m.referencia_id).filter(Boolean)));
    const pedidosConKit = new Set();
    if (pedidoIds.length > 0) {
      // Buscar pedido_items cuyos productos sean es_kit=true, agrupado por pedido_id
      // Hacemos chunks chicos: cada UUID son ~37 chars, PostgREST corta arriba de ~16KB de URL.
      const chunkSize = 100;
      for (let i = 0; i < pedidoIds.length; i += chunkSize) {
        const chunk = pedidoIds.slice(i, i + chunkSize);
        const { data: items, error: errItems } = await supabase
          .from('pedido_items')
          .select('pedido_id, producto_id, productos!inner(es_kit)')
          .in('pedido_id', chunk)
          .eq('productos.es_kit', true);
        if (errItems) throw errItems;
        for (const it of items || []) {
          if (it.pedido_id) pedidosConKit.add(it.pedido_id);
        }
      }
    }

    // Contar colores distintos por pedido (con kit) para distinguir kit vs set
    const coloresPorPedido = new Map(); // pedido_id -> Set<producto_id>
    for (const m of movimientos) {
      if (!m.referencia_id) continue;
      if (!coloresPorPedido.has(m.referencia_id)) coloresPorPedido.set(m.referencia_id, new Set());
      coloresPorPedido.get(m.referencia_id).add(m.producto_id);
    }

    // 4) Agregar en memoria: (fecha, producto_id, contexto) -> { unidades, pedidos:Set }
    const agg = new Map();
    const toFecha = (ts) => String(ts || '').slice(0, 10);
    for (const m of movimientos) {
      const fecha = toFecha(m.fecha_movimiento);
      if (!fecha) continue;
      const tieneKit = m.referencia_id ? pedidosConKit.has(m.referencia_id) : false;
      let contexto = 'individual';
      if (tieneKit) {
        const nColores = (coloresPorPedido.get(m.referencia_id) || new Set()).size;
        contexto = nColores >= 2 ? 'set' : 'kit';
      }
      const key = `${fecha}|${m.producto_id}|${contexto}`;
      let row = agg.get(key);
      if (!row) {
        const meta = colorMap.get(m.producto_id);
        row = {
          fecha,
          producto_id: m.producto_id,
          color_key: meta.color_key,
          color_label: meta.color_label,
          contexto,
          unidades: 0,
          pedidosSet: new Set(),
        };
        agg.set(key, row);
      }
      // movimientos_stock.cantidad para ventas viene negativa (egreso). Tomamos abs.
      row.unidades += Math.abs(Number(m.cantidad) || 0);
      if (m.referencia_id) row.pedidosSet.add(m.referencia_id);
    }

    // 5) Borrar rango afectado y reinsertar
    const fechasInsertadas = Array.from(new Set(Array.from(agg.values()).map(r => r.fecha)));
    if (fechasInsertadas.length > 0) {
      let delQ = supabase.from('color_trends_cache').delete();
      if (desde) delQ = delQ.gte('fecha', desde);
      if (hasta) delQ = delQ.lte('fecha', hasta);
      if (!desde && !hasta) delQ = delQ.neq('id', -1); // borrar todo
      const { error: errDel } = await delQ;
      if (errDel) throw errDel;
    }

    const filas = Array.from(agg.values()).map(r => ({
      fecha: r.fecha,
      producto_id: r.producto_id,
      color_key: r.color_key,
      color_label: r.color_label,
      contexto: r.contexto,
      unidades: r.unidades,
      pedidos: r.pedidosSet.size,
    }));

    // Insert en lotes
    const insertBatch = 500;
    for (let i = 0; i < filas.length; i += insertBatch) {
      const batch = filas.slice(i, i + insertBatch);
      const { error: errIns } = await supabase.from('color_trends_cache').insert(batch);
      if (errIns) throw errIns;
    }

    return {
      ok: true,
      productosColor: colorMap.size,
      movimientos: movimientos.length,
      filas: filas.length,
      desde,
      hasta,
      ms: Date.now() - startedAt,
    };
  }

  // Lee el cache y arma payload para el dashboard.
  async obtenerColorTrends({ desde, hasta, contexto = null, granularidad = 'dia' } = {}) {
    if (!desde || !hasta) {
      const now = new Date();
      const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      hasta = hasta || now.toISOString().slice(0, 10);
      desde = desde || d30.toISOString().slice(0, 10);
    }

    let q = supabase
      .from('color_trends_cache')
      .select('fecha, producto_id, color_key, color_label, contexto, unidades, pedidos')
      .gte('fecha', desde)
      .lte('fecha', hasta);
    if (contexto && contexto !== 'todos') q = q.eq('contexto', contexto);
    const { data, error } = await q;
    if (error) throw error;
    const filas = data || [];

    // Dias del rango (inclusive)
    const d0 = new Date(desde + 'T00:00:00');
    const dN = new Date(hasta + 'T00:00:00');
    const diasRango = Math.max(1, Math.round((dN.getTime() - d0.getTime()) / 86400000) + 1);
    const mitadFecha = new Date(d0.getTime() + Math.floor((dN.getTime() - d0.getTime()) / 2))
      .toISOString().slice(0, 10);

    // Ranking agregado por color + serie diaria por color (para metricas de velocidad)
    const ranking = new Map(); // color_key -> { ..., diasSet, unidades1, unidades2, serieDia: Map<fecha, ud> }
    for (const r of filas) {
      let row = ranking.get(r.color_key);
      if (!row) {
        row = {
          color_key: r.color_key,
          color_label: r.color_label,
          producto_id: r.producto_id,
          unidades: 0,
          diasSet: new Set(),
          unidades1: 0, // 1a mitad del rango
          unidades2: 0, // 2a mitad
          serieDia: new Map(), // fecha -> unidades (todos los dias, no solo top colores)
        };
        ranking.set(r.color_key, row);
      }
      const u = r.unidades || 0;
      row.unidades += u;
      if (u > 0) row.diasSet.add(r.fecha);
      if (r.fecha <= mitadFecha) row.unidades1 += u; else row.unidades2 += u;
      row.serieDia.set(r.fecha, (row.serieDia.get(r.fecha) || 0) + u);
    }
    const totalUnidades = Array.from(ranking.values()).reduce((s, r) => s + r.unidades, 0);
    const rankingArr = Array.from(ranking.values())
      .map(r => {
        const diasActivos = r.diasSet.size;
        const velocidad = diasRango > 0 ? r.unidades / diasRango : 0;
        const intensidad = diasActivos > 0 ? r.unidades / diasActivos : 0;
        let tendenciaPct = null;
        if (r.unidades1 > 0) {
          tendenciaPct = ((r.unidades2 - r.unidades1) / r.unidades1) * 100;
        } else if (r.unidades2 > 0) {
          tendenciaPct = null; // arranca de 0, no se puede %
        } else {
          tendenciaPct = 0;
        }
        return {
          color_key: r.color_key,
          color_label: r.color_label,
          producto_id: r.producto_id,
          unidades: r.unidades,
          pct: totalUnidades > 0 ? Number(((r.unidades / totalUnidades) * 100).toFixed(2)) : 0,
          dias_activos: diasActivos,
          dias_rango: diasRango,
          velocidad: Number(velocidad.toFixed(2)),
          intensidad: Number(intensidad.toFixed(2)),
          tendencia_pct: tendenciaPct === null ? null : Number(tendenciaPct.toFixed(1)),
          unidades_1a_mitad: r.unidades1,
          unidades_2a_mitad: r.unidades2,
          serie_dia: Array.from(r.serieDia.entries())
            .map(([fecha, unidades]) => ({ fecha, unidades }))
            .sort((a, b) => a.fecha.localeCompare(b.fecha)),
        };
      })
      .sort((a, b) => b.unidades - a.unidades);

    // Top 5 colores para la serie
    const topColors = rankingArr.slice(0, 5);
    const topKeys = new Set(topColors.map(c => c.color_key));

    // Serie temporal: bucket por granularidad
    const bucketOf = (fechaISO) => {
      const d = new Date(fechaISO + 'T00:00:00');
      if (granularidad === 'mes') return fechaISO.slice(0, 7);
      if (granularidad === 'semana') {
        // ISO week start (lunes)
        const dt = new Date(d);
        const dayOfWeek = (dt.getDay() + 6) % 7;
        dt.setDate(dt.getDate() - dayOfWeek);
        return dt.toISOString().slice(0, 10);
      }
      return fechaISO; // dia
    };

    const serieMap = new Map(); // bucket -> { fecha, [color_key]: unidades }
    for (const r of filas) {
      if (!topKeys.has(r.color_key)) continue;
      const b = bucketOf(r.fecha);
      let row = serieMap.get(b);
      if (!row) { row = { fecha: b }; serieMap.set(b, row); }
      row[r.color_key] = (row[r.color_key] || 0) + (r.unidades || 0);
    }
    const serie = Array.from(serieMap.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));

    // KPIs
    const kpis = {
      totalUnidades,
      colorTop: rankingArr[0] || null,
      coloresUnicos: rankingArr.length,
    };

    // Refrescado mas reciente
    const { data: refData } = await supabase
      .from('color_trends_cache')
      .select('refreshed_at')
      .order('refreshed_at', { ascending: false })
      .limit(1);
    const refreshed_at = refData && refData[0] ? refData[0].refreshed_at : null;

    return {
      rangoFechas: { desde, hasta },
      contexto: contexto || 'todos',
      granularidad,
      kpis,
      ranking: rankingArr,
      topColors,
      serie,
      refreshed_at,
    };
  }

  // Compara dos periodos contiguos del mismo largo y devuelve variacion por color.
  async compararPeriodosColor({ desde, hasta, contexto = null } = {}) {
    if (!desde || !hasta) throw new Error('compararPeriodosColor requiere desde y hasta');
    const d1 = new Date(desde + 'T00:00:00');
    const d2 = new Date(hasta + 'T00:00:00');
    const diasMs = d2.getTime() - d1.getTime();
    const desdeAnterior = new Date(d1.getTime() - diasMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const hastaAnterior = new Date(d1.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [actual, anterior] = await Promise.all([
      this.obtenerColorTrends({ desde, hasta, contexto }),
      this.obtenerColorTrends({ desde: desdeAnterior, hasta: hastaAnterior, contexto }),
    ]);

    const map = new Map();
    for (const r of actual.ranking) {
      map.set(r.color_key, { color_key: r.color_key, color_label: r.color_label, actual: r.unidades, anterior: 0 });
    }
    for (const r of anterior.ranking) {
      let row = map.get(r.color_key);
      if (!row) {
        row = { color_key: r.color_key, color_label: r.color_label, actual: 0, anterior: 0 };
        map.set(r.color_key, row);
      }
      row.anterior = r.unidades;
    }
    const comparativa = Array.from(map.values()).map(r => ({
      ...r,
      variacion_abs: r.actual - r.anterior,
      variacion_pct: r.anterior > 0 ? Number((((r.actual - r.anterior) / r.anterior) * 100).toFixed(2)) : (r.actual > 0 ? null : 0),
    })).sort((a, b) => b.actual - a.actual);

    return {
      periodoActual: { desde, hasta },
      periodoAnterior: { desde: desdeAnterior, hasta: hastaAnterior },
      comparativa,
    };
  }
}

module.exports = new SupabaseService();
