const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

class SupabaseService {
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

    const { data, error } = await supabase
      .from('localidades_ues')
      .select('departamento_id')
      .not('departamento_id', 'is', null)
      .order('departamento_id', { ascending: true });

    if (error) throw error;

    const uniqueIds = [...new Set((data || []).map((r) => String(r.departamento_id)))];

    return uniqueIds.map((id) => ({
      id,
      nombre: `Departamento ${id}`,
    }));
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

    let query = supabase
      .from('localidades_ues')
      .select('ues_id, nombre, departamento_id')
      .not('ues_id', 'is', null)
      .order('nombre', { ascending: true });

    if (departamentoId) {
      query = query.eq('departamento_id', departamentoId);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data || []).map((row) => ({
      id: String(row.ues_id),
      nombre: row.nombre,
      departamento_id: String(row.departamento_id),
    }));
  }

  // Buscar localidad UES por nombre para obtener IDs requeridos por dispatcher.
  async buscarLocalidadUes(localidad, departamento) {
    if (!localidad) {
      throw new Error('Localidad no informada en el pedido');
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
      throw new Error(`No se encontró localidad UES para: ${normalizedLocalidad}${departamento ? ` (${departamento})` : ''}`);
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

  // Obtener todos los pedidos activos (pendientes + con etiqueta, excluye procesados)
  async obtenerPedidosActivos() {
    try {
      const { data, error } = await supabase
        .from('pedidos')
        .select('*')
        .neq('estado', 'enviado')
        .neq('es_envio_express', true)
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
          
          resultados.push(data[0]);
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
}

module.exports = new SupabaseService();
