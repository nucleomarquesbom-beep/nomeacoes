import { Buffer } from 'node:buffer';

const FPF_BASE = 'https://resultados.fpf.pt';
const ZEROZERO_BASE = 'https://www.zerozero.pt';
const JINA_SEARCH = 'https://s.jina.ai/';
const JINA_READER = 'https://r.jina.ai/';
const GITHUB_API = 'https://api.github.com';
const UA = process.env.FPF_ZEROZERO_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

/*
 * A página pública da FPF lista 22 associações.
 * No estado actual do Centro de Resultados, os IDs são 215..236.
 */
const ASSOCIATION_IDS = Array.from({ length: 22 }, (_, i) => 215 + i);

const memory = new Map();
const inFlight = new Map();

let fpfDirectoryPromise = null;
let activeJobs = 0;
const queue = [];
const MAX_CONCURRENT_JOBS = 3;

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

function scoreName(a, b) {
  const x = normalize(a);
  const y = normalize(b);

  if (!x || !y) return -Infinity;
  if (x === y) return 10000;

  const aliasTokens = value => value
    .replace(/\bclube\b/g, 'c')
    .replace(/\bfutebol clube\b/g, 'fc')
    .replace(/\bsporting clube\b/g, 'sc')
    .split(' ')
    .filter(Boolean);

  const xs = new Set(aliasTokens(x));
  const ys = new Set(aliasTokens(y));
  const common = [...xs].filter(token => ys.has(token)).length;
  const containment = x.includes(y) || y.includes(x) ? 2500 : 0;

  return containment + common * 500 - Math.abs(x.length - y.length);
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
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, base, matcher) {
  const result = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(String(html)))) {
    const href = absolute(match[1], base);
    if (!href || (matcher && !matcher(href))) continue;

    result.push({
      href,
      text: htmlText(match[2])
    });
  }

  const unique = new Map();
  for (const item of result) {
    unique.set(item.href, item);
  }

  return [...unique.values()];
}

function extractUrls(text, host, matcher) {
  const result = [];
  const re = /https?:\/\/[^\s<>"')]+/gi;
  let match;

  while ((match = re.exec(String(text)))) {
    const href = match[0].replace(/[),.;]+$/, '');

    try {
      const url = new URL(href);

      if (
        url.hostname !== host &&
        !url.hostname.endsWith(`.${host}`)
      ) {
        continue;
      }

      if (matcher && !matcher(url)) continue;

      result.push(href);
    } catch {}
  }

  return [...new Set(result)];
}

async function fetchText(
  url,
  { timeoutMs = 12000, jina = false } = {}
) {
  const target = jina ? `${JINA_READER}${url}` : url;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

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

function extractTitle(text) {
  const markdown = String(text).match(/^#\s+(.+)$/m);
  if (markdown) return clean(markdown[1]);

  const h1 = String(text).match(
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  );
  if (h1) return htmlText(h1[1]);

  const title = String(text).match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

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
    if (match) {
      return match[1].replace(/^0+(?=\d)/, '');
    }
  }

  return null;
}

/* =========================================================
   FPF
   ========================================================= */

async function buildFpfDirectory() {
  const pages = await Promise.all(
    ASSOCIATION_IDS.map(async associationId => {
      try {
        const url =
          `${FPF_BASE}/Club/Club?associationId=${associationId}`;

        const html = await fetchText(url, {
          timeoutMs: 9000
        });

        return extractLinks(
          html,
          FPF_BASE,
          href =>
            /\/Club\/Details\?clubId=\d+/i.test(href)
        );
      } catch (error) {
        console.warn(
          '[FPF DIRECTORY]',
          associationId,
          error?.message || error
        );
        return [];
      }
    })
  );

  const unique = new Map();

  for (const links of pages) {
    for (const link of links) {
      unique.set(link.href, link);
    }
  }

  const directory = [...unique.values()];

  if (!directory.length) {
    throw new Error('FPF_DIRECTORY_EMPTY');
  }

  return directory;
}

async function getFpfDirectory() {
  if (!fpfDirectoryPromise) {
    fpfDirectoryPromise =
      buildFpfDirectory().catch(error => {
        fpfDirectoryPromise = null;
        throw error;
      });
  }

  return fpfDirectoryPromise;
}

async function searchFpf(team) {
  const wanted = clean(team);
  const directory = await getFpfDirectory();

  const candidates = directory
    .map(link => ({
      ...link,
      score: scoreName(wanted, link.text)
    }))
    .filter(candidate => candidate.score >= 900)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);

  for (const candidate of candidates) {
    try {
      const html = await fetchText(
        candidate.href,
        { timeoutMs: 9000 }
      );

      const number = extractFpfNumber(html);
      if (!number) continue;

      const officialName =
        extractTitle(html) || candidate.text;

      if (scoreName(wanted, officialName) < 900) {
        continue;
      }

      return {
        name: officialName,
        fpfNumber: number,
        url: candidate.href
      };
    } catch {}
  }

  throw new Error('FPF_NUMBER_NOT_FOUND');
}

