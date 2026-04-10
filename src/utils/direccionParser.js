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

export function parseAddress(fullAddress) {
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

  let m = address.match(/\s+(\d{2,5})\s*\/\s*(\d{2,5})\s+\2\s*$/i);
  if (m) {
    result.numeroPuerta = m[1];
    result.apartamento = m[2];
    address = address.slice(0, m.index).trim();
  }

  m = address.match(/\s+(\d{3,5})\s+(\d{2,4})\s+\2\s*$/i);
  if (m) {
    result.numeroPuerta = result.numeroPuerta || m[1];
    result.apartamento = result.apartamento || m[2];
    address = address.slice(0, m.index).trim();
  }

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

  if (!result.apartamento) {
    m = address.match(/\b(?:oficina\s*([A-Z0-9\-]+)|of\.?\s*(\d+[A-Z]?))\b/i);
    if (m) {
      result.apartamento = `Oficina ${getFirstNonEmpty(m, [1, 2]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.apartamento) {
    m = address.match(/\b(?:piso\s*([A-Z0-9\-]+)|p\.?\s*(\d+[A-Z]?))\b/i);
    if (m) {
      result.apartamento = `Piso ${getFirstNonEmpty(m, [1, 2]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.apartamento) {
    m = address.match(/\b(?:apartamento\s*([A-Z0-9\-]+)|apto\.?\s*([A-Z0-9\-]+)|apt\.?\s*([A-Z0-9\-]+)|ap\.?\s*(\d+[A-Z]?))\b/i);
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

  if (!result.apartamento) {
    m = address.match(/\b(?:manzana|mz\.?)\s*([A-Z0-9\-]+)\s+(?:solar|sol\.?)\s*([A-Z0-9\-]+)\b/i);
    if (m) {
      result.apartamento = `Manzana ${String(m[1]).toUpperCase()} Solar ${String(m[2]).toUpperCase()}`;
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.apartamento || !result.numeroPuerta) {
    m = address.match(/^(.*?)\s+(\d{3,5})\s+([A-Z]?\d{1,4}[A-Z]?)(?:\s+(.*))?$/i);
    if (m) {
      const left = cleanText(m[1]);
      const door = m[2];
      const apt = String(m[3]).toUpperCase();
      const trailing = cleanText(m[4] || '');
      const aptNum = Number.parseInt((apt.match(/\d+/) || [''])[0], 10);
      const doorNum = Number.parseInt(door, 10);

      if (!Number.isNaN(doorNum) && !Number.isNaN(aptNum) && aptNum < doorNum) {
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

      if (!Number.isNaN(doorNum) && !Number.isNaN(aptNum) && aptNum < doorNum) {
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

  const towerMatches = [...address.matchAll(/\b(?:torre|bloque|block)\b\s*([A-Z0-9\-]+)\b/gi)];
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

  m = address.match(/\b(?:esq\.?|esquina)\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i);
  if (m) {
    result.esquina = restoreDateTokens(cleanText(m[1]));
    address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  }

  const additionalPatterns = [
    { regex: /\bbarrio\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Barrio ' },
    { regex: /\bcomplejo\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Complejo ' },
    { regex: /\bedificio\s+([^,\d]+?)(?=\s+\d|\s*$|,)/i, prefix: 'Edificio ' },
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

  if (!result.numeroPuerta) {
    m = address.match(/^(.+?)\s+(\d{3,5})\//i);
    if (m) {
      result.numeroPuerta = m[2];
      address = cleanText(m[1]);
    }
  }

  if (!result.numeroPuerta) {
    m = address.match(/(?<!\p{L})(?:n(?:ro|r|numero)?\.?|n[º°]|#)(?!\p{L})\s*(\d+)\b/iu);
    if (m) {
      result.numeroPuerta = m[1];
      address = address.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!result.numeroPuerta) {
    m = address.match(/\bkm\.?\s*(\d+(?:[.,]\d+)?)\b/i);
    if (m) {
      result.numeroPuerta = `Km ${String(m[1]).replace(',', '.')}`;
    }
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
          /^(Av|Avenida|Ruta|Camino|Calle|Callejon)\b/i.test(left);

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

  address = (address || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+(pasando|continuacion|metros)\s*$/i, '')
    .replace(/[,.\s/]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

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
