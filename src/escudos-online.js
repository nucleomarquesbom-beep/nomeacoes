/*
 * Cliente da API de escudos.
 *
 * O app.js principal pode continuar a fazer:
 *   GET /api/escudo?team=Nome
 *
 * Esta função é opcional para processamento em lote.
 * Não contém pesquisa de imagens nem lógica ZeroZero.
 */

export async function prepareMissingShields(
  teams,
  { timeoutMs = 120000, onProgress = () => {} } = {}
) {
  const unique = [...new Set(
    (teams || [])
      .map(v => String(v).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  )];

  if (!unique.length) {
    return { found: 0, online: 0, failed: 0, total: 0, failures: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('/api/escudo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ teams: unique }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API de escudos respondeu ${response.status}.`);
    }

    const payload = await response.json();
    const failures = [];
    let found = 0;
    let processed = 0;

    for (const result of payload.results || []) {
      processed++;

      if (result.ok && result.imageDataUrl) {
        const image = await loadImage(result.imageDataUrl);

        if (image) {
          found++;
          if (typeof state !== 'undefined' && state.assets) {
            state.assets.set(`remoteShield:${compact(result.team)}`, image);
            state.assets.set(`s:${compact(result.team)}`, image);
          }
        } else {
          failures.push({ team: result.team, error: 'Imagem devolvida não carregou.' });
        }
      } else {
        failures.push({ team: result.team, error: result.error || 'Escudo não encontrado.' });
      }

      onProgress({ processed, total: unique.length, team: result.team });
    }

    return {
      found,
      online: found,
      failed: failures.length,
      total: unique.length,
      failures
    };
  } finally {
    clearTimeout(timer);
  }
}

function compact(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');
}

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