/* =========================================================
   ZEROZERO
   ========================================================= */

function extractZeroZeroFpfNumber(text) {
  const source = `${text}\n${htmlText(text)}`;

  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[úu]mero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:numFpf|fpfNumber)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);

    if (match) {
      return match[1].replace(/^0+(?=\d)/, '');
    }
  }

  return null;
}

function extractZeroZeroLogo(text, pageUrl) {
  const source = String(text);
  const urls = [];

  /*
   * HTML.
   */
  const attrs =
    source.match(
      /(?:src|data-src|data-lazy-src|content)=["'][^"']+["']/gi
    ) || [];

  for (const attr of attrs) {
    const match =
      attr.match(/=["']([^"']+)["']/);

    if (!match) continue;

    const url =
      absolute(match[1], pageUrl);

    if (
      url &&
      /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)
    ) {
      urls.push(url);
    }
  }

  /*
   * Markdown produzido pelo Jina Reader.
   */
  const markdown =
    /!\[[^\]]*\]\(([^)]+)\)/g;

  let match;

  while ((match = markdown.exec(source))) {
    const url =
      absolute(match[1], pageUrl);

    if (
      url &&
      /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)
    ) {
      urls.push(url);
    }
  }

  /*
   * URLs directas.
   */
  const direct =
    /https?:\/\/[^\s"'<>]+/gi;

  while ((match = direct.exec(source))) {
    const url =
      match[0].replace(/[),.;]+$/, '');

    if (
      /\.(?:png|jpe?g|webp|svg)(?:\?|$)/i.test(url)
    ) {
      urls.push(url);
    }
  }

  const unique =
    [...new Set(urls)];

  return (
    unique.find(url =>
      /zerozero\.pt/i.test(url) &&
      /logo|escudo|equipa|team|badge|equipas/i.test(url)
    ) ||
    unique[0] ||
    null
  );
}

async function directZeroZeroSearch(fpfNumber) {
  const urls = [
    `${ZEROZERO_BASE}/pesquisa?search_txt=${encodeURIComponent(fpfNumber)}`,
    `${ZEROZERO_BASE}/search.php?search_string=${encodeURIComponent(fpfNumber)}`
  ];

  const candidates = [];

  for (const url of urls) {
    try {
      const html =
        await fetchText(url, {
          timeoutMs: 10000
        });

      candidates.push(
        ...extractLinks(
          html,
          ZEROZERO_BASE,
          href =>
            /\/equipa\//i.test(
              new URL(href).pathname
            )
        ).map(item => item.href)
      );
    } catch {}
  }

  return [...new Set(candidates)];
}

async function jinaZeroZeroSearch(
  fpfNumber,
  fpfName
) {
  const queries = [
    `site:zerozero.pt/equipa "Num.FPF ${fpfNumber}"`,
    `site:zerozero.pt/equipa "Num.FPF" "${fpfNumber}"`,
    `site:zerozero.pt/equipa "${fpfNumber}" "${fpfName}"`,
    `site:zerozero.pt/equipa "${fpfName}"`
  ];

  const candidates = [];

  for (const query of queries) {
    try {
      const result =
        await fetchText(
          `${JINA_SEARCH}${encodeURIComponent(query)}`,
          { timeoutMs: 12000 }
        );

      candidates.push(
        ...extractUrls(
          result,
          'www.zerozero.pt',
          url =>
            /\/equipa\//i.test(url.pathname)
        )
      );

      if (candidates.length >= 3) {
        break;
      }
    } catch {}
  }

  return [...new Set(candidates)];
}

