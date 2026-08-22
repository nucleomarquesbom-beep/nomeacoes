import fs from 'node:fs';
import path from 'node:path';

function normalize(value = '') {
  return String(value)
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*(?:,|[-–—|])?\s*(?:sad|sduq|oaf|sdq)\s*b?\s*$/i, '')
    .replace(/\s*(?:,|[-–—|])?\s*b\s*$/i, '')
    .replace(/\s+/g, '')
    .trim();
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const dir = path.join(process.cwd(), 'public', 'escudos');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

    const result = files
      .filter(name => /\.(png|jpe?g|webp)$/i.test(name))
      .map(name => ({
        key: normalize(name),
        url: `/escudos/${encodeURIComponent(name)}`
      }))
      .filter(item => item.key);

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.status(200).json({ files: result });
  } catch (error) {
    console.error('[ESCUDOS-LOCAL]', error);
    return res.status(200).json({ files: [] });
  }
}
