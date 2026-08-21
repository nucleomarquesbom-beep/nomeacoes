/**
 * Compatibilidade para o app antigo:
 *
 * O src/app.js atual pede directamente:
 *   /escudos/NOME.png
 *
 * Esta função transforma esse pedido numa imagem real, usando a API
 * principal /api/escudo. Assim não é necessário alterar o app.js.
 */

function stripExtension(value = '') {
  return String(value)
    .replace(/\.(?:png|jpe?g|webp|svg)$/i, '')
    .trim();
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(
    /^data:(image\/[^;]+);base64,([\s\S]+)$/
  );

  if (!match) return null;

  const allowed = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/svg+xml'
  ]);

  const mime = match[1].toLowerCase();

  if (!allowed.has(mime)) return null;

  return {
    mime,
    buffer: Buffer.from(match[2], 'base64')
  };
}

function getBaseUrl(req) {
  const forwardedProto =
    String(req.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();

  const protocol =
    forwardedProto ||
    (req.headers?.host?.startsWith('localhost') ? 'http' : 'https');

  const host =
    req.headers?.host ||
    process.env.VERCEL_URL;

  if (!host) return null;

  return `${protocol}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  const rawTeam = String(req.query?.team || '').trim();
  const team = stripExtension(rawTeam);

  if (!team) {
    return res.status(400).end('Equipa não indicada.');
  }

  const baseUrl = getBaseUrl(req);

  if (!baseUrl) {
    return res.status(500).end('Não foi possível determinar o endereço da API.');
  }

  const target =
    `${baseUrl}/api/escudo?team=${encodeURIComponent(team)}`;

  try {
    const response = await fetch(target, {
      headers: {
        Accept: 'application/json'
      }
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok || !payload?.imageDataUrl) {
      return res.status(response.ok ? 404 : response.status).json({
        ok: false,
        error: payload?.error || `API de escudo respondeu ${response.status}.`,
        team
      });
    }

    const image = parseDataUrl(payload.imageDataUrl);

    if (!image || !image.buffer.length) {
      return res.status(502).end('A API não devolveu uma imagem válida.');
    }

    res.setHeader('Content-Type', image.mime);
    res.setHeader('Content-Length', String(image.buffer.length));
    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );
    res.setHeader('X-Shield-Source', 'FPF->ZeroZero');

    return res.status(200).send(image.buffer);
  } catch (error) {
    console.error('[escudo-image]', error);

    return res.status(502).json({
      ok: false,
      error: 'Falha ao obter o escudo.',
      detail: error?.message || 'Erro desconhecido.',
      team
    });
  }
}
