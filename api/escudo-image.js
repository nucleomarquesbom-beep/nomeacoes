import { resolveShield } from './shield-service.mjs';

function stripExtension(value = '') {
  return String(value)
    .replace(/\.(?:png|jpe?g|webp|svg)$/i, '')
    .trim();
}

function parseDataUrl(value) {
  const m = String(value || '').match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  const team = stripExtension(req.query?.team || '');
  if (!team) return res.status(400).end();

  try {
    const result = await resolveShield(team);
    if (!result?.ok || !result.imageDataUrl) return res.status(404).end();

    const image = parseDataUrl(result.imageDataUrl);
    if (!image?.buffer?.length) return res.status(404).end();

    res.setHeader('Content-Type', image.mime);
    res.setHeader('Content-Length', String(image.buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000');
    res.setHeader('X-Shield-Source', result.source || 'FPF->ZeroZero');
    if (result.fpfNumber) res.setHeader('X-FPF-Number', result.fpfNumber);
    if (result.zeroZeroNumFpf) res.setHeader('X-ZeroZero-Num-FPF', result.zeroZeroNumFpf);
    return res.status(200).send(image.buffer);
  } catch (error) {
    console.error('[ESCUDO-IMAGE]', { team, error: error?.message || error });
    return res.status(404).end();
  }
}
