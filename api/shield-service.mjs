import { Buffer } from 'node:buffer';

const FPF_BASE = 'https://resultados.fpf.pt';
const ZEROZERO_BASE = 'https://www.zerozero.pt';
const JINA_SEARCH = 'https://s.jina.ai/';
const JINA_READER = 'https://r.jina.ai/';
const GITHUB_API = 'https://api.github.com';

const UA = process.env.FPF_ZEROZERO_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

const memory = new Map();
const inFlight = new Map();
const negative = new Map();
const NEGATIVE_TTL = 5 * 60 * 1000;

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function normalize(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()]/g, ' ')
    .replace(/\b(?:sad|sduq|oaf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupName(value = '') {
  return clean(value)
    .replace(/\s*\/\s*OAF\b/ig, '')
    .replace(/\b(?:SAD|SDUQ|OAF)\b/ig, '')
    .replace(/\s*\((?:B|C|A)\)\s*$/i, '')
    .replace(/\s+"?(?:B|C)"?\s*$/i, '')
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
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, { timeoutMs = 9000, jina = false } = {}) {
  const target = jina ? `${JINA_READER}${url}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        Accept: jina ? 'text/plain,text/markdown,text/html,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });

    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractUrls(text, hostname, pathPattern) {
  const urls = [];
  const re = /https?:\/\/[^\s<>"')]+/gi;
  let match;

  while ((match = re.exec(String(text)))) {
    const raw = match[0].replace(/[),.;]+$/, '');
    try {
      const url = new URL(raw);
      if (url.hostname !== hostname && !url.hostname.endsWith(`.${hostname}`)) continue;
      if (pathPattern && !pathPattern.test(url.pathname)) continue;
      urls.push(url.href);
    } catch {}
  }

  return [...new Set(urls)];
}

async function searchWeb(query) {
  try {
    return await fetchText(`${JINA_SEARCH}${encodeURIComponent(query)}`, { timeoutMs: 9000 });
  } catch {
    return '';
  }
}

function scoreText(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return -Infinity;
  if (x === y) return 10000;

  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  const common = [...xs].filter(t => ys.has(t)).length;
  const containment = x.includes(y) || y.includes(x) ? 2000 : 0;
  return containment + common * 350 - Math.abs(x.length - y.length);
}

/* =========================================================
   FPF — identificação do número de clube
   =========================================================

   O erro anterior era assumir que Club/Details continha
   sempre o número de registo. Na prática, a página pública
   pode mostrar apenas o clubId e não o número usado nos
   documentos oficiais.

   Por isso a pesquisa FPF usa primeiro fontes oficiais
   indexadas pela própria FPF e só depois tenta a página
   pública do Centro de Resultados.
*/

function extractFpfNumber(text, wantedName) {
  const source = `${text}\n${htmlText(text)}`;
  const wanted = normalize(wantedName);
  const lines = source.split(/\r?\n/).map(clean).filter(Boolean);

  const patterns = [
    /\bCLUBES?\s+(\d{1,6})\s*[-–—:]\s*(.+)$/i,
    /\b(?:C|CLUBE)\s*\|?\s*(\d{1,6})\s*\|?\s*(.+)$/i,
    /\b(\d{1,6})\s+([A-ZÁÀÂÃÉÊÍÓÔÕÚÇÑ0-9][^|\n]{2,100})$/i
  ];

  const candidates = [];

  for (const line of lines) {
    for (const pattern of patterns) {
      const m = line.match(pattern);
      if (!m) continue;
      const number = String(m[1]).replace(/^0+(?=\d)/, '');
      const name = clean(m[2]);
      const score = scoreText(wanted, name);
      if (score > -Infinity) candidates.push({ number, name, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function findFpfNumber(team) {
  const wanted = lookupName(team);
  const queries = [
    `site:fpf.pt "${wanted}" "CLUBES"`,
    `site:fpf.pt "${wanted}" "LIGA 3"`,
    `site:fpf.pt "${wanted}" "COMUNICADO OFICIAL"`,
    `site:resultados.fpf.pt "${wanted}" "Clubes"`
  ];

  for (const query of queries) {
    const result = await searchWeb(query);
    const candidate = extractFpfNumber(result, wanted);
    if (candidate && candidate.score >= 500) {
      return {
        number: candidate.number,
        name: candidate.name,
        source: 'FPF indexed official document'
      };
    }
  }

  /* Fallback: find an official FPF club detail page. */
  const result = await searchWeb(`site:resultados.fpf.pt/Club/Details "${wanted}"`);
  const urls = extractUrls(result, 'resultados.fpf.pt', /\/Club\/Details/i);

  for (const url of urls.slice(0, 5)) {
    try {
      const page = await fetchText(url, { timeoutMs: 7000, jina: true });
      const candidate = extractFpfNumber(page, wanted);
      if (candidate && candidate.score >= 500) {
        return {
          number: candidate.number,
          name: candidate.name,
          source: 'FPF Club/Details'
        };
      }
    } catch {}
  }

  return null;
}

/* =========================================================
   ZEROZERO
   ========================================================= */

function extractZeroZeroFpfNumber(text) {
  const source = `${text}\n${htmlText(text)}`;
  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:ú|u)mero\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:numFpf|fpfNumber)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1].replace(/^0+(?=\d)/, '');
  }
  return null;
}

function extractTitle(text) {
  const h1 = String(text).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return htmlText(h1[1]);
  const md = String(text).match(/^#\s+(.+)$/m);
  if (md) return clean(md[1]);
  return '';
}

function extractZeroZeroLogo(text, pageUrl) {
  const source = String(text);
  const urls = [];

  const metaRe = /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = metaRe.exec(source))) {
    const url = absolute(match[1], pageUrl);
    if (url) urls.push(url);
  }

  const attrRe = /(?:src|data-src|data-lazy-src|content)=["']([^"']+)["']/gi;
  while ((match = attrRe.exec(source))) {
    const url = absolute(match[1], pageUrl);
    if (url && /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)) urls.push(url);
  }

  const mdRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdRe.exec(source))) {
    const url = absolute(match[1], pageUrl);
    if (url && /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)) urls.push(url);
  }

  const direct = extractUrls(source, 'www.zerozero.pt', /./);
  urls.push(...direct.filter(url => /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)));

  const unique = [...new Set(urls)];

  const preferred = unique.find(url =>
    /logo|escudo|badge|equipas|equipa|team/i.test(url)
  );
  return preferred || unique[0] || null;
}

async function zeroZeroCandidatesByNumber(fpfNumber, fpfName) {
  const queries = [
    `site:zerozero.pt/equipa "Num.FPF ${fpfNumber}"`,
    `site:zerozero.pt/equipa "${fpfNumber}" "${fpfName}"`,
    `site:zerozero.pt/equipa "Num.FPF" "${fpfNumber}"`,
    `site:zerozero.pt/equipa "${fpfName}"`
  ];

  const candidates = [];
  for (const query of queries) {
    const result = await searchWeb(query);
    candidates.push(...extractUrls(result, 'www.zerozero.pt', /\/equipa(?:\.php)?\//i));
    if (candidates.length >= 10) break;
  }
  return [...new Set(candidates)];
}

async function zeroZeroCandidatesDirect(fpfNumber) {
  const urls = [
    `${ZEROZERO_BASE}/pesquisa?search_txt=${encodeURIComponent(fpfNumber)}`,
    `${ZEROZERO_BASE}/search.php?search_string=${encodeURIComponent(fpfNumber)}`
  ];
  const candidates = [];
  for (const url of urls) {
    for (const jina of [false, true]) {
      try {
        const page = await fetchText(url, { timeoutMs: 7000, jina });
        candidates.push(...extractUrls(page, 'www.zerozero.pt', /\/equipa(?:\.php)?\//i));
        if (candidates.length) break;
      } catch {}
    }
  }
  return [...new Set(candidates)];
}

async function fetchZeroZeroPage(url) {
  for (const jina of [false, true]) {
    try {
      const page = await fetchText(url, { timeoutMs: jina ? 9000 : 7000, jina });
      return { page, jina };
    } catch {}
  }
  return null;
}

async function findZeroZero(fpfNumber, fpfName) {
  let candidates = await zeroZeroCandidatesDirect(fpfNumber);
  if (!candidates.length) candidates = await zeroZeroCandidatesByNumber(fpfNumber, fpfName);

  for (const pageUrl of candidates.slice(0, 12)) {
    const fetched = await fetchZeroZeroPage(pageUrl);
    if (!fetched) continue;

    const numFpf = extractZeroZeroFpfNumber(fetched.page);
    if (String(numFpf || '') !== String(fpfNumber)) continue;

    const title = extractTitle(fetched.page) || fpfName;
    const nameScore = scoreText(fpfName, title);
    if (nameScore < 250) continue;

    const imageUrl = extractZeroZeroLogo(fetched.page, pageUrl);
    if (!imageUrl) continue;

    return {
      name: title,
      numFpf: String(numFpf),
      pageUrl,
      imageUrl
    };
  }

  throw new Error('ZEROZERO_NUM_FPF_NOT_CONFIRMED');
}

/* =========================================================
   DOWNLOAD / CACHE
   ========================================================= */

function safeFilename(name) {
  return clean(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'escudo';
}

function extensionForMime(mime) {
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  return 'png';
}

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
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

  const names = [team, lookupName(team)];
  for (const name of [...new Set(names.filter(Boolean))]) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
      const path = `public/escudos/${safeFilename(name)}.${ext}`;
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const response = await githubRequest(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
      if (!response?.ok) continue;

      const body = await response.json();
      if (!body?.download_url) continue;

      const image = await fetch(body.download_url, { redirect: 'follow' });
      if (!image.ok) continue;

      const buffer = Buffer.from(await image.arrayBuffer());
      if (!buffer.length) continue;

      return {
        mime: (image.headers.get('content-type') || 'image/png').split(';')[0],
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
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;

  const filename = `${safeFilename(lookupName(team))}.${extensionForMime(mime)}`;
  const path = `public/escudos/${filename}`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');

  const existing = await githubRequest(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
  let sha = null;
  if (existing?.ok) {
    sha = (await existing.json()).sha || null;
  } else if (existing && existing.status !== 404) {
    return null;
  }

  const response = await githubRequest(`/repos/${repo}/contents/${encoded}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Adicionar escudo validado: ${safeFilename(lookupName(team))}`,
      content: buffer.toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    })
  });

  if (!response?.ok) return null;
  const body = await response.json();
  return { path, commit: body.commit?.sha || null };
}

async function downloadImage(url, pageUrl) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Referer: pageUrl,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`ZEROZERO_IMAGE_HTTP_${response.status}`);

  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('ZEROZERO_IMAGE_EMPTY');

  if (!mime.startsWith('image/')) {
    throw new Error('ZEROZERO_IMAGE_INVALID_TYPE');
  }

  return { mime, buffer };
}

/* =========================================================
   RESOLUÇÃO
   ========================================================= */

async function resolveShieldNow(team) {
  const requested = clean(team);
  if (!requested) throw new Error('TEAM_REQUIRED');

  const key = normalize(requested);
  const badUntil = negative.get(key);
  if (badUntil && badUntil > Date.now()) {
    return { ok: false, team: requested, error: 'SHIELD_NOT_FOUND_CACHED' };
  }
  negative.delete(key);

  const cached = await getCachedShield(requested);
  if (cached) {
    const result = {
      ok: true,
      team: requested,
      imageDataUrl: dataUrl(cached.mime, cached.buffer),
      source: 'GitHub cache',
      cached: true,
      saved: true,
      savedPath: cached.path
    };
    memory.set(key, result);
    return result;
  }

  const fpf = await findFpfNumber(requested);
  if (!fpf) throw new Error('FPF_NUMBER_NOT_FOUND');

  const zerozero = await findZeroZero(fpf.number, fpf.name);
  if (String(zerozero.numFpf) !== String(fpf.number)) {
    throw new Error('ZEROZERO_FPF_MISMATCH');
  }

  const image = await downloadImage(zerozero.imageUrl, zerozero.pageUrl);
  const saved = await saveCachedShield(requested, image.mime, image.buffer);

  const result = {
    ok: true,
    team: requested,
    fpfName: fpf.name,
    fpfNumber: fpf.number,
    fpfSource: fpf.source,
    zeroZeroTeam: zerozero.name,
    zeroZeroNumFpf: zerozero.numFpf,
    zeroZeroPage: zerozero.pageUrl,
    zeroZeroImage: zerozero.imageUrl,
    imageDataUrl: dataUrl(image.mime, image.buffer),
    source: 'FPF -> ZeroZero',
    cached: false,
    saved: Boolean(saved),
    savedPath: saved?.path || null
  };

  memory.set(key, result);
  return result;
}

export async function resolveShield(team) {
  const key = normalize(team);
  if (memory.has(key)) return memory.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = resolveShieldNow(team)
    .catch(error => {
      negative.set(key, Date.now() + NEGATIVE_TTL);
      throw error;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

export async function resolveShields(teams = []) {
  const unique = [...new Map(
    teams
      .map(clean)
      .filter(Boolean)
      .map(team => [normalize(team), team])
  ).values()];

  const results = await Promise.all(
    unique.map(async team => {
      try {
        return await resolveShield(team);
      } catch (error) {
        return {
          ok: false,
          team,
          error: error?.message || 'SHIELD_NOT_FOUND'
        };
      }
    })
  );

  return {
    ok: true,
    results,
    summary: {
      total: results.length,
      found: results.filter(x => x.ok).length,
      failed: results.filter(x => !x.ok).length
    }
  };
}
