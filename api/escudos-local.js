// Inventário real dos escudos existentes em public/escudos.
// Este endpoint existe para o frontend nunca ter de testar extensões
// inexistentes através de pedidos HTTP (evita os 404 em massa).

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTeamKey } from '../shared/team-normalize.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ESCUDOS_DIR = path.resolve(__dirname, '../public/escudos');
const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
]);

let cache = null;

async function buildInventory() {
  const shields = {};

  let entries;

  try {
    entries = await fs.readdir(ESCUDOS_DIR, {
      withFileTypes: true
    });
  } catch (error) {
    console.error('Não foi possível ler public/escudos:', error);
    return { shields: {}, count: 0 };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    const baseName = path.basename(entry.name, ext);
    const key = getTeamKey(baseName);

    if (!key || shields[key]) continue;

    shields[key] = {
      file: entry.name,
      url: `/escudos/${encodeURIComponent(entry.name)}`
    };
  }

  return {
    shields,
    count: Object.keys(shields).length
  };
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

  try {
    if (!cache) {
      cache = await buildInventory();
    }

    res.setHeader(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=3600'
    );

    return res.status(200).json(cache);
  } catch (error) {
    console.error('Erro no inventário de escudos:', error);

    return res.status(500).json({
      error: 'Erro ao construir inventário de escudos.'
    });
  }
}
