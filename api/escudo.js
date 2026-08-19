import sharp from 'sharp';

const ZEROZERO = 'https://www.zerozero.pt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NAF-Marques-Bom/6.0';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value = '') {
  return normalize(value).replace(/\s+/g, '');
}

function cleanTeam(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(value = '') {
  return normalize(value)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'escudo';
}

/*
 * Regras mantidas da aplicação:
 * - nome original;
 * - remover / OAF;
 * - remover SAD/SDUQ;
 * - remover pontuação.
 */
function teamVariants(team) {
  const base = cleanTeam(team);

  return [...new Set([
    base,
    base
      .replace(/\s*\/\s*OAF\b/ig, '')
      .replace(/\bSAD\b/ig, '')
      .replace(/\bSDUQ\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim(),
    base.replace(/[,.]/g, '').replace(/\s+/g, ' ').trim()
  ].filter(Boolean))];
}

function scoreName(wanted, candidate) {
  const a = normalize(wanted);
  const b = normalize(candidate);

  if (!a || !b) return -Infinity;
  if (a === b) return 10000;

  const aw = a.split(' ').filter(Boolean);
  const bw = new Set(b.split(' ').filter(Boolean));
  const common = aw.filter(w => w.length > 1 && bw.has(w)).length;
  const coverage = common / Math.max(aw.length, 1);

  let score = common * 700 + coverage * 1200;
  if (a.includes(b) || b.includes(a)) score += 900;
  score -= Math.abs(a.length - b.length) * 1.5;

  return score;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function absolute(base, value) {
  try {
    return new URL(
      String(value)
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/'),
      base
    ).href;
  } catch {
    return null;
  }
}

function htmlText(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTeamLinks(html, baseUrl, wanted) {
  const result = [];
  const seen = new Set();

  const add = (href, label = '') => {
    const url = absolute(baseUrl, href);
    if (!url) return;

    let u;
    try { u = new URL(url); } catch { return; }

    if (u.hostname !== 'www.zerozero.pt') return;
    if (!/^\/equipa\//i.test(u.pathname)) return;

    const cleanUrl = `${u.origin}${u.pathname}${u.search}`;
    if (seen.has(cleanUrl)) return;
    seen.add(cleanUrl);

    const name = htmlText(label) ||
      decodeURIComponent(u.pathname.split('/')[2] || '').replace(/-/g, ' ');

    if (!name) return;

    result.push({
      name,
      url: cleanUrl,
      score: scoreName(wanted, name)
    });
  };

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = anchorRe.exec(html))) {
    add(m[1], m[2]);
  }

  // Também apanha URLs /equipa/ presentes em JSON/atributos.
  const urlRe = /["']((?:https?:\/\/www\.zerozero\.pt)?\/equipa\/[^"'\\\s]+)["']/gi;

  while ((m = urlRe.exec(html))) {
    add(m[1]);
  }

  return result.sort((a, b) => b.score - a.score);
}

function extractLogoCandidates(html, pageUrl) {
  const result = [];
  const seen = new Set();

  const add = raw => {
    const url = absolute(pageUrl, raw);
    if (!url || seen.has(url)) return;

    try {
      const u = new URL(url);

      // Para esta função, o ZeroZero é a fonte autorizada.
      if (
        u.hostname !== 'www.zerozero.pt' &&
        !u.hostname.endsWith('.zerozero.pt')
      ) return;
    } catch {
      return;
    }

    seen.add(url);
    result.push(url);
  };

  for (const m of html.matchAll(
    /https?:\/\/[^"'<> \t\r\n]+\/img\/logos\/equipas\/[^"'<> \t\r\n]+/gi
  )) add(m[0]);

  for (const m of html.matchAll(
    /(?:src|data-src|data-original|data-lazy-src|data-image)=["']([^"']+)["']/gi
  )) {
    if (
      /\/img\/logos\/equipas\//i.test(m[1]) ||
      /(logo|badge|emblem|escudo|crest)/i.test(m[1])
    ) add(m[1]);
  }

  for (const m of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) add(m[1]);

  for (const m of html.matchAll(
    /"(?:logo|image)"\s*:\s*"([^"]+)"/gi
  )) add(m[1]);

  return result;
}

async function openTeamPage(candidate, wanted) {
  let response;

  try {
    response = await fetchWithTimeout(candidate.url, {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
  } catch {
    return null;
  }

  if (!response?.ok) return null;

  const html = await response.text();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  const pageName = htmlText(h1 || title);

  const score = Math.max(
    scoreName(wanted, pageName),
    scoreName(wanted, candidate.name)
  );

  // Não aceitar uma página genérica/errada.
  if (score < 650) return null;

  const logoUrls = extractLogoCandidates(html, candidate.url);
  if (!logoUrls.length) return null;

  return {
    name: pageName || candidate.name,
    page: candidate.url,
    logoUrl: logoUrls[0],
    score
  };
}

async function searchZeroZero(team) {
  const wanted = cleanTeam(team);
  const candidates = [];

  const paths = [
    q => `/pesquisa?search_txt=${encodeURIComponent(q)}`,
    q => `/pesquisa?query=${encodeURIComponent(q)}`,
    q => `/pesquisa?search=${encodeURIComponent(q)}`,
    q => `/search.php?search_string=${encodeURIComponent(q)}`
  ];

  for (const variant of teamVariants(wanted)) {
    for (const makePath of paths) {
      try {
        const response = await fetchWithTimeout(
          ZEROZERO + makePath(variant),
          { headers: { Accept: 'text/html,application/xhtml+xml' } }
        );

        if (!response.ok) continue;

        const html = await response.text();
        candidates.push(...extractTeamLinks(html, ZEROZERO, wanted));

        // Já temos uma correspondência exacta: não precisamos de bombardear
        // o ZeroZero com mais pesquisas.
        if (candidates.some(c => c.score >= 10000)) break;
      } catch {
        // tenta a próxima variante
      }
    }

    if (candidates.some(c => c.score >= 10000)) break;
  }

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  for (const candidate of unique.slice(0, 6)) {
    const page = await openTeamPage(candidate, wanted);
    if (page) {
      return {
        requested: wanted,
        matchedTeam: page.name,
        zeroZeroPage: page.page,
        zeroZeroImage: page.logoUrl,
        score: page.score
      };
    }
  }

  throw new Error(`Não foi possível identificar "${wanted}" no ZeroZero.`);
}

async function downloadImage(url) {
  let response;

  try {
    response = await fetchWithTimeout(url, {
      headers: {
        Accept:
          'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
  } catch {
    return null;
  }

  if (!response?.ok) return null;

  const type = (response.headers.get('content-type') || '').toLowerCase();
  const length = Number(response.headers.get('content-length') || 0);

  if (!type.startsWith('image/')) return null;
  if (length > MAX_IMAGE_BYTES) return null;

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_IMAGE_BYTES) return null;

  return buffer;
}

async function toPngDataUrl(buffer) {
  const png = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString('base64')}`;
}

function githubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main'
  };
}

async function github(url, options = {}) {
  const { token } = githubConfig();
  if (!token) return null;

  try {
    return await fetchWithTimeout(
      url,
      {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.headers || {})
        }
      },
      7000
    );
  } catch {
    return null;
  }
}

async function cachedShield(team) {
  const { repo, branch } = githubConfig();
  if (!repo || !process.env.GITHUB_TOKEN) return null;

  const paths = [];

  for (const variant of teamVariants(team)) {
    const base = slug(variant);
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      paths.push(`public/escudos/${base}.${ext}`);
    }
  }

  for (const path of [...new Set(paths)]) {
    const apiUrl =
      `https://api.github.com/repos/${repo}/contents/` +
      path.split('/').map(encodeURIComponent).join('/') +
      `?ref=${encodeURIComponent(branch)}`;

    const response = await github(apiUrl);
    if (!response?.ok) continue;

    const meta = await response.json().catch(() => null);
    if (!meta?.download_url) continue;

    const image = await downloadImage(meta.download_url);
    if (!image) continue;

    return {
      imageDataUrl: await toPngDataUrl(image),
      source: 'GitHub',
      cached: true,
      path
    };
  }

  return null;
}

async function saveToGithub(team, dataUrl) {
  const { repo, branch } = githubConfig();

  // O GitHub é cache. Se estiver indisponível, NÃO pode impedir a geração.
  if (!repo || !process.env.GITHUB_TOKEN) {
    return {
      saved: false,
      cacheError: 'GITHUB_TOKEN/GITHUB_REPO não configurado.'
    };
  }

  const match = String(dataUrl).match(
    /^data:image\/png;base64,(.+)$/i
  );

  if (!match) {
    return {
      saved: false,
      cacheError: 'Imagem PNG inválida.'
    };
  }

  const path = `public/escudos/${slug(team)}.png`;

  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    path.split('/').map(encodeURIComponent).join('/');

  // Nunca substituir um escudo já existente.
  const existing = await github(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`
  );

  if (existing?.ok) {
    return {
      saved: true,
      alreadyExists: true,
      path
    };
  }

  if (existing && existing.status !== 404) {
    return {
      saved: false,
      cacheError: `GitHub respondeu ${existing.status}.`,
      path
    };
  }

  const write = await github(apiUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Adicionar escudo: ${cleanTeam(team)}`,
      content: match[1],
      branch
    })
  });

  if (!write) {
    return {
      saved: false,
      cacheError: 'GitHub indisponível no momento.',
      path
    };
  }

  const result = await write.json().catch(() => ({}));

  if (!write.ok) {
    return {
      saved: false,
      cacheError: result?.message || `GitHub respondeu ${write.status}.`,
      path
    };
  }

  return {
    saved: true,
    alreadyExists: false,
    path
  };
}

async function one(team) {
  const requested = cleanTeam(team);

  if (!requested) {
    return {
      ok: false,
      error: 'Nome da equipa vazio.'
    };
  }

  // 1. Cache permanente primeiro.
  const cached = await cachedShield(requested);

  if (cached) {
    return {
      ok: true,
      team: requested,
      ...cached
    };
  }

  // 2. ZeroZero.
  const found = await searchZeroZero(requested);
  const image = await downloadImage(found.zeroZeroImage);

  if (!image) {
    return {
      ok: false,
      team: requested,
      source: 'ZeroZero',
      error: 'Encontrámos a equipa, mas não foi possível descarregar o escudo.'
    };
  }

  const imageDataUrl = await toPngDataUrl(image);

  // 3. Guardar em cache sem tornar o GitHub obrigatório.
  const saved = await saveToGithub(requested, imageDataUrl);

  return {
    ok: true,
    team: requested,
    ...found,
    source: 'ZeroZero',
    imageDataUrl,
    ...saved
  };
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const result = await one(req.query?.team || '');
      return res.status(result.ok ? 200 : 404).json(result);
    }

    if (req.method === 'POST') {
      const data = parseBody(req);

      if (!Array.isArray(data.teams)) {
        return res.status(400).json({
          ok: false,
          error: 'teams obrigatório.'
        });
      }

      const teams = [...new Set(
        data.teams.map(cleanTeam).filter(Boolean)
      )];

      const results = [];

      // Protege o ZeroZero: no máximo 3 pesquisas simultâneas.
      for (let i = 0; i < teams.length; i += 3) {
        const batch = teams.slice(i, i + 3);

        const part = await Promise.all(
          batch.map(team =>
            one(team).catch(error => ({
              ok: false,
              team,
              error: error?.message || 'Erro desconhecido.'
            }))
          )
        );

        results.push(...part);
      }

      return res.status(200).json({
        ok: true,
        total: teams.length,
        results
      });
    }

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  } catch (error) {
    console.error('[api/escudo]', error);

    return res.status(500).json({
      ok: false,
      error: error?.message || 'Erro interno na pesquisa do escudo.'
    });
  }
}
