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

  // Obtener todos los pedidos activos (pendientes + con etiqueta, excluye procesados y reclamos)
  async obtenerPedidosActivos() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .neq('estado', 'enviado')
        .neq('es_envio_express', true)
        .neq('es_reclamo', true)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en obtenerPedidosActivos:', error);
      throw error;
    }
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
        // Verificar si ya existe
        const { data: existente } = await supabase
          .from('pedidos')
          .select('id')
          .eq('shopify_order_id', orden.id)
          .single();

        if (existente) {
          // Actualizar
          const { data } = await supabase
            .from('pedidos')
            .update({
              estado: this.mapearEstadoShopify(orden.fulfillment_status),
              total: parseFloat(orden.total_price),
              updated_at: new Date().toISOString()
            })
            .eq('shopify_order_id', orden.id)
            .select();

          resultados.push(data[0]);
        } else {
          // Crear nuevo
          const { data } = await supabase
            .from('pedidos')
            .insert({
              shopify_order_id: orden.id,
              numero_orden: orden.order_number,
              cliente_nombre: `${orden.customer?.first_name || ''} ${orden.customer?.last_name || ''}`.trim(),
              cliente_email: orden.customer?.email || '',
              cliente_telefono: orden.customer?.phone || orden.shipping_address?.phone || '',
              direccion_calle: orden.shipping_address?.address1 || '',
              direccion_ciudad: orden.shipping_address?.city || '',
              direccion_departamento: orden.shipping_address?.province || '',
              direccion_codigo_postal: orden.shipping_address?.zip || '',
              total: parseFloat(orden.total_price),
              estado: 'pendiente',
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
    if (!text) return text;
    try {
      return Buffer.from(text, 'utf8').toString('utf8');
    } catch (e) {
      return text;
    }
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
}

module.exports = new SupabaseService();
