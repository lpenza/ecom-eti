const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

class LogService {
  constructor() {
    this.rutaLogs = process.env.RUTA_LOGS || 'C:\\VELINNE\\Logs';
    this.inicializar();
  }

  async inicializar() {
    try {
      await fs.mkdir(this.rutaLogs, { recursive: true });
    } catch (error) {
      console.error('Error creando directorio de logs:', error);
    }
  }

  async escribirLog(nivel, mensaje, datos = null) {
    try {
      const timestamp = new Date().toISOString();
      const fecha = new Date().toISOString().split('T')[0];
      const nombreArchivo = `velinne_${fecha}.log`;
      const rutaArchivo = path.join(this.rutaLogs, nombreArchivo);

      let logEntry = `[${timestamp}] [${nivel.toUpperCase()}] ${mensaje}`;
      
      if (datos) {
        if (datos instanceof Error) {
          logEntry += `\nError: ${datos.message}\nStack: ${datos.stack}`;
        } else {
          logEntry += `\nDatos: ${JSON.stringify(datos, null, 2)}`;
        }
      }
      
      logEntry += '\n';

      await fs.appendFile(rutaArchivo, logEntry);
      
      // También mostrar en consola
      const colorMap = {
        info: '\x1b[36m',    // Cyan
        error: '\x1b[31m',   // Rojo
        warning: '\x1b[33m', // Amarillo
        success: '\x1b[32m'  // Verde
      };
      
      const reset = '\x1b[0m';
      const color = colorMap[nivel] || '';
      
      console.log(`${color}${logEntry.trim()}${reset}`);
    } catch (error) {
      console.error('Error escribiendo log:', error);
    }
  }

  info(mensaje, datos = null) {
    return this.escribirLog('info', mensaje, datos);
  }

  error(mensaje, datos = null) {
    return this.escribirLog('error', mensaje, datos);
  }

  warning(mensaje, datos = null) {
    return this.escribirLog('warning', mensaje, datos);
  }

  success(mensaje, datos = null) {
    return this.escribirLog('success', mensaje, datos);
  }

  async obtenerLogs(fecha = null) {
    try {
      const fechaBuscar = fecha || new Date().toISOString().split('T')[0];
      const nombreArchivo = `velinne_${fechaBuscar}.log`;
      const rutaArchivo = path.join(this.rutaLogs, nombreArchivo);

      try {
        const contenido = await fs.readFile(rutaArchivo, 'utf-8');
        return contenido.split('\n').filter(linea => linea.trim());
      } catch {
        return [];
      }
    } catch (error) {
      console.error('Error leyendo logs:', error);
      return [];
    }
  }

  async limpiarLogsAntiguos(diasAMantener = 30) {
    try {
      const archivos = await fs.readdir(this.rutaLogs);
      const ahora = Date.now();
      const milisegundosPorDia = 24 * 60 * 60 * 1000;

      for (const archivo of archivos) {
        if (!archivo.endsWith('.log')) continue;

        const rutaArchivo = path.join(this.rutaLogs, archivo);
        const stats = await fs.stat(rutaArchivo);
        const edad = (ahora - stats.mtimeMs) / milisegundosPorDia;

        if (edad > diasAMantener) {
          await fs.unlink(rutaArchivo);
          console.log(`Log antiguo eliminado: ${archivo}`);
        }
      }
    } catch (error) {
      console.error('Error limpiando logs antiguos:', error);
    }
  }
}

module.exports = new LogService();
