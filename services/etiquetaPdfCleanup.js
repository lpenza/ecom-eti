const path = require('path');
const fs = require('fs').promises;
const logService = require('./logService');

const DIR = path.join(__dirname, '..', 'public', 'etiquetas-marcopostal');
const DEFAULT_RETENTION_DAYS = parseInt(process.env.MARCO_POSTAL_PDF_RETENTION_DAYS || '7', 10);
const DAILY_MS = 24 * 60 * 60 * 1000;

async function cleanup({ olderThanDays = DEFAULT_RETENTION_DAYS } = {}) {
  const cutoff = Date.now() - olderThanDays * DAILY_MS;
  let scanned = 0;
  let deleted = 0;
  const errors = [];

  try {
    await fs.mkdir(DIR, { recursive: true });
    const files = await fs.readdir(DIR);

    for (const file of files) {
      if (!file.endsWith('.pdf')) continue;
      scanned += 1;
      const fp = path.join(DIR, file);
      try {
        const stat = await fs.stat(fp);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(fp);
          deleted += 1;
        }
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }
  } catch (err) {
    logService.error('EtiquetaPDF cleanup — error general', { error: err.message });
    throw err;
  }

  logService.info('EtiquetaPDF cleanup', { scanned, deleted, olderThanDays, errors: errors.length });
  return { scanned, deleted, olderThanDays, errors };
}

let interval = null;

function startScheduler() {
  if (interval) return;
  // Primer run al arrancar (no bloquea)
  cleanup().catch((err) => {
    logService.warning('EtiquetaPDF cleanup inicial falló', { error: err.message });
  });
  // Luego cada 24h
  interval = setInterval(() => {
    cleanup().catch((err) => {
      logService.warning('EtiquetaPDF cleanup periódico falló', { error: err.message });
    });
  }, DAILY_MS);
  if (interval.unref) interval.unref();
}

function stopScheduler() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

module.exports = { cleanup, startScheduler, stopScheduler };
