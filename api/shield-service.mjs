import { Buffer } from 'node:buffer';
import { teamLookupName } from '../shared/team-normalize.mjs';

const FPF_BASE = 'https://resultados.fpf.pt';
const ZEROZERO_BASE = 'https://www.zerozero.pt';
const JINA_SEARCH = 'https://s.jina.ai/';
const JINA_READER = 'https://r.jina.ai/';
const GITHUB_API = 'https://api.github.com';

const ASSOCIATION_IDS = Array.from({ length: 22 }, (_, i) => 219 + i);

const UA =
  process.env.FPF_ZEROZERO_USER_AGENT ||
  'NAF-Marques-Bom/3.0 (+FPF->ZeroZero)';

const memory = new Map();
const inFlight = new Map();
const negative = new Map();

const NEGATIVE_TTL = 5 * 60 * 1000;
let fpfDirectoryPromise = null;

function clean(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value = '') {
  return teamLookupName(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupName(value = '') {
  return teamLookupName(value);
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
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
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
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
        Accept: jina
          ? 'text/plain,text/markdown,text/html,*/*'
          : 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function scoreText(a, b) {
  const x = normalize(a);
  const y = normalize(b);

  if (!x || !y) return -Infinity;
  if (x === y) return 10000;

  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  const common = [...xs].filter(token => ys.has(token)).length;
  const containment = x.includes(y) || y.includes(x) ? 2500 : 0;

  return containment + common * 500 - Math.abs(x.length - y.length);
}

function extractLinks(html, base, predicate) {
  const links = [];
  const re =
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = re.exec(String(html)))) {
    const href = absolute(match[1], base);
    if (!href) continue;

    if (predicate && !predicate(href)) continue;

    links.push({
      href: href.split('#')[0],
      text: htmlText(match[2])
    });
  }

  return [
    ...new Map(
      links.map(item => [item.href, item])
    ).values()
  ];
}

function extractUrls(text, hostname, pathPattern) {
  const urls = [];
  const re = /https?:\/\/[^\s<>"')]+/gi;

  let match;

  while ((match = re.exec(String(text)))) {
    const raw = match[0].replace(/[),.;]+$/, '');

    try {
      const url = new URL(raw);

      if (
        url.hostname !== hostname &&
        !url.hostname.endsWith(`.${hostname}`)
      ) {
        continue;
      }

      if (pathPattern && !pathPattern.test(url.pathname)) {
        continue;
      }

      urls.push(url.href);
    } catch {
      // Ignore malformed URL.
    }
  }

  return [...new Set(urls)];
}

async function searchWeb(query) {
  try {
    return await fetchText(
      `${JINA_SEARCH}${encodeURIComponent(query)}`,
      { timeoutMs: 9000 }
    );
  } catch {
    return '';
  }
}

/* =========================================================
   FPF — diretório oficial de clubes
   ========================================================= */

async function loadFpfAssociation(associationId) {
  const url =
    `${FPF_BASE}/Club/Club?associationId=${associationId}`;

  try {
    const html = await fetchText(url, {
      timeoutMs: 12000
    });

    const links = extractLinks(
      html,
      FPF_BASE,
      href => /\/Club\/Details\?clubId=\d+/i.test(href)
    );

    return links
      .filter(link => link.text)
      .map(link => ({
        name: clean(link.text),
        url: link.href,
        associationId
      }));
  } catch (error) {
    console.warn(
      `FPF associação ${associationId} indisponível:`,
      error?.message || error
    );

    return [];
  }
}

async function getFpfDirectory() {
  if (!fpfDirectoryPromise) {
    fpfDirectoryPromise = Promise.all(
      ASSOCIATION_IDS.map(loadFpfAssociation)
    )
      .then(groups => {
        const unique = new Map();

        for (const group of groups.flat()) {
          const key = group.url;

          if (!unique.has(key)) {
            unique.set(key, group);
          }
        }

        return [...unique.values()];
      })
      .catch(error => {
        fpfDirectoryPromise = null;
        throw error;
      });
  }

  return fpfDirectoryPromise;
}

async function findFpfClub(team) {
  const wanted = lookupName(team);

  // Primeiro tenta pesquisa oficial indexada.
  const search = await searchWeb(
    `site:resultados.fpf.pt/Club/Details "${wanted}"`
  );

  const indexed = extractUrls(
    search,
    'resultados.fpf.pt',
    /\/Club\/Details/i
  );

  const indexedCandidates = indexed.map(url => ({
    name: wanted,
    url,
    score: 10000
  }));

  if (indexedCandidates.length) {
    return indexedCandidates[0];
  }

  // Fallback determinístico: diretório oficial da FPF.
  const directory = await getFpfDirectory();

  const candidates = directory
    .map(club => ({
      ...club,
      score: scoreText(wanted, club.name)
    }))
    .filter(club => club.score >= 2000)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

/* =========================================================
   ZEROZERO — procurar a equipa e o escudo
   ========================================================= */

function extractZeroZeroLogo(text, pageUrl) {
  const urls = [];

  const imageRe =
    /(?:src|data-src|data-lazy-src|content)=["']([^"']+)["']/gi;

  let match;

  while ((match = imageRe.exec(String(text)))) {
    const url = absolute(match[1], pageUrl);
    if (!url) continue;

    if (
      /\/img\/logos\/equipas\//i.test(url) ||
      /logo|escudo|badge|equipa|team/i.test(url)
    ) {
      urls.push(url);
    }
  }

  const metaRe =
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;

  while ((match = metaRe.exec(String(text)))) {
    const url = absolute(match[1], pageUrl);
    if (url) urls.push(url);
  }

  urls.push(
    ...extractUrls(
      text,
      'www.zerozero.pt',
      /./
    )
  );

  const unique = [...new Set(urls)];

  return (
    unique.find(url => /\/img\/logos\/equipas\//i.test(url)) ||
    unique.find(url => /logo|escudo|badge|equipa|team/i.test(url)) ||
    null
  );
}

function extractTitle(text, fallback = '') {
  const h1 =
    String(text).match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i
    );

  if (h1) return htmlText(h1[1]);

  const title =
    String(text).match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  return title ? htmlText(title[1]) : fallback;
}

async function zeroZeroSearch(teamName) {
  const urls = [];

  const directUrl =
    `${ZEROZERO_BASE}/pesquisa?search_txt=${encodeURIComponent(teamName)}`;

  for (const jina of [false, true]) {
    try {
      const html = await fetchText(directUrl, {
        timeoutMs: jina ? 10000 : 8000,
        jina
      });

      urls.push(
        ...extractLinks(
          html,
          ZEROZERO_BASE,
          href => /\/equipa(?:\.php)?\//i.test(href)
        )
      );

      if (urls.length) break;
    } catch {
      // Try next transport.
    }
  }

  if (!urls.length) {
    const search = await searchWeb(
      `site:zerozero.pt/equipa "${teamName}"`
    );

    for (const url of extractUrls(
      search,
      'www.zerozero.pt',
      /\/equipa(?:\.php)?\//i
    )) {
      urls.push({
        href: url,
        text: teamName
      });
    }
  }

  return [
    ...new Map(
      urls.map(item => [item.href, item])
    ).values()
  ];
}

async function findZeroZeroTeam(fpfClub, requestedTeam) {
  const names = [
    fpfClub?.name,
    lookupName(requestedTeam),
    requestedTeam
  ].filter(Boolean);

  const candidates = [];

  for (const name of [...new Set(names)]) {
    const results = await zeroZeroSearch(name);

    candidates.push(
      ...results.map(result => ({
        ...result,
        score: scoreText(
          fpfClub?.name || requestedTeam,
          result.text || name
        )
      }))
    );

    if (candidates.some(item => item.score >= 8000)) {
      break;
    }
  }

  const ranked = [
    ...new Map(
      candidates.map(item => [item.href, item])
    ).values()
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  for (const candidate of ranked) {
    if (candidate.score < 1500) continue;

    try {
      const page = await fetchText(
        candidate.href,
        { timeoutMs: 9000, jina: false }
      );

      const title =
        extractTitle(
          page,
          candidate.text || requestedTeam
        );

      const nameScore = scoreText(
        fpfClub?.name || requestedTeam,
        title
      );

      if (nameScore < 1500) continue;

      const imageUrl =
        extractZeroZeroLogo(
          page,
          candidate.href
        );

      if (!imageUrl) continue;

      return {
        name: title,
        pageUrl: candidate.href,
        imageUrl
      };
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

/* =========================================================
   GitHub cache
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

  return fetch(
    `${GITHUB_API}${path}`,
    {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }
  );
}

async function getCachedShield(team) {
  const repo = process.env.GITHUB_REPO;
  const branch =
    process.env.GITHUB_BRANCH || 'main';

  if (!repo) return null;

  const names = [
    lookupName(team),
    team
  ];

  for (
    const name of
    [...new Set(names.filter(Boolean))]
  ) {
    for (
      const ext of
      ['png', 'jpg', 'jpeg', 'webp', 'svg']
    ) {
      const filePath =
        `public/escudos/${safeFilename(name)}.${ext}`;

      const encoded =
        filePath
          .split('/')
          .map(encodeURIComponent)
          .join('/');

      const response =
        await githubRequest(
          `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`
        );

      if (!response?.ok) continue;

      const body =
        await response.json();

      if (!body?.download_url) continue;

      const image =
        await fetch(
          body.download_url,
          { redirect: 'follow' }
        );

      if (!image.ok) continue;

      const buffer =
        Buffer.from(
          await image.arrayBuffer()
        );

      if (!buffer.length) continue;

      return {
        mime:
          (
            image.headers.get('content-type') ||
            'image/png'
          ).split(';')[0],
        buffer,
        path: filePath
      };
    }
  }

  return null;
}

async function saveCachedShield(team, mime, buffer) {
  const repo = process.env.GITHUB_REPO;
  const branch =
    process.env.GITHUB_BRANCH || 'main';
  const token =
    process.env.GITHUB_TOKEN;

  if (!repo || !token) return null;

  const filename =
    `${safeFilename(lookupName(team))}.${extensionForMime(mime)}`;

  const filePath =
    `public/escudos/${filename}`;

  const encoded =
    filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/');

  const existing =
    await githubRequest(
      `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`
    );

  let sha = null;

  if (existing?.ok) {
    sha =
      (await existing.json()).sha || null;
  } else if (
    existing &&
    existing.status !== 404
  ) {
    return null;
  }

  const response =
    await githubRequest(
      `/repos/${repo}/contents/${encoded}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message:
            `Adicionar escudo validado: ${safeFilename(lookupName(team))}`,
          content:
            buffer.toString('base64'),
          branch,
          ...(sha ? { sha } : {})
        })
      }
    );

  if (!response?.ok) return null;

  const body =
    await response.json();

  return {
    path: filePath,
    commit:
      body.commit?.sha || null
  };
}

/* =========================================================
   Download
   ========================================================= */

async function downloadImage(url, pageUrl) {
  const response =
    await fetch(
      url,
      {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Referer: pageUrl,
          Accept:
            'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `ZEROZERO_IMAGE_HTTP_${response.status}`
    );
  }

  const mime =
    (
      response.headers.get('content-type') ||
      ''
    ).split(';')[0].toLowerCase();

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      'ZEROZERO_IMAGE_EMPTY'
    );
  }

  if (!mime.startsWith('image/')) {
    throw new Error(
      'ZEROZERO_IMAGE_INVALID_TYPE'
    );
  }

  return {
    mime,
    buffer
  };
}

/* =========================================================
   Resolução
   ========================================================= */

async function resolveShieldNow(team) {
  const requested = clean(team);

  if (!requested) {
    throw new Error('TEAM_REQUIRED');
  }

  const key = normalize(requested);

  const badUntil =
    negative.get(key);

  if (
    badUntil &&
    badUntil > Date.now()
  ) {
    return {
      ok: false,
      team: requested,
      error: 'SHIELD_NOT_FOUND_CACHED'
    };
  }

  negative.delete(key);

  const cached =
    await getCachedShield(requested);

  if (cached) {
    const result = {
      ok: true,
      team: requested,
      imageDataUrl:
        dataUrl(
          cached.mime,
          cached.buffer
        ),
      source: 'GitHub cache',
      cached: true,
      saved: true,
      savedPath: cached.path
    };

    memory.set(key, result);
    return result;
  }

  /*
   * FPF é a fonte de identificação.
   * O nome original já passou pela normalização SAD/SDUQ/OAF/SDQ/B.
   */
  const fpf =
    await findFpfClub(requested);

  if (!fpf) {
    throw new Error(
      'FPF_CLUB_NOT_FOUND'
    );
  }

  /*
   * ZeroZero é a fonte principal do escudo.
   * A equipa só é aceite quando o nome coincide
   * suficientemente com a equipa identificada na FPF.
   */
  const zerozero =
    await findZeroZeroTeam(
      fpf,
      requested
    );

  if (!zerozero) {
    throw new Error(
      'ZEROZERO_TEAM_NOT_FOUND'
    );
  }

  const image =
    await downloadImage(
      zerozero.imageUrl,
      zerozero.pageUrl
    );

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
    fpfPage: fpf.url,
    fpfAssociationId:
      fpf.associationId,
    zeroZeroTeam:
      zerozero.name,
    zeroZeroPage:
      zerozero.pageUrl,
    zeroZeroImage:
      zerozero.imageUrl,
    imageDataUrl:
      dataUrl(
        image.mime,
        image.buffer
      ),
    source:
      'FPF -> ZeroZero',
    cached: false,
    saved: Boolean(saved),
    savedPath:
      saved?.path || null
  };

  memory.set(key, result);
  return result;
}

export async function resolveShield(team) {
  const key = normalize(team);

  if (memory.has(key)) {
    return memory.get(key);
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const job =
    resolveShieldNow(team)
      .catch(error => {
        negative.set(
          key,
          Date.now() + NEGATIVE_TTL
        );

        throw error;
      })
      .finally(() => {
        inFlight.delete(key);
      });

  inFlight.set(key, job);

  return job;
}

export async function resolveShields(teams = []) {
  const unique =
    [
      ...new Map(
        teams
          .map(clean)
          .filter(Boolean)
          .map(team => [
            normalize(team),
            team
          ])
      ).values()
    ];

  const results =
    await Promise.all(
      unique.map(
        async team => {
          try {
            return await resolveShield(team);
          } catch (error) {
            return {
              ok: false,
              team,
              error:
                error?.message ||
                'SHIELD_NOT_FOUND'
            };
          }
        }
      )
    );

  return {
    ok: true,
    results,
    summary: {
      total: results.length,
      found:
        results.filter(
          result => result.ok
        ).length,
      failed:
        results.filter(
          result => !result.ok
        ).length
    }
  };
}
