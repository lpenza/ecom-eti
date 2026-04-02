const { parseAddress } = require('./services/direccionParserService');

const tests = [
  {
    name: 'Dirección simple con número y apto',
    input: 'Tristan narvaja 1513 apto 711',
    expected: {
      calle: 'Tristan narvaja',
      numeroPuerta: '1513',
      apartamento: '711',
    }
  },
  {
    name: 'Dirección corta con número y apto',
    input: 'Yaro 907 Apto 406',
    expected: {
      calle: 'Yaro',
      numeroPuerta: '907',
      apartamento: '406',
    }
  },
  {
    name: 'Con paréntesis y texto descriptivo',
    input: 'Milton Stellardo casi ruta 11 Casa ( toda de piedra, 2 pisos con rejas grises) Piso S',
    expected: {
      calle: 'Milton Stellardo casi ruta 11 Piso S',
      observaciones: 'Casa, toda de piedra, 2 pisos con rejas grises',
    }
  },
  {
    name: 'Con Manzana y Solar formato largo',
    input: 'Pablo Estramin manzana 525 solar 17',
    expected: {
      calle: 'Pablo Estramin',
      observaciones: /Manzana 525 Solar 17/i,
    }
  },
  {
    name: 'Con M y S formato corto (solo números)',
    input: 'Calle Principal M 10 S 5',
    expected: {
      calle: 'Calle Principal',
      observaciones: /Manzana 10 Solar 5/i,
    }
  },
  {
    name: 'Piso con número',
    input: 'Calle 123 Piso 2',
    expected: {
      calle: 'Calle',
      numeroPuerta: '123',
      apartamento: 'Piso 2',
    }
  },
  {
    name: '8 de Octubre (fecha como calle)',
    input: '8 de Octubre 1234',
    expected: {
      calle: '8 de Octubre',
      numeroPuerta: '1234',
    }
  },
  {
    name: 'Con esquina',
    input: '8 de Octubre esq Rivera 1234',
    expected: {
      calle: '8 de Octubre',
      esquina: 'Rivera',
      numeroPuerta: '1234',
    }
  },
  {
    name: 'Ruta con km y local',
    input: 'Giannatasio km 23.500 Local Avicola Piolin',
    expected: {
      calle: 'Giannatasio',
      observaciones: /Km 23\.500/i,
    }
  },
];

console.log('🧪 Ejecutando tests del parser de direcciones\n');

let passed = 0;
let failed = 0;

tests.forEach((test, index) => {
  const result = parseAddress(test.input);
  let testPassed = true;
  const errors = [];

  Object.keys(test.expected).forEach(key => {
    const expected = test.expected[key];
    const actual = result[key];

    if (expected instanceof RegExp) {
      if (!expected.test(actual || '')) {
        testPassed = false;
        errors.push(`  ❌ ${key}: esperaba que matcheara ${expected}, obtuvo "${actual}"`);
      }
    } else if (expected !== undefined && actual !== expected) {
      testPassed = false;
      errors.push(`  ❌ ${key}: esperaba "${expected}", obtuvo "${actual}"`);
    }
  });

  if (testPassed) {
    console.log(`✅ Test ${index + 1}: ${test.name}`);
    passed++;
  } else {
    console.log(`❌ Test ${index + 1}: ${test.name}`);
    console.log(`  Input: "${test.input}"`);
    errors.forEach(err => console.log(err));
    console.log(`  Resultado completo:`, JSON.stringify(result, null, 2));
    failed++;
  }
});

console.log(`\n📊 Resultados: ${passed} pasados, ${failed} fallidos de ${tests.length} tests`);
process.exit(failed > 0 ? 1 : 0);
