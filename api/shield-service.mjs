import { Buffer } from 'node:buffer';

const FPF_BASE = 'https://resultados.fpf.pt';
const ZEROZERO_BASE = 'https://www.zerozero.pt';
const JINA_SEARCH = 'https://s.jina.ai/';
const JINA_READER = 'https://r.jina.ai/';
const GITHUB_API = 'https://api.github.com';
const UA = process.env.FPF_ZEROZERO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

const memory = new Map();
const inFlight = new Map();

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function normalize(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()-]/g, ' ')
    .replace(/\b(?:sad|sduq|oaf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

function htmlText(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function linksFromText(text, allowedHost, pathPattern) {
  const out = [];
  const re = /https?:\/\/[^\s<>"')]+/gi;
  let m;

  while ((m = re.exec(String(text)))) {
    const url = m[0].replace(/[),.;]+$/, '');
    try {
      const u = new URL(url);
      if (u.hostname !== allowedHost && !u.hostname.endsWith(`.${allowedHost}`)) continue;
      if (pathPattern && !pathPattern.test(u.pathname)) continue;
      out.push(url);
    } catch {}
  }

  return [...new Set(out)];
}

async function fetchText(url, { timeoutMs = 12000, jina = false } = {}) {
  const target = jina ? `${JINA_READER}${url}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        Accept: jina
          ? 'text/plain,text/markdown,text/html,*/*'
          : 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });

    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function jinaSearch(query) {
  return fetchText(`${JINA_SEARCH}${encodeURIComponent(query)}`, { timeoutMs: 12000 });
}

function extractTitle(text) {
  const md = String(text).match(/^#\s+(.+)$/m);
  if (md) return clean(md[1]);

  const title = String(text).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? htmlText(title[1]) : '';
}

function extractFpfNumber(text) {
  const source = `${text}\n${htmlText(text)}`;

  const patterns = [
    /\bN(?:[ºo°]|úmero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bF\.?\s*P\.?\s*F\.?\s*(?:N(?:[ºo°]|úmero)?|Num\.?)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:fpfNumber|numeroFpf|numFpf|fpfNo)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }

  return null;
}

async function searchFpf(team) {
  const wanted = clean(team);

  const queries = [
    `site:resultados.fpf.pt/Club/Details "${wanted}"`,
    `site:resultados.fpf.pt/Club/Details ${wanted}`,
    `site:resultados.fpf.pt "${wanted}" "Num. FPF"`
  ];

  const candidates = [];

  for (const query of queries) {
    try {
      const result = await jinaSearch(query);
      candidates.push(
        ...linksFromText(
          result,
          'resultados.fpf.pt',
          /\/Club\/Details$/i
        )
      );

      if (candidates.length) break;
    } catch {}
  }

  const unique = [...new Set(candidates)];

  if (!unique.length) {
    throw new Error('FPF_CLUB_NOT_FOUND');
  }

  for (const url of unique.slice(0, 8)) {
    try {
      const page = await fetchText(url, {
        timeoutMs: 12000,
        jina: true
      });

      const number = extractFpfNumber(page);

      if (!number) continue;

      return {
        name: extractTitle(page) || wanted,
        fpfNumber: String(number),
        url
      };
    } catch {}
  }

  throw new Error('FPF_NUMBER_NOT_FOUND');
}

function extractZeroZeroFpfNumber(text) {
  const source = `${text}\n${htmlText(text)}`;

  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[úu]mero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:numFpf|fpfNumber)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function extractLogoUrl(text, pageUrl) {
  const source = String(text);
  const urls = [];

  const direct = /https?:\/\/[^\s"'<>]+/gi;
  let match;

  while ((match = direct.exec(source))) {
    const url = match[0].replace(/[),.;]+$/, '');

    if (
      /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url) &&
      /logo|escudo|badge|team|equipa/i.test(url)
    ) {
      urls.push(url);
    }
  }

  const attrs =
    source.match(/(?:src|data-src|data-lazy-src)=["'][^"']+["']/gi) || [];

  for (const attr of attrs) {
    const value = attr.match(/=["']([^"']+)["']/);

    if (!value) continue;

    const url = absolute(value[1], pageUrl);

    if (
      url &&
      /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)
    ) {
      urls.push(url);
    }
  }

  return [...new Set(urls)][0] || null;
}

async function searchZeroZero(fpfNumber, fpfName) {
  const queries = [
    `site:zerozero.pt/equipa "${fpfNumber}" "Num.FPF"`,
    `site:zerozero.pt/equipa "${fpfNumber}" "${fpfName}"`,
    `site:zerozero.pt/equipa "${fpfName}"`
  ];

  const candidates = [];

  for (const query of queries) {
    try {
      const result = await jinaSearch(query);

      candidates.push(
        ...linksFromText(
          result,
          'www.zerozero.pt',
          /\/equipa\//i
        )
      );

      if (candidates.length) break;
    } catch {}
  }

  const unique = [...new Set(candidates)];

  if (!unique.length) {
    throw new Error('ZEROZERO_TEAM_NOT_FOUND');
  }

  for (const url of unique.slice(0, 12)) {
    try {
      const page = await fetchText(url, {
        timeoutMs: 12000,
        jina: true
      });

      const numFpf = extractZeroZeroFpfNumber(page);

      // REGRA CRÍTICA:
      // o ZeroZero só é aceite se o Num.FPF for exactamente igual.
      if (String(numFpf || '') !== String(fpfNumber)) {
        continue;
      }

      const logoUrl = extractLogoUrl(page, url);

      if (!logoUrl) continue;

      return {
        name: extractTitle(page) || fpfName,
        numFpf: String(numFpf),
        pageUrl: url,
        imageUrl: logoUrl
      };
    } catch {}
  }

  throw new Error('ZEROZERO_NUM_FPF_NOT_CONFIRMED');
}

function safeFilename(name) {
  return clean(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'escudo';
}

function variants(team) {
  const raw = clean(team);

  return [
    ...new Set([
      raw,
      raw
        .replace(/\s*\/\s*OAF\b/ig, '')
        .replace(/\b(?:SAD|SDUQ|OAF)\b/ig, '')
        .replace(/\s+/g, ' ')
        .trim(),
      raw
        .replace(/[,.]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    ])
  ].filter(Boolean);
}

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function downloadImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`ZEROZERO_IMAGE_HTTP_${response.status}`);
  }

  const mime =
    (response.headers.get('content-type') || 'image/png')
      .split(';')[0]
      .toLowerCase();

  if (!mime.startsWith('image/')) {
    throw new Error('ZEROZERO_IMAGE_INVALID_TYPE');
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error('ZEROZERO_IMAGE_EMPTY');
  }

  return { mime, buffer };
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;

  if (!token) return null;

  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function getCachedShield(team) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!repo) return null;

  for (const name of variants(team)) {
    const filename = `${safeFilename(name)}.png`;
    const path = `public/escudos/${filename}`;
    const encoded =
      path.split('/').map(encodeURIComponent).join('/');

    const response = await githubRequest(
      `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`
    );

    if (!response?.ok) continue;

    const body = await response.json();

    if (!body?.download_url) continue;

    const image = await fetch(body.download_url, {
      redirect: 'follow'
    });

    if (!image.ok) continue;

    const mime =
      (image.headers.get('content-type') || 'image/png')
        .split(';')[0];

    const buffer =
      Buffer.from(await image.arrayBuffer());

    if (buffer.length) {
      return {
        mime,
        buffer,
        path
      };
    }
  }

  return null;
}

async function saveCachedShield(team, mime, buffer) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!repo || !process.env.GITHUB_TOKEN) {
    return null;
  }

  const extension =
    mime === 'image/svg+xml'
      ? 'svg'
      : mime === 'image/webp'
        ? 'webp'
        : mime.includes('jpeg')
          ? 'jpg'
          : 'png';

  const path =
    `public/escudos/${safeFilename(team)}.${extension}`;

  const encoded =
    path.split('/').map(encodeURIComponent).join('/');

  const existing = await githubRequest(
    `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`
  );

  let sha = null;

  if (existing?.ok) {
    sha = (await existing.json()).sha || null;
  } else if (existing && existing.status !== 404) {
    return null;
  }

  const payload = {
    message:
      `Adicionar escudo validado: ${safeFilename(team)}`,
    content: buffer.toString('base64'),
    branch,
    ...(sha ? { sha } : {})
  };

  const response = await githubRequest(
    `/repos/${repo}/contents/${encoded}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload)
    }
  );

  if (!response?.ok) return null;

  const body = await response.json();

  return {
    path,
    commit: body.commit?.sha || null
  };
}

