// Detecta pedidos activos que son de la MISMA persona aunque tengan distinto
// número de orden (p.ej. en ML compró un producto suelto y después un carrito
// aparte: son dos ventas, dos números y a veces sólo una tiene envío). El armador
// tiene que armarlos juntos, en un solo paquete y con una sola etiqueta.
//
// Dos pedidos son del mismo cliente si comparten cualquiera de estas claves:
//   - comprador de ML (ml_buyer_id): la única confiable en ML, donde el email y
//     el teléfono vienen vacíos y el nombre es el del destinatario del envío.
//   - email
//   - teléfono (últimos 8 dígitos)
//   - nombre + dirección normalizados
// Las claves se encadenan (union-find): A~B por email y B~C por teléfono
// dejan a los tres en el mismo grupo.

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clavesCliente(pedido) {
  const claves = [];
  if (pedido.ml_buyer_id) claves.push(`ml:${pedido.ml_buyer_id}`);

  const email = String(pedido.cliente_email || '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) claves.push(`mail:${email}`);

  const digitos = String(pedido.cliente_telefono || '').replace(/\D/g, '');
  if (digitos.length >= 8) claves.push(`tel:${digitos.slice(-8)}`);

  const nombre = normalizar(pedido.cliente_nombre);
  const direccion = normalizar(pedido.direccion_envio);
  if (nombre && direccion) claves.push(`dir:${nombre}|${direccion}`);

  return claves;
}

// Devuelve los pedidos con `grupo_cliente` (id estable del grupo) y
// `grupo_cliente_numeros` (los números de las OTRAS órdenes del grupo) en los
// que comparten cliente con al menos otro pedido de la lista. El resto vuelve
// sin esos campos.
function asignarGruposCliente(pedidos) {
  const lista = Array.isArray(pedidos) ? pedidos : [];
  const padre = lista.map((_, i) => i);
  const raiz = (i) => {
    while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; }
    return i;
  };

  const primeroPorClave = new Map();
  lista.forEach((p, i) => {
    for (const clave of clavesCliente(p)) {
      if (!primeroPorClave.has(clave)) { primeroPorClave.set(clave, i); continue; }
      const a = raiz(primeroPorClave.get(clave));
      const b = raiz(i);
      if (a !== b) padre[b] = a;
    }
  });

  const miembros = new Map();
  lista.forEach((_, i) => {
    const r = raiz(i);
    if (!miembros.has(r)) miembros.set(r, []);
    miembros.get(r).push(i);
  });

  return lista.map((p, i) => {
    const grupo = miembros.get(raiz(i));
    if (grupo.length < 2) return p;
    // Id del grupo: el menor id de sus pedidos, igual para todos los miembros.
    const ids = grupo.map((j) => String(lista[j].id)).sort();
    return {
      ...p,
      grupo_cliente: ids[0],
      grupo_cliente_numeros: grupo.filter((j) => j !== i).map((j) => lista[j].numero_pedido),
    };
  });
}

module.exports = { asignarGruposCliente, clavesCliente };
