const MONTHS_REGEX = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.;\-/\s]+|[,.;\-/\s]+$/g, '')
    .trim();
}

function addObservation(observations, text) {
  const normalized = cleanText(text);
  if (normalized) {
    observations.push(normalized);
  }
}

function restoreDateTokens(text) {
  if (!text) return text || '';
  return text.replace(/__FD_(.*?)__/g, (_, token) => token.replace(/_/g, ' '));
}

function protectDateStreetNames(text) {
  if (!text) return text || '';
  return text.replace(
    new RegExp(`\\b(\\d{1,2}(?:[°º])?)\\s+de\\s+(${MONTHS_REGEX})\\b`, 'gi'),
    (m) => `__FD_${m.replace(/\s/g, '_')}__`
  );
}

function isStreetDateNumber(number, afterText) {
  if (!number || !afterText) return false;
  const n = Number.parseInt(number, 10);
  if (Number.isNaN(n) || n < 1 || n > 31) return false;
  return new RegExp(`^de\\s+(${MONTHS_REGEX})\\b`, 'i').test(afterText.trimStart());
}

function preCleanAddress(address, observations) {
  let result = address;
  const replacements = [
    { key: 'Casa', value: 'Casa' },
    { key: 'Mdeo', value: null },
    { key: 'MVD', value: null },
  ];

  for (const { key, value } of replacements) {
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(result)) {
      if (value) {
        observations.push(value);
      }
      result = result.replace(regex, ' ');
    }
  }

  return result.replace(/\s+/g, ' ').trim();
}

function getFirstNonEmpty(match, indexes) {
  for (const idx of indexes) {
    const value = match[idx] || '';
    if (value.trim()) return value;
  }
  return '';
}

function dedupeObservations(observations) {
  const unique = [];
  const seen = new Set();

  for (const obs of observations) {
    const normalized = restoreDateTokens(cleanText(obs));
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(normalized);
    }
  }

  return unique;
}

