import { resolveShield } from './shield-service.mjs';

function stripExtension(value = '') {
  return String(value).replace(/\.(?:png|jpe?g|webp|svg)$/i, '').trim();
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
  if (!match || !match[1].toLowerCase().startsWith('image/')) return null;
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  const team = stripExtension(req.query?.team || '');
  if (!team) return res.status(400).end('Equipa não indicada.');

  try {
    const result = await resolveShield(team);
    const image = parseDataUrl(result.imageDataUrl);
    if (!image) return res.status(502).end('Imagem inválida.');

    res.setHeader('Content-Type', image.mime);
    res.setHeader('Content-Length', String(image.buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('X-Shield-Source', result.source || 'FPF->ZeroZero');
    return res.status(200).send(image.buffer);
  } catch (error) {
    console.error('[ESCUDO-IMAGE]', team, error);
    return res.status(404).json({ ok: false, team, error: error?.message || 'SHIELD_NOT_FOUND' });
  }
}
