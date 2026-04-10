const axios = require('axios');
require('dotenv').config();

class GoogleMapsService {
  constructor(apiKey) {
    this._apiKey = apiKey;
  }

  async geocodeAsync(direccion, ciudad = 'Montevideo', pais = 'Uruguay') {
    try {
      const direccionCompleta = `${direccion}, ${ciudad}, ${pais}`;
      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address: direccionCompleta,
          key: this._apiKey,
          language: 'es',
          region: 'uy',
        },
      });

      const data = response.data;
      if (data?.status === 'OK' && data.results?.length > 0) {
        return this._parsearResultado(data.results[0]);
      }

      console.warn(`⚠️  Geocoding sin resultados (${data?.status}): ${direccionCompleta}`);
      return { exitoso: false };
    } catch (error) {
      console.error(`❌ Error en geocoding: ${error.message}`);
      return { exitoso: false };
    }
  }

  async reverseGeocodeAsync(latitud, longitud) {
    if (latitud == null || longitud == null) {
      return { exitoso: false };
    }
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          latlng: `${latitud},${longitud}`,
          key: this._apiKey,
          language: 'es',
          region: 'uy',
        },
      });

      const data = response.data;
      if (data?.status === 'OK' && data.results?.length > 0) {
        // Priorizar resultado que tenga barrio (neighborhood o sublocality_level_1)
        const conBarrio = data.results.find((r) =>
          r.address_components?.some((c) =>
            c.types?.includes('neighborhood') ||
            c.types?.includes('sublocality_level_1') ||
            c.types?.includes('sublocality')
          )
        );
        return this._parsearResultado(conBarrio ?? data.results[0]);
      }

      console.warn(`⚠️  Reverse Geocoding sin resultados (${data?.status}): ${latitud},${longitud}`);
      return { exitoso: false };
    } catch (error) {
      console.error(`❌ Error en reverse geocoding: ${error.message}`);
      return { exitoso: false };
    }
  }

  _parsearResultado(result) {
    const components = result.address_components ?? [];

    console.log('🗺️  [GoogleMaps] address_components:', components.map((c) => `${c.long_name} [${c.types.join(', ')}]`));

    const get = (...types) => {
      for (const type of types) {
        const comp = components.find((c) => c.types?.includes(type));
        if (comp) return comp.long_name;
      }
      return null;
    };

    return {
      exitoso: true,
      direccionFormateada: result.formatted_address ?? null,
      calle: get('route'),
      numeroPuerta: get('street_number'),
      barrio: get('neighborhood', 'sublocality_level_1', 'sublocality'),
      localidad: get('locality'),
      departamento: get('administrative_area_level_1'),
      codigoPostal: get('postal_code'),
      latitud: result.geometry?.location?.lat ?? null,
      longitud: result.geometry?.location?.lng ?? null,
    };
  }
}

module.exports = new GoogleMapsService(process.env.GOOGLE_MAPS_API_KEY);