export async function resolveShield(team) {
  const requested = clean(team);

  if (!requested) {
    throw new Error('TEAM_REQUIRED');
  }

  const key = normalize(requested);

  // Evita duas pesquisas simultâneas para a mesma equipa.
  if (memory.has(key)) {
    return memory.get(key);
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const job = (async () => {
    // 1 — cache
    const cached = await getCachedShield(requested);

    if (cached) {
      const result = {
        ok: true,
        team: requested,
        imageDataUrl: dataUrl(cached.mime, cached.buffer),
        source: 'GitHub cache',
        cached: true,
        savedPath: cached.path
      };

      memory.set(key, result);
      return result;
    }

    // 2 — FPF
    const fpf = await searchFpf(requested);

    // 3 — ZeroZero usando EXCLUSIVAMENTE o Nº FPF
    const zerozero =
      await searchZeroZero(
        fpf.fpfNumber,
        fpf.name
      );

    // 4 — validação definitiva
    if (
      String(zerozero.numFpf) !==
      String(fpf.fpfNumber)
    ) {
      throw new Error('ZEROZERO_FPF_MISMATCH');
    }

    // 5 — download
    const image =
      await downloadImage(zerozero.imageUrl);

    // 6 — cache persistente no GitHub
    const saved =
      await saveCachedShield(
        requested,
        image.mime,
        image.buffer
      );

    const result = {
      ok: true,
      team: requested,

      fpfName: fpf.name,
      fpfNumber: fpf.fpfNumber,
      fpfPage: fpf.url,

      zeroZeroTeam: zerozero.name,
      zeroZeroNumFpf: zerozero.numFpf,
      zeroZeroPage: zerozero.pageUrl,
      zeroZeroImage: zerozero.imageUrl,

      imageDataUrl:
        dataUrl(image.mime, image.buffer),

      source: 'FPF → ZeroZero',
      cached: false,
      saved: Boolean(saved),
      savedPath: saved?.path || null
    };

    memory.set(key, result);

    return result;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, job);

  return job;
}
