/*
 * Escudos — ZeroZero only
 *
 * Fluxo:
 *   nome da equipa -> pesquisa ZeroZero -> página /equipa/... -> escudo
 *   -> data URL -> cache opcional no GitHub
 *
 * Não usa TheSportsDB, Wikipedia, Wikidata ou imagens aleatórias.
 *
 * NOTA: o acesso automatizado ao ZeroZero pode responder 403. Este ficheiro
 * NÃO tenta contornar mecanismos de proteção. Nesse caso devolve um erro
 * explícito para podermos usar a autorização/endpoint permitido pelo site.
 */

const ZEROZERO = 'https://www.zerozero.pt';
const SEARCH_URL_TEMPLATE =
  process.env.ZEROZERO_SEARCH_URL || `${ZEROZERO}/pesquisa?search={query}`;

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()\-]/g, ' ')
    .replace(/\b(?:sad|sduq|oaf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(value = '') {
  return String(value)
    .replace(/\s*\/\s*OAF\b/ig, '')
    .replace(/\bSAD\b/ig, '')
    .replace(/\bSDUQ\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return -9999;
  if (q === c) return 1000;
  if (c === q || c.includes(q) || q.includes(c)) {
    return 800 - Math.abs(c.length - q.length);
  }
  const qa = new Set(q.split(' ').filter(Boolean));
  const ca = new Set(c.split(' ').filter(Boolean));
  const common = [...qa].filter(x => ca.has(x)).length;
  return common * 80 - Math.abs(c.length - q.length);
}

function absoluteUrl(value) {
  try {
    return new URL(value, ZEROZERO).href;
  } catch {
    return null;
  }
}

function isZeroZeroUrl(value) {
  try {
    const u = new URL(value);
    return u.hostname === 'www.zerozero.pt' || u.hostname === 'zerozero.pt';
  } catch {
    return false;
  }
}

function htmlEntitiesDecode(value = '') {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value = '') {
  return htmlEntitiesDecode(
    value.replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

async function zerozeroFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
      ...options.headers
    },
    redirect: 'follow'
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `ZEROZERO_ACCESS_DENIED:${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `ZEROZERO_HTTP_${response.status}`
    );
  }

  return response;
}

function extractTeamCandidates(html) {
  const candidates = [];

  // Links in the form /equipa/nome/id and /equipa/nome/id/...
  const linkRe = /<a[^>]+href=["']([^"']*\/equipa\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRe.exec(html))) {
    const href = absoluteUrl(htmlEntitiesDecode(match[1]));
    if (!href || !isZeroZeroUrl(href)) continue;

    const url = new URL(href);
    if (!/^\/equipa\//i.test(url.pathname)) continue;

    const label = stripHtml(match[2]);
    candidates.push({
      url: href,
      label,
      score: 0
    });
  }

  // JSON/HTML escaped URLs that are not inside an anchor.
  const rawRe = /(?:https?:\\?\/\\?\/www\.zerozero\.pt|\/equipa\/)[^"'<>\s\\]+/gi;
  while ((match = rawRe.exec(html))) {
    const href = absoluteUrl(
      htmlEntitiesDecode(match[0]).replace(/\\\//g, '/')
    );
    if (!href || !isZeroZeroUrl(href)) continue;
    const url = new URL(href);
    if (!/^\/equipa\//i.test(url.pathname)) continue;
    candidates.push({ url: href, label: '', score: 0 });
  }

  const unique = new Map();
  for (const item of candidates) {
    const key = item.url.split('#')[0].replace(/\/$/, '');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function extractTeamNameFromPage(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripHtml(h1[1]);

  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  if (og) return htmlEntitiesDecode(og[1]).trim();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripHtml(title[1]) : '';
}

function extractShieldCandidates(html) {
  const urls = [];
  let match;

  // Prefer images near logo/emblem/badge/escudo related class/id/alt names.
  const imgRe = /<img\b[^>]*>/gi;
  while ((match = imgRe.exec(html))) {
    const tag = match[0];
    const context = tag.toLowerCase();
    if (!/(logo|badge|escudo|emblema|team|equipa|club)/i.test(context)) continue;

    const attrs = [
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1]?.split(',')[0]?.trim()?.split(/\s+/)[0]
    ].filter(Boolean);

    for (const raw of attrs) {
      const url = absoluteUrl(htmlEntitiesDecode(raw));
      if (url) urls.push(url);
    }
  }

  // Fallback: inspect every image, but only accept ZeroZero-hosted assets.
  if (!urls.length) {
    while ((match = imgRe.exec(html))) {
      const tag = match[0];
      for (const raw of [
        tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
        tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1]
      ].filter(Boolean)) {
        const url = absoluteUrl(htmlEntitiesDecode(raw));
        if (url) urls.push(url);
      }
    }
  }

  return [...new Set(urls)].filter(url => {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('zerozero.pt') ||
        u.hostname.endsWith('zerozero.eu');
    } catch {
      return false;
    }
  });
}

async function searchZeroZero(team) {
  const names = [...new Set([
    String(team).trim(),
    cleanName(team)
  ].filter(Boolean))];

  const candidates = [];

  for (const name of names) {
    const searchUrl = SEARCH_URL_TEMPLATE.replace(
      '{query}',
      encodeURIComponent(name)
    );

    const response = await zerozeroFetch(searchUrl);
    const html = await response.text();

    for (const candidate of extractTeamCandidates(html)) {
      candidate.score = score(name, candidate.label || candidate.url);
      candidates.push(candidate);
    }
  }

  const unique = new Map();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }

  const ranked = [...unique.values()].sort(
    (a, b) => b.score - a.score
  );

  if (!ranked.length) {
    throw new Error('ZEROZERO_TEAM_NOT_FOUND');
  }

  // Validate candidate pages before accepting an emblem.
  for (const candidate of ranked.slice(0, 8)) {
    const page = await zerozeroFetch(candidate.url);
    const pageHtml = await page.text();
    const pageName = extractTeamNameFromPage(pageHtml);

    const validationScore = score(team, pageName);
    if (validationScore < 300) continue;

    const imageCandidates = extractShieldCandidates(pageHtml);
    if (!imageCandidates.length) continue;

    return {
      source: 'ZeroZero',
      team: pageName || candidate.label || team,
      pageUrl: candidate.url,
      imageUrl: imageCandidates[0],
      score: validationScore
    };
  }

  throw new Error('ZEROZERO_SHIELD_NOT_FOUND');
}

async function imageToDataUrl(url) {
  if (!isZeroZeroUrl(url)) {
    throw new Error('ZEROZERO_IMAGE_URL_REJECTED');
  }

  const response = await zerozeroFetch(url, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });

  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!type.startsWith('image/')) {
    throw new Error('ZEROZERO_RESPONSE_IS_NOT_IMAGE');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('ZEROZERO_EMPTY_IMAGE');

  return `data:${type};base64,${buffer.toString('base64')}`;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(
    /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/i
  );
  if (!match) return null;
  const extension = match[1].toLowerCase() === 'jpeg'
    ? 'jpg'
    : match[1].toLowerCase() === 'svg+xml'
      ? 'svg'
      : match[1].toLowerCase();
  return { extension, base64: match[2] };
}

function safeName(name = '') {
  return cleanName(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function saveShieldToGitHub(team, dataUrl) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return {
      ok: false,
      error: 'GITHUB_TOKEN ou GITHUB_REPO não configurado.'
    };
  }

  const image = parseImageDataUrl(dataUrl);
  if (!image) return { ok: false, error: 'Imagem inválida.' };

  const filename = safeName(team) + '.' + image.extension;
  const path = `public/escudos/${filename}`;
  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };

  try {
    let sha = null;
    const current = await fetch(
      `${apiUrl}?ref=${encodeURIComponent(branch)}`,
      { headers }
    );

    if (current.ok) {
      sha = (await current.json())?.sha || null;
    } else if (current.status !== 404) {
      return {
        ok: false,
        error: `GitHub GET falhou (${current.status})`
      };
    }

    const payload = {
      message: `Adicionar escudo ZeroZero: ${filename}`,
      content: image.base64,
      branch,
      ...(sha ? { sha } : {})
    };

    const put = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    const result = await put.json().catch(() => ({}));
    if (!put.ok) {
      return {
        ok: false,
        error: result?.message || `GitHub PUT falhou (${put.status})`
      };
    }

    return {
      ok: true,
      path,
      commit: result?.commit?.sha || null
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Erro ao guardar no GitHub.'
    };
  }
}

async function handleSave(req, res) {
  const { team, dataUrl } = parseBody(req);
  if (!team || !dataUrl) {
    return res.status(400).json({
      error: 'team e dataUrl são obrigatórios.'
    });
  }

  const result = await saveShieldToGitHub(team, dataUrl);
  if (!result.ok) {
    return res.status(500).json({ error: result.error });
  }

  return res.status(200).json(result);
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    return handleSave(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const team = String(req.query?.team || '').trim();
  if (!team) {
    return res.status(400).json({ error: 'team obrigatório' });
  }

  try {
    const found = await searchZeroZero(team);
    const imageDataUrl = await imageToDataUrl(found.imageUrl);

    // A cache no GitHub é opcional. O JPG não falha se o GitHub estiver indisponível.
    const saved = await saveShieldToGitHub(team, imageDataUrl);

    return res.status(200).json({
      ok: true,
      source: 'ZeroZero',
      team: found.team,
      matchedTeam: found.team,
      zeroZeroPage: found.pageUrl,
      zeroZeroImage: found.imageUrl,
      imageDataUrl,
      saved: !!saved.ok,
      savedPath: saved.path || null,
      saveError: saved.ok ? null : saved.error
    });
  } catch (error) {
    const message = error?.message || 'Erro desconhecido';

    if (message.startsWith('ZEROZERO_ACCESS_DENIED:')) {
      return res.status(502).json({
        ok: false,
        error: 'O ZeroZero recusou o acesso automatizado. É necessária autorização/endpoint permitido pelo ZeroZero.',
        code: message
      });
    }

    return res.status(500).json({
      ok: false,
      error: message
    });
  }
}