async function searchZeroZero(
  fpfNumber,
  fpfName
) {
  const direct =
    await directZeroZeroSearch(
      fpfNumber
    );

  const candidates =
    direct.length
      ? direct
      : await jinaZeroZeroSearch(
          fpfNumber,
          fpfName
        );

  if (!candidates.length) {
    throw new Error(
      'ZEROZERO_TEAM_NOT_FOUND'
    );
  }

  for (const pageUrl of candidates.slice(0, 20)) {
    /*
     * Primeiro tentamos o ZeroZero directamente.
     * Se responder 403/429, usamos o Reader.
     */
    for (const jina of [false, true]) {
      try {
        const page =
          await fetchText(
            pageUrl,
            {
              timeoutMs: jina
                ? 12000
                : 10000,
              jina
            }
          );

        const numFpf =
          extractZeroZeroFpfNumber(page);

        /*
         * REGRA ABSOLUTA:
         *
         * FPF 840
         *    =
         * ZeroZero Num.FPF 840
         *
         * Qualquer outro número é rejeitado.
         */
        if (
          String(numFpf || '') !==
          String(fpfNumber)
        ) {
          continue;
        }

        const logoUrl =
          extractZeroZeroLogo(
            page,
            pageUrl
          );

        if (!logoUrl) continue;

        return {
          name:
            extractTitle(page) ||
            fpfName,

          numFpf:
            String(numFpf),

          pageUrl,
          imageUrl: logoUrl
        };
      } catch {}
    }
  }

  throw new Error(
    'ZEROZERO_NUM_FPF_NOT_CONFIRMED'
  );
}

/* =========================================================
   GITHUB CACHE
   ========================================================= */

