/*
 * ============================================================
 * ESCUDOS ONLINE
 * ============================================================
 *
 * O app deve:
 *   1. procurar primeiro os escudos locais;
 *   2. enviar apenas os que faltam para esta função;
 *   3. guardar os resultados em state.assets.
 *
 * A API /api/escudo é responsável por:
 *   - procurar no ZeroZero;
 *   - descarregar o escudo;
 *   - gravá-lo em public/escudos/ no GitHub;
 *   - devolver a imagem para a publicação actual.
 */

export async function prepareMissingShields(
  teams,
  {
    timeoutMs = 30000,
    onProgress = () => {}
  } = {}
) {
  const unique = [
    ...new Set(
      teams
        .map(String)
        .map(v => v.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  ];

  if (!unique.length) {
    return {
      found: 0,
      online: 0,
      failed: 0,
      total: 0,
      failures: []
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("/api/escudo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ teams: unique }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API de escudos respondeu ${response.status}.`);
    }

    const payload = await response.json();

    const failures = [];
    let online = 0;

    for (const result of payload.results || []) {
      if (result.ok && result.imageDataUrl) {
        online++;

        const img = await loadImage(result.imageDataUrl);

        if (img) {
          state.assets.set(
            "remoteShield:" + compact(result.team),
            img
          );
        } else {
          failures.push({
            team: result.team,
            error: "A imagem devolvida não carregou no browser."
          });
        }
      } else {
        failures.push({
          team: result.team,
          error: result.error || "Escudo não encontrado."
        });
      }

      onProgress({
        processed: online + failures.length,
        total: unique.length,
        team: result.team
      });
    }

    return {
      found: online,
      online,
      failed: failures.length,
      total: unique.length,
      failures
    };
  } finally {
    clearTimeout(timer);
  }
}

function loadImage(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);

    img.src = dataUrl;
  });
}