function parseAddress(fullAddress) {
  if (!fullAddress || !String(fullAddress).trim()) {
    return {
      calle: '',
      numeroPuerta: '',
      apartamento: '',
      bloque: '',
      esquina: '',
      observaciones: '',
    };
  }

  const result = {
    calle: '',
    numeroPuerta: '',
    apartamento: '',
    bloque: '',
    esquina: '',
    observaciones: '',
  };

  const observations = [];
  let address = String(fullAddress)
    .replace(/\r\n|\n|\r|\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  address = preCleanAddress(address, observations);
  address = protectDateStreetNames(address);

  // Extraer texto entre paréntesis a observaciones (PRIMERO, antes de cualquier otro patrón)
  const parenthesisMatches = [...address.matchAll(/\(([^)]+)\)/g)];
  for (const pm of parenthesisMatches) {
    addObservation(observations, pm[1].trim());
    address = address.replace(pm[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // Formato: Calle 123/45 45
  let m = address.match(/\s+(\d{2,5})\s*\/\s*(\d{2,5})\s+\2\s*$/i);
  if (m) {
    result.numeroPuerta = m[1];
    result.apartamento = m[2];
    address = address.slice(0, m.index).trim();
  }

  // Formato: Calle 1234 56 56
  m = address.match(/\s+(\d{3,5})\s+(\d{2,4})\s+\2\s*$/i);
  if (m) {
    result.numeroPuerta = result.numeroPuerta || m[1];
    result.apartamento = result.apartamento || m[2];
    address = address.slice(0, m.index).trim();
  }

  // Números pegados tipo: x123,45
  m = address.match(/([a-záéíóúñ])(\d{2,5}),(\d{2,5})/i);
  if (m) {
    const a = Number.parseInt(m[2], 10);
    const b = Number.parseInt(m[3], 10);
    if (b > a) {
      result.numeroPuerta = String(b);
      result.apartamento = String(a);
    } else {
      result.numeroPuerta = String(a);
      result.apartamento = String(b);
    }
    address = address.slice(0, m.index + 1).trim();
  }

  // Número pegado sin coma tipo: x1234
  m = address.match(/([a-záéíóúñ])(\d{3,5})(?=\s|$)/i);
  if (m) {
    address = `${address.slice(0, m.index + 1)} ${m[2]}${address.slice(m.index + m[0].length)}`
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!result.numeroPuerta) {
    m = address.match(/\s(\d{3,5})\s+\1\s*$/);
    if (m) {
      result.numeroPuerta = m[1];
      address = address.slice(0, m.index).trim();
    }
  }

  // Oficina / Piso / Apto / Vivienda / Manzana+Solar (patrones conservadores)
  if (!result.apartamento) {
    m = address.match(/\b(?:oficina\s*([A-Z0-9\-]{2,})|of\.?\s*(\d+[A-Z]?))\b/i);
    if (m) {
      result.apartamento = `Oficina ${getFirstNonEmpty(m, [1, 2]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.apartamento) {
    // Piso: requiere al menos 2 caracteres O un número claro (no una sola letra)
    m = address.match(/\b(?:piso\s*(\d+[A-Z]?|[A-Z0-9]{2,})|p\.?\s*(\d+))\b/i);
    if (m) {
      result.apartamento = `Piso ${getFirstNonEmpty(m, [1, 2]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Patrón específico: "Calle 1234 apto 56" o "Calle 1234 apartamento 56"
  if (!result.apartamento && !result.numeroPuerta) {
    m = address.match(/^(.+?)\s+(\d{3,5})\s+(?:apto\.?|apartamento|apt\.?|ap\.?)\s+([A-Z0-9\-]{1,})\b/i);
    if (m) {
      const left = cleanText(m[1]);
      const door = m[2];
      const apt = String(m[3]).toUpperCase();
      
      result.numeroPuerta = door;
      result.apartamento = apt;
      address = left;
    }
  }

  if (!result.apartamento) {
    // Apartamento: requiere al menos 2 caracteres O formato número+letra
    m = address.match(/\b(?:apartamento\s*([A-Z0-9\-]{2,})|apto\.?\s*([A-Z0-9\-]{2,}|[0-9]+[A-Z]?)|apt\.?\s*([A-Z0-9\-]{2,})|ap\.?\s*(\d+[A-Z]?))\b/i);
    if (m) {
      result.apartamento = getFirstNonEmpty(m, [1, 2, 3, 4]).toUpperCase();
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.apartamento) {
    m = address.match(/(?:\b(?:vivienda|unidad)\b|\b(?:viv|uni)\.?)\s+([A-Z0-9\-]+)\b/i);
    if (m) {
      result.apartamento = `Vivienda ${String(m[1]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Manzana + Solar: detectar y mover a observaciones (formato largo)
  m = address.match(/\b(?:manzana|mz\.?)\s*([A-Z0-9\-]+)\s+(?:solar|sol\.?)\s*([A-Z0-9\-]+)\b/i);
  if (m) {
    addObservation(observations, `Manzana ${String(m[1]).toUpperCase()} Solar ${String(m[2]).toUpperCase()}`);
    address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // Manzana + Solar formato corto: "M 123 S 45" (solo si M y S están seguidas de números)
  m = address.match(/\bM\s+(\d+[A-Z0-9]*)\s+S\s+(\d+[A-Z0-9]*)\b/i);
  if (m) {
    addObservation(observations, `Manzana ${String(m[1]).toUpperCase()} Solar ${String(m[2]).toUpperCase()}`);
    address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // Calle 1234 12A + resto
  if (!result.apartamento || !result.numeroPuerta) {
    m = address.match(/^(.*?)\s+(\d{3,5})\s+([A-Z]?\d{1,4}[A-Z]?)(?:\s+(.*))?$/i);
    if (m) {
      const left = cleanText(m[1]);
      const door = m[2];
      const apt = String(m[3]).toUpperCase();
      const trailing = cleanText(m[4] || '');
      const aptNum = Number.parseInt((apt.match(/\d+/) || [''])[0], 10);
      const doorNum = Number.parseInt(door, 10);

      if (!Number.isNaN(doorNum) && !Number.isNaN(aptNum) && aptNum < 1000 && aptNum < doorNum) {
        if (!result.numeroPuerta) result.numeroPuerta = door;
        if (!result.apartamento) result.apartamento = apt;
        address = left;
        if (trailing) addObservation(observations, trailing);
      }
    }
  }

  if (!result.apartamento || !result.numeroPuerta) {
    m = address.match(/\s(\d{3,5})\s([A-Z]?\d{1,4}[A-Z]?)\s*$/i);
    if (m) {
      const door = m[1];
      const apt = String(m[2]).toUpperCase();
      const aptNum = Number.parseInt((apt.match(/\d+/) || [''])[0], 10);
      const doorNum = Number.parseInt(door, 10);

      if (!Number.isNaN(doorNum) && !Number.isNaN(aptNum) && aptNum < 1000 && aptNum < doorNum) {
        if (!result.numeroPuerta) result.numeroPuerta = door;
        if (!result.apartamento) result.apartamento = apt;
        address = address.slice(0, m.index).trim();
      }
    }
  }

  if (!result.apartamento) {
    m = address.match(/\b[Ll](\d+)\b/);
    if (m) {
      result.apartamento = m[1];
      addObservation(observations, `Lote ${result.apartamento}`);
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Torre / Bloque
  const towerMatches = [...address.matchAll(/\b(?:torre|bloque|block)\s*([A-Z0-9\-]+)\b/gi)];
  for (const mt of towerMatches) {
    const before = address.slice(0, mt.index);
    if (/\b(de|del|la|las|el|los)\s*$/i.test(before)) {
      continue;
    }
    result.bloque = String(mt[1]).toUpperCase();
    addObservation(observations, `Torre/Bloque ${result.bloque}`);
    address = `${address.slice(0, mt.index)} ${address.slice(mt.index + mt[0].length)}`.replace(/\s+/g, ' ').trim();
    break;
  }

  // Esquina (solo "esq" y "esquina" - patrones establecidos)
  m = address.match(/\b(?:esq\.?|esquina)\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i);
  if (m) {
    result.esquina = restoreDateTokens(cleanText(m[1]));
    address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // Info adicional
  const additionalPatterns = [
    { regex: /\bbarrio\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Barrio ' },
    { regex: /\bcomplejo\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Complejo ' },
    { regex: /\bedificio\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Edificio ' },
    { regex: /\blocal\s+([^,]+?)(?=\s*$|,)/i, prefix: 'Local ' },
    { regex: /\bcasa\s+de\s+([^,]+?)(?=\s*$|,)/i, prefix: 'Casa de ' },
    { regex: /\bcooperativa\s+(.+?)(?=\s+(?:vivienda|viv\.?|unidad|uni\.?|esq\.?|esquina)\b|$|,)/i, prefix: 'Cooperativa ' },
  ];

  for (const p of additionalPatterns) {
    m = address.match(p.regex);
    if (m) {
      const val = cleanText(m[1]);
      if (val) addObservation(observations, `${p.prefix}${val}`);
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Número de puerta final
  if (!result.numeroPuerta) {
    m = address.match(/^(.+?)\s+(\d{3,5})\//i);
    if (m) {
      result.numeroPuerta = m[2];
      address = cleanText(m[1]);
    }
  }

  if (!result.numeroPuerta) {
    m = address.match(/(?<!\p{L})(?:n(?:ro|r|úmero)?\.?|n[º°]|#)(?!\p{L})\s*(\d+)\b/iu);
    if (m) {
      result.numeroPuerta = m[1];
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Kilómetro: detectar y mover a observaciones (no es número de puerta)
  m = address.match(/\bk(?:m|ilómetro)\.?\s*(\d+(?:[.,]\d+)?)\b/i);
  if (m) {
    addObservation(observations, `Km ${String(m[1]).replace(',', '.')}`);
    address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }

  if (!result.numeroPuerta && !result.apartamento) {
    m = address.match(/\s(\d{3,5})\s*$/);
    if (m) {
      result.numeroPuerta = m[1];
      address = address.replace(/\s(\d{3,5})\s*$/, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.numeroPuerta) {
    m = address.match(/^(.+?)\s(\d{1,5})(?:\s+(.*))?$/i);
    if (m) {
      const left = cleanText(m[1]);
      const door = m[2];
      const after = cleanText(m[3] || '');
      const tokens = left.split(/\s+/).filter(Boolean);

      if (!isStreetDateNumber(door, after)) {
        const isStreetLike =
          tokens.length >= 2 ||
          /^(Av|Avenida|Ruta|Camino|Calle|Callejón|Callejon)\b/i.test(left);

        if (isStreetLike) {
          const doorNum = Number.parseInt(door, 10);
          if (!(doorNum < 100)) {
            result.numeroPuerta = door;
            address = left;
            if (after) addObservation(observations, after);
          }
        }
      }
    }
  }

  // Limpieza final y extracción de calle
  address = (address || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+(pasando|continuacion|continuación|metros)\s*$/i, '')
    .replace(/[,.\s/]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Lo que queda es la calle (ya se extrajeron apartamentos, paréntesis, esquinas, etc.)
  result.calle = restoreDateTokens(address);
  
  if (result.esquina) {
    result.esquina = restoreDateTokens(result.esquina);
  }

  const uniqueObs = dedupeObservations(observations);
  if (uniqueObs.length > 0) {
    result.observaciones = uniqueObs.join(', ');
  }

  return result;
}

module.exports = {
  parseAddress,
};
