// Grupos de sinónimos para la búsqueda inteligente de la Guía de Atención.
//
// Cada grupo es una lista de palabras/frases que un agente podría escribir para
// referirse a la misma idea. La búsqueda expande cada palabra de lo que se
// escribe en el buscador a su grupo, así "color mal" encuentra situaciones
// etiquetadas como "color incorrecto" o "no coincide con la web" aunque la
// palabra "mal" no aparezca ahí literalmente.
//
// Para agregar un caso nuevo: sumá la palabra/frase al grupo que corresponda
// (o creá un grupo nuevo si no encaja en ninguno). No hace falta tocar nada
// más — el buscador y las tags de atencionFaq.js ya lo usan automáticamente.

export const gruposSinonimos = [
  // Algo está mal / equivocado / no es lo que se pidió
  ['mal', 'malo', 'mala', 'incorrecto', 'incorrecta', 'erroneo', 'erronea', 'equivocado', 'equivocada', 'equivocaron', 'distinto', 'diferente', 'no coincide', 'no es', 'no era', 'confundieron', 'confusion', 'error'],
  // Producto roto / que no funciona
  ['roto', 'rota', 'daniado', 'daniada', 'defectuoso', 'defectuosa', 'falla', 'fallado', 'fallada', 'fallo', 'anda mal', 'no funciona', 'no anda', 'no prende', 'no enciende', 'no carga'],
  // Demora / no llega
  ['tarda', 'tarde', 'demora', 'demorado', 'demorada', 'atrasado', 'atrasada', 'atraso', 'retraso', 'no llega', 'no llego', 'todavia no llega', 'sigue sin llegar', 'no aparece'],
  // Cambio / devolución / reembolso
  ['cambio', 'cambiar', 'devolucion', 'devolver', 'reembolso', 'reintegro', 'plata de vuelta', 'me devuelvan', 'quiero la plata'],
  // Cancelar
  ['cancelar', 'anular', 'anulacion', 'cancelacion', 'baja del pedido'],
  // Reclamo / enojo
  ['reclamo', 'reclama', 'reclamando', 'queja', 'enojada', 'enojado', 'molesta', 'molesto', 'furiosa', 'furioso', 'indignada', 'indignado'],
  // Perdido / extraviado
  ['perdido', 'perdida', 'extraviado', 'extraviada', 'se perdio', 'nunca llego', 'desaparecio'],
  // Falta algo / incompleto
  ['falta', 'faltante', 'incompleto', 'incompleta', 'no vino', 'no venia', 'no trajo'],
  // Precio / costo
  ['precio', 'costo', 'vale', 'sale', 'cuanto sale', 'cuanto cuesta', 'cuanto vale', 'valor'],
  // Descuento / cupón / promo
  ['descuento', 'cupon', 'promo', 'promocion', 'oferta', 'rebaja'],
  // Pago
  ['pago', 'pagar', 'abonar', 'abono', 'transferencia', 'tarjeta', 'cobro'],
  // Stock / disponibilidad
  ['stock', 'disponibilidad', 'hay', 'queda', 'quedan', 'agotado', 'agotada', 'sin stock'],
  // Alergia / reacción en la piel
  ['alergia', 'alergica', 'alergico', 'reaccion', 'irritacion', 'picazon', 'brote'],
  // Duración / despegue
  ['dura', 'duracion', 'aguanta', 'se despega', 'se despego', 'despegado', 'despegada', 'se cae', 'se levanto'],
  // Retirar / pickup
  ['retirar', 'retiro', 'buscar el pedido', 'pasar a buscar'],
  // Horario
  ['horario', 'horarios', 'que hora', 'a que hora', 'franja horaria'],
  // Dirección / entrega
  ['direccion', 'domicilio', 'donde entregan', 'donde llega'],
];

// Normaliza texto: minúsculas y sin acentos, para comparar de forma consistente.
export function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Grupos ya normalizados, calculados una sola vez.
const gruposNormalizados = gruposSinonimos.map((grupo) => grupo.map(normalizarTexto));

// Dado un token (palabra o frase corta) de búsqueda, devuelve todas las formas
// equivalentes a probar contra el contenido: el token tal cual, más cualquier
// término de los grupos de sinónimos a los que pertenezca.
export function expandirToken(tokenNormalizado) {
  const equivalentes = new Set([tokenNormalizado]);
  for (const grupo of gruposNormalizados) {
    if (grupo.includes(tokenNormalizado)) {
      grupo.forEach((t) => equivalentes.add(t));
    }
  }
  return Array.from(equivalentes);
}
