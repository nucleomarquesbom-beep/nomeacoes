import { Buffer } from 'node:buffer';

const FPF_BASE = 'https://resultados.fpf.pt';
const ZEROZERO_BASE = 'https://www.zerozero.pt';
const GITHUB_API = 'https://api.github.com';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

const ASSOCIATION_IDS = Array.from({ length: 22 }, (_, i) => 219 + i);

function clean(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalize(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()\-]/g, ' ')
    .replace(/\b(?:sad|sduq|oaf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreName(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return -Infinity;
  if (x === y) return 10000;
  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  const common = [...xs].filter(v => ys.has(v)).length;
  const containment = x.includes(y) || y.includes(x) ? 2500 : 0;
  return containment + common * 500 - Math.abs(x.length - y.length);
}

function absolute(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

function htmlText(html = '') {
  return String(html)
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

function extractLinks(html, base, matcher) {
  const result = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = absolute(match[1], base);
    if (!href || (matcher && !matcher(href))) continue;
    const text = htmlText(match[2]);
    result.push({ href, text });
  }
  const unique = new Map();
  for (const item of result) unique.set(item.href, item);
  return [...unique.values()];
}

async function fetchText(url, { accept = 'text/html,application/xhtml+xml', timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': process.env.FPF_ZEROZERO_USER_AGENT || DEFAULT_UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
        Accept: accept
      }
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractFpfNumber(html) {
  const text = htmlText(html);
  const patterns = [
    /\bN(?:[ºo°]|úmero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[ºo°]|úmero)?\s*[:\-]?\s*(\d{1,6})\s+F\.?\s*P\.?\s*F\.?\b/i,
    /\bF\.?\s*P\.?\s*F\.?\s*(?:N(?:[ºo°]|úmero)?|Num\.?)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:fpfNumber|numeroFpf|numFpf|fpfNo)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return htmlText(h1[1]);
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? htmlText(title[1]) : '';
}

function extractFpfClubLinks(html, base) {
  return extractLinks(
    html,
    base,
    href => /\/Club\/Details\?clubId=\d+/i.test(href)
  );
}

let fpfDirectoryPromise = null;

async function buildFpfDirectory() {
  const candidates = [];
  const results = await Promise.all(ASSOCIATION_IDS.map(async associationId => {
    try {
      const url = `${FPF_BASE}/Club/Club?associationId=${associationId}`;
      const html = await fetchText(url, { timeoutMs: 9000 });
      return extractLinks(html, FPF_BASE, href => /\/Club\/Details\?clubId=\d+/i.test(href));
    } catch {
      return [];
    }
  }));
  for (const links of results) candidates.push(...links);
  const unique = new Map();
  for (const item of candidates) unique.set(item.href, item);
  return [...unique.values()];
}

async function getFpfDirectory() {
  if (!fpfDirectoryPromise) {
    fpfDirectoryPromise = buildFpfDirectory().catch(error => {
      fpfDirectoryPromise = null;
      throw error;
    });
  }
  return fpfDirectoryPromise;
}

async function searchFpf(team) {
  const wanted = clean(team);
  const candidates = [];

  const directory = await getFpfDirectory();
  for (const link of directory) {
    const score = scoreName(wanted, link.text);
    if (score > 0) candidates.push({ ...link, score });
  }

  // The public FPF directory is organised by association. The query UI is
  // client-rendered, so crawling the official directory pages is more stable
  // than guessing its internal AJAX endpoint.
  for (const associationId of ASSOCIATION_IDS) {
    try {
      const url = `${FPF_BASE}/Club/Club?associationId=${associationId}`;
      const html = await fetchText(url, { timeoutMs: 9000 });
      for (const link of extractFpfClubLinks(html, FPF_BASE)) {
        const score = scoreName(wanted, link.text);
        if (score > 0) candidates.push({ ...link, score });
      }
    } catch {
      // An association can be temporarily unavailable. Continue with the others.
    }
  }

  const unique = new Map();
  for (const item of candidates) {
    const key = `${item.href}|${normalize(item.text)}`;
    const previous = unique.get(key);
    if (!previous || previous.score < item.score) unique.set(key, item);
  }

  const ranked = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  for (const candidate of ranked) {
    try {
      const html = await fetchText(candidate.href, { timeoutMs: 9000 });
      const number = extractFpfNumber(html);
      if (!number) continue;
      const name = extractTitle(html) || candidate.text;
      if (scoreName(wanted, name) < 1000) continue;
      return {
        name,
        fpfNumber: String(number),
        url: candidate.href
      };
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('FPF_NUMBER_NOT_FOUND');
}

function extractZeroZeroLogo(html, base) {
  const urls = [];
  const patterns = [
    /(?:src|data-src|data-lazy-src|content)=["']([^"']*\/img\/logos\/equipas\/[^"']+)["']/gi,
    /(https?:\/\/[^"'<>\s]+\/img\/logos\/equipas\/[^"'<>\s]+)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) urls.push(match[1]);
  }
  return [...new Set(urls.map(url => absolute(url, base)).filter(Boolean))][0] || null;
}

function extractZeroZeroFpfNumber(html) {
  const text = htmlText(html);
  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[úu]mero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:numFpf|fpfNumber)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function searchZeroZero(fpfNumber, fpfName) {
  const searchUrl = `${ZEROZERO_BASE}/pesquisa?search_txt=${encodeURIComponent(String(fpfNumber))}`;
  const html = await fetchText(searchUrl, { timeoutMs: 15000 });
  const candidates = extractLinks(
    html,
    ZEROZERO_BASE,
    href => /\/equipa\//i.test(new URL(href).pathname)
  )
    .map(item => ({ ...item, score: scoreName(fpfName, item.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  for (const candidate of candidates) {
    try {
      const page = await fetchText(candidate.href, { timeoutMs: 12000 });
      const numFpf = extractZeroZeroFpfNumber(page);
      if (String(numFpf || '') !== String(fpfNumber)) continue;
      const logoUrl = extractZeroZeroLogo(page, candidate.href);
      if (!logoUrl) continue;
      return {
        name: extractTitle(page) || candidate.text || fpfName,
        numFpf: String(numFpf),
        pageUrl: candidate.href,
        imageUrl: logoUrl
      };
    } catch {
      // Continue through candidate pages.
    }
  }

  throw new Error('ZEROZERO_NUM_FPF_NOT_CONFIRMED');
}

function safeFilename(name) {
  return clean(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'escudo';
}

function teamVariants(team) {
  const raw = clean(team);
  return [...new Set([
    raw,
    raw.replace(/\s*\/\s*OAF\b/ig, '').replace(/\bSAD\b/ig, '').replace(/\bSDUQ\b/ig, '').replace(/\s+/g, ' ').trim(),
    raw.replace(/\bSAD\b/ig, '').replace(/\bSDUQ\b/ig, '').replace(/\bOAF\b/ig, '').replace(/\s+/g, ' ').trim(),
    raw.replace(/[,.]/g, '').replace(/\s+/g, ' ').trim()
  ])].filter(Boolean);
}

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function downloadImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': process.env.FPF_ZEROZERO_USER_AGENT || DEFAULT_UA,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`ZEROZERO_IMAGE_HTTP_${response.status}`);
  const type = (response.headers.get('content-type') || 'image/png').split(';')[0].toLowerCase();
  if (!type.startsWith('image/')) throw new Error('ZEROZERO_IMAGE_INVALID_TYPE');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('ZEROZERO_IMAGE_EMPTY');
  return { mime: type, buffer };
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return response;
}

function extForMime(mime) {
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  return 'png';
}

async function getCachedShield(team) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!repo) return null;

  const candidates = [];
  for (const variant of teamVariants(team)) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
      candidates.push(`${safeFilename(variant)}.${ext}`);
    }
  }

  for (const filename of [...new Set(candidates)]) {
    const encodedPath = `public/escudos/${filename.split('/').map(encodeURIComponent).join('/')}`;
    const response = await githubRequest(`/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
    if (!response || !response.ok) continue;
    const body = await response.json();
    if (!body?.download_url) continue;

    const image = await fetch(body.download_url, { redirect: 'follow' });
    if (!image.ok) continue;
    const mime = (image.headers.get('content-type') || 'image/png').split(';')[0];
    const buffer = Buffer.from(await image.arrayBuffer());
    if (buffer.length) return { mime, buffer, cached: true, path: `public/escudos/${filename}` };
  }
  return null;
}

async function saveCachedShield(team, mime, buffer) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!repo || !process.env.GITHUB_TOKEN) return null;

  const ext = extForMime(mime);
  const filename = `${safeFilename(team)}.${ext}`;
  const path = `public/escudos/${filename}`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const existing = await githubRequest(`/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  let sha = null;
  if (existing?.ok) sha = (await existing.json()).sha || null;
  else if (existing && existing.status !== 404) return null;

  const response = await githubRequest(`/repos/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Atualizar escudo: ${safeFilename(team)}`,
      content: buffer.toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    })
  });
  if (!response?.ok) return null;
  return { path, commit: (await response.json()).commit?.sha || null };
}

export async function resolveShield(team) {
  const requested = clean(team);
  if (!requested) throw new Error('TEAM_REQUIRED');

  const cached = await getCachedShield(requested);
  if (cached) {
    return {
      ok: true,
      team: requested,
      imageDataUrl: dataUrl(cached.mime, cached.buffer),
      source: 'GitHub cache',
      cached: true,
      savedPath: cached.path
    };
  }

  const fpf = await searchFpf(requested);
  const zerozero = await searchZeroZero(fpf.fpfNumber, fpf.name);
  const image = await downloadImage(zerozero.imageUrl);
  const saved = await saveCachedShield(requested, image.mime, image.buffer);

  return {
    ok: true,
    team: requested,
    fpfName: fpf.name,
    fpfNumber: fpf.fpfNumber,
    fpfPage: fpf.url,
    zeroZeroTeam: zerozero.name,
    zeroZeroNumFpf: zerozero.numFpf,
    zeroZeroPage: zerozero.pageUrl,
    zeroZeroImage: zerozero.imageUrl,
    imageDataUrl: dataUrl(image.mime, image.buffer),
    source: 'FPF → ZeroZero',
    cached: false,
    saved: Boolean(saved),
    savedPath: saved?.path || null
  };
}