function safeFilename(name) {
  return clean(name)
    .replace(
      /[<>:"/\\|?*\u0000-\u001F]/g,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim() || 'escudo';
}

function teamVariants(team) {
  const raw = clean(team);

  return [
    raw,
    raw
      .replace(/\s*\/\s*OAF\b/ig, '')
      .replace(/\b(?:SAD|SDUQ|OAF)\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim(),
    raw
      .replace(/\b(?:SAD|SDUQ|OAF)\b/ig, '')
      .replace(/[,.]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  ].filter(Boolean);
}

async function githubRequest(
  path,
  options = {}
) {
  const token =
    process.env.GITHUB_TOKEN;

  if (!token) return null;

  return fetch(
    `${GITHUB_API}${path}`,
    {
      ...options,
      headers: {
        Accept:
          'application/vnd.github+json',
        Authorization:
          `Bearer ${token}`,
        'X-GitHub-Api-Version':
          '2022-11-28',
        'Content-Type':
          'application/json',
        ...(options.headers || {})
      }
    }
  );
}

function dataUrl(
  mime,
  buffer
) {
  return (
    `data:${mime};base64,` +
    buffer.toString('base64')
  );
}

async function getCachedShield(
  team
) {
  const repo =
    process.env.GITHUB_REPO;

  const branch =
    process.env.GITHUB_BRANCH ||
    'main';

  if (!repo) return null;

  for (
    const name of teamVariants(team)
  ) {
    for (
      const extension of [
        'png',
        'jpg',
        'jpeg',
        'webp',
        'svg'
      ]
    ) {
      const filename =
        `${safeFilename(name)}.${extension}`;

      const path =
        `public/escudos/${filename}`;

      const encoded =
        path
          .split('/')
          .map(encodeURIComponent)
          .join('/');

      const response =
        await githubRequest(
          `/repos/${repo}/contents/${encoded}` +
          `?ref=${encodeURIComponent(branch)}`
        );

      if (!response?.ok) {
        continue;
      }

      const body =
        await response.json();

      if (!body?.download_url) {
        continue;
      }

      const image =
        await fetch(
          body.download_url,
          { redirect: 'follow' }
        );

      if (!image.ok) continue;

      const mime =
        (
          image.headers.get(
            'content-type'
          ) || 'image/png'
        ).split(';')[0];

      const buffer =
        Buffer.from(
          await image.arrayBuffer()
        );

      if (buffer.length) {
        return {
          mime,
          buffer,
          path
        };
      }
    }
  }

  return null;
}

function extensionForMime(
  mime
) {
  if (mime === 'image/svg+xml') {
    return 'svg';
  }

  if (mime === 'image/webp') {
    return 'webp';
  }

  if (
    mime === 'image/jpeg' ||
    mime === 'image/jpg'
  ) {
    return 'jpg';
  }

  return 'png';
}

async function saveCachedShield(
  team,
  mime,
  buffer
) {
  const repo =
    process.env.GITHUB_REPO;

  const branch =
    process.env.GITHUB_BRANCH ||
    'main';

  if (
    !repo ||
    !process.env.GITHUB_TOKEN
  ) {
    return null;
  }

  const filename =
    `${safeFilename(team)}.` +
    extensionForMime(mime);

  const path =
    `public/escudos/${filename}`;

  const encoded =
    path
      .split('/')
      .map(encodeURIComponent)
      .join('/');

  const existing =
    await githubRequest(
      `/repos/${repo}/contents/${encoded}` +
      `?ref=${encodeURIComponent(branch)}`
    );

  let sha = null;

  if (existing?.ok) {
    sha =
      (await existing.json()).sha ||
      null;
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
            `Adicionar escudo validado: ${safeFilename(team)}`,
          content:
            buffer.toString('base64'),
          branch,
          ...(sha ? { sha } : {})
        })
      }
    );

  if (!response?.ok) {
    return null;
  }

  const body =
    await response.json();

  return {
    path,
    commit:
      body.commit?.sha || null
  };
}

/* =========================================================
   RESOLUÇÃO
   ========================================================= */

async function resolveShieldNow(
  team
) {
  const requested =
    clean(team);

  if (!requested) {
    throw new Error(
      'TEAM_REQUIRED'
    );
  }

  const key =
    normalize(requested);

  if (memory.has(key)) {
    return memory.get(key);
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const job =
    (async () => {
      /*
       * 0 — cache permanente.
       */
      const cached =
        await getCachedShield(
          requested
        );

      if (cached) {
        const result = {
          ok: true,
          team: requested,
          imageDataUrl:
            dataUrl(
              cached.mime,
              cached.buffer
            ),
          source:
            'GitHub cache',
          cached: true,
          saved: true,
          savedPath:
            cached.path
        };

        memory.set(
          key,
          result
        );

        return result;
      }

      /*
       * 1 — FPF.
       */
      const fpf =
        await searchFpf(
          requested
        );

      /*
       * 2 — ZeroZero por Num.FPF.
       */
      const zerozero =
        await searchZeroZero(
          fpf.fpfNumber,
          fpf.name
        );

      if (
        String(
          zerozero.numFpf
        ) !==
        String(
          fpf.fpfNumber
        )
      ) {
        throw new Error(
          'ZEROZERO_FPF_MISMATCH'
        );
      }

      /*
       * 3 — download.
       */
      const response =
        await fetch(
          zerozero.imageUrl,
          {
            redirect: 'follow',
            headers: {
              'User-Agent': UA,
              Referer:
                zerozero.pageUrl,
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
          response.headers.get(
            'content-type'
          ) || 'image/png'
        ).split(';')[0]
          .toLowerCase();

      if (
        !mime.startsWith('image/')
      ) {
        throw new Error(
          'ZEROZERO_IMAGE_INVALID_TYPE'
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (!buffer.length) {
        throw new Error(
          'ZEROZERO_IMAGE_EMPTY'
        );
      }

      /*
       * 4 — GitHub.
       */
      const saved =
        await saveCachedShield(
          requested,
          mime,
          buffer
        );

      const result = {
        ok: true,
        team: requested,

        fpfName:
          fpf.name,

        fpfNumber:
          fpf.fpfNumber,

        fpfPage:
          fpf.url,

        zeroZeroTeam:
          zerozero.name,

        zeroZeroNumFpf:
          zerozero.numFpf,

        zeroZeroPage:
          zerozero.pageUrl,

        zeroZeroImage:
          zerozero.imageUrl,

        imageDataUrl:
          dataUrl(
            mime,
            buffer
          ),

        source:
          'FPF -> ZeroZero',

        cached: false,

        saved:
          Boolean(saved),

        savedPath:
          saved?.path ||
          null
      };

      memory.set(
        key,
        result
      );

      return result;
    })().finally(
      () => inFlight.delete(key)
    );

  inFlight.set(
    key,
    job
  );

  return job;
}

function enqueue(
  fn
) {
  return new Promise(
    (resolve, reject) => {
      queue.push({
        fn,
        resolve,
        reject
      });

      drain();
    }
  );
}

function drain() {
  while (
    activeJobs <
      MAX_CONCURRENT_JOBS &&
    queue.length
  ) {
    const item =
      queue.shift();

    activeJobs += 1;

    Promise.resolve()
      .then(item.fn)
      .then(
        item.resolve,
        item.reject
      )
      .finally(() => {
        activeJobs -= 1;
        drain();
      });
  }
}

export async function resolveShield(
  team
) {
  const key =
    normalize(team);

  if (memory.has(key)) {
    return memory.get(key);
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  return enqueue(
    () =>
      resolveShieldNow(team)
  );
}

export async function resolveShields(
  teams = []
) {
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

  const results = [];

  for (
    const team of unique
  ) {
    try {
      results.push(
        await resolveShield(team)
      );
    } catch (error) {
      results.push({
        ok: false,
        team,
        error:
          error?.message ||
          'SHIELD_NOT_FOUND'
      });
    }
  }

  return {
    ok: true,
    results,
    summary: {
      total:
        results.length,
      found:
        results.filter(
          x => x.ok
        ).length,
      failed:
        results.filter(
          x => !x.ok
        ).length
    }
  };
}
