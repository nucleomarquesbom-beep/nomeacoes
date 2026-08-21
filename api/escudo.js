/*
 * Escudos — FPF -> ZeroZero
 *
 * Fluxo obrigatório:
 *   1) recebe o nome da equipa vindo do PDF;
 *   2) procura a equipa na base pública de resultados da FPF;
 *   3) obtém o número/código FPF;
 *   4) pesquisa esse número no ZeroZero;
 *   5) abre as candidatas e valida "Num.FPF" == número FPF;
 *   6) só então descarrega o escudo da página validada;
 *   7) opcionalmente guarda a imagem em public/escudos no GitHub.
 *
 * Não usa TheSportsDB, Wikipedia, Wikidata ou pesquisa genérica de imagens.
 */

const ZEROZERO = 'https://www.zerozero.pt';
const FPF = 'https://resultados.fpf.pt';

const ASSOCIATION_IDS = Array.from(
  { length: 24 },
  (_, i) => 217 + i
);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

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

function compact(value = '') {
  return normalize(value).replace(/\s+/g, '');
}

function cleanName(value = '') {
  return String(value)
    .replace(/\s*\/\s*OAF\b/ig, '')
    .replace(/\bSAD\b/ig, '')
    .replace(/\bSDUQ\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreName(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);

  if (!q || !c) return -Infinity;
  if (q === c) return 10000;
  if (q.includes(c) || c.includes(q)) {
    return 7000 - Math.abs(q.length - c.length);
  }

  const qa = new Set(q.split(' ').filter(Boolean));
  const ca = new Set(c.split(' ').filter(Boolean));
  const common = [...qa].filter(x => ca.has(x)).length;

  return common * 500 - Math.abs(q.length - c.length);
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function decodeHtml(value = '') {
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
  return decodeHtml(
    value.replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
      'User-Agent':
        process.env.FPF_ZEROZERO_USER_AGENT ||
        'Mozilla/5.0 (compatible; Nomeacoes/1.0; +https://github.com/nucleomarquesbom-beep/nomeacoes)',
      ...options.headers
    }
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`ACCESS_DENIED:${response.status}:${url}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP_${response.status}:${url}`);
  }

  return response;
}

function extractLinks(html, base, pattern) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(html))) {
    const href = absoluteUrl(
      decodeHtml(match[1]).replace(/\\\//g, '/'),
      base
    );

    if (!href) continue;
    if (pattern && !pattern.test(href)) continue;

    links.push({
      href,
      text: stripHtml(match[2])
    });
  }

  const unique = new Map();
  for (const item of links) {
    unique.set(item.href.split('#')[0], item);
  }

  return [...unique.values()];
}

function extractFpfNumber(html) {
  const text = stripHtml(html);

  const patterns = [
    /\b(?:n[ºo°]?|n[úu]mero|num\.?|n\.?)\s*(?:fpf|federa[cç][aã]o)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\b(?:fpf|c[oó]digo)\s*(?:n[ºo°]?)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bclub(?:e)?\s*(?:n[ºo°]?|id)\s*[:\-]?\s*(\d{1,6})\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }

  // Some FPF pages expose the code as a field in JSON/HTML attributes.
  const rawPatterns = [
    /["'](?:FpfNumber|FpfNo|FpfCode|ClubCode|Code)["']\s*:\s*["']?(\d{1,6})/i,
    /\b(?:FpfNumber|FpfNo|FpfCode|ClubCode|Code)\s*=\s*["'](\d{1,6})["']/i
  ];

  for (const re of rawPatterns) {
    const m = html.match(re);
    if (m) return m[1];
  }

  return null;
}

function extractFpfClubCandidates(html, base, query) {
  const links = extractLinks(
    html,
    base,
    /resultados\.fpf\.pt\/Club\/Details|\/Club\/Details/i
  );

  return links
    .map(link => ({
      ...link,
      score: scoreName(query, link.text)
    }))
    .filter(x => x.text);
}

async function searchFpfByName(team) {
  const names = [...new Set([
    String(team).trim(),
    cleanName(team)
  ].filter(Boolean))];

  const firstLetters = [...new Set(
    names.map(x => normalize(x).charAt(0).toUpperCase()).filter(Boolean)
  )];

  const candidates = [];
  const requested = new Set();

  /*
   * A página de pesquisa da FPF expõe os clubes por associação e letra.
   * Os IDs são usados apenas para chegar à lista pública de clubes; a
   * correspondência final é feita pelo nome e pelo número extraído.
   */
  for (const associationId of ASSOCIATION_IDS) {
    for (const letter of firstLetters) {
      const key = `${associationId}:${letter}`;
      if (requested.has(key)) continue;
      requested.add(key);

      const url =
        `${FPF}/Club/SearchClubsResultViewModel` +
        `?associationId=${associationId}&letter=${encodeURIComponent(letter)}`;

      try {
        const response = await fetchHtml(url);
        const html = await response.text();

        for (const name of names) {
          candidates.push(
            ...extractFpfClubCandidates(html, FPF, name)
              .map(candidate => ({
                ...candidate,
                associationId
              }))
          );
        }
      } catch (error) {
        // Uma associação indisponível não invalida as outras.
        console.warn(
          '[FPF] associação indisponível',
          associationId,
          letter,
          error?.message || error
        );
      }
    }
  }

  const unique = new Map();

  for (const candidate of candidates) {
    if (!unique.has(candidate.href)) {
      unique.set(candidate.href, candidate);
    }
  }

  const ranked = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (!ranked.length) {
    throw new Error('FPF_TEAM_NOT_FOUND');
  }

  for (const candidate of ranked) {
    try {
      const response = await fetchHtml(candidate.href);
      const html = await response.text();

      const pageName =
        extractPageTitle(html) ||
        candidate.text ||
        team;

      const fpfNumber = extractFpfNumber(html);

      if (!fpfNumber) continue;

      const nameScore = scoreName(team, pageName);

      if (nameScore < 1000) continue;

      return {
        source: 'FPF',
        team: pageName,
        fpfNumber: String(fpfNumber),
        pageUrl: candidate.href,
        score: nameScore
      };
    } catch (error) {
      console.warn(
        '[FPF] falha ao validar candidato',
        candidate.href,
        error?.message || error
      );
    }
  }

  throw new Error('FPF_NUMBER_NOT_FOUND');
}

function extractPageTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripHtml(h1[1]);

  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  if (og) return decodeHtml(og[1]).trim();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripHtml(title[1]) : '';
}

function isZeroZeroTeamUrl(value) {
  try {
    const u = new URL(value);
    return (
      (u.hostname === 'www.zerozero.pt' ||
       u.hostname === 'zerozero.pt') &&
      /^\/equipa\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function extractZeroZeroCandidates(html, query) {
  const links = extractLinks(
    html,
    ZEROZERO,
    /zerozero\.pt\/equipa\//i
  );

  return links
    .filter(x => isZeroZeroTeamUrl(x.href))
    .map(x => ({
      ...x,
      score: scoreName(query, x.text)
    }));
}

function extractZeroZeroFpfNumber(html) {
  const text = stripHtml(html);

  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN[uú]m(?:ero)?\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /["']numFpf["']\s*:\s*["']?(\d{1,6})/i,
    /["']fpfNumber["']\s*:\s*["']?(\d{1,6})/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }

  return null;
}

function extractShieldUrls(html) {
  const urls = [];
  const re = /<img\b[^>]*>/gi;
  let match;

  while ((match = re.exec(html))) {
    const tag = match[0];

    const relevant =
      /(logo|badge|escudo|emblema|equipa|team|club)/i.test(tag);

    if (!relevant) continue;

    for (const raw of [
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1]
        ?.split(',')[0]
        ?.trim()
        ?.split(/\s+/)[0]
    ].filter(Boolean)) {
      const url = absoluteUrl(decodeHtml(raw), ZEROZERO);
      if (url) urls.push(url);
    }
  }

  return [...new Set(urls)].filter(url => {
    try {
      const u = new URL(url);
      return (
        u.hostname.endsWith('zerozero.pt') ||
        u.hostname.endsWith('zerozero.eu')
      );
    } catch {
      return false;
    }
  });
}

async function searchZeroZeroByFpfNumber(fpfNumber, originalTeam) {
  const queries = [
    String(fpfNumber),
    `Num.FPF ${fpfNumber}`
  ];

  const candidates = [];

  for (const query of queries) {
    const url =
      `${ZEROZERO}/pesquisa?search=${encodeURIComponent(query)}`;

    const response = await fetchHtml(url);
    const html = await response.text();

    candidates.push(
      ...extractZeroZeroCandidates(html, originalTeam)
    );
  }

  const unique = new Map();

  for (const candidate of candidates) {
    unique.set(candidate.href, candidate);
  }

  const ranked = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (!ranked.length) {
    throw new Error('ZEROZERO_TEAM_NOT_FOUND');
  }

  for (const candidate of ranked) {
    try {
      const response = await fetchHtml(candidate.href);
      const html = await response.text();

      const numFpf = extractZeroZeroFpfNumber(html);

      /*
       * Regra crítica:
       * sem Num.FPF não aceitamos a equipa.
       * diferente do número FPF também rejeitamos.
       */
      if (!numFpf) continue;
      if (String(numFpf) !== String(fpfNumber)) continue;

      const imageUrls = extractShieldUrls(html);
      if (!imageUrls.length) continue;

      return {
        source: 'ZeroZero',
        team: extractPageTitle(html) || candidate.text || originalTeam,
        fpfNumber: String(fpfNumber),
        zeroZeroNumFpf: String(numFpf),
        pageUrl: candidate.href,
        imageUrl: imageUrls[0]
      };
    } catch (error) {
      console.warn(
        '[ZeroZero] candidato rejeitado',
        candidate.href,
        error?.message || error
      );
    }
  }

  throw new Error('ZEROZERO_NUM_FPF_MISMATCH_OR_SHIELD_NOT_FOUND');
}

async function imageToDataUrl(url) {
  const response = await fetchHtml(url, {
    headers: {
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });

  const contentType =
    (response.headers.get('content-type') || '')
      .split(';')[0]
      .toLowerCase();

  if (!contentType.startsWith('image/')) {
    throw new Error('ZEROZERO_RESPONSE_NOT_IMAGE');
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (!buffer.length) {
    throw new Error('ZEROZERO_EMPTY_IMAGE');
  }

  return {
    dataUrl:
      `data:${contentType};base64,${buffer.toString('base64')}`,
    contentType
  };
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

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

  let extension = match[1].toLowerCase();

  if (extension === 'jpeg') extension = 'jpg';
  if (extension === 'svg+xml') extension = 'svg';

  return {
    extension,
    base64: match[2]
  };
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

  if (!image) {
    return {
      ok: false,
      error: 'Imagem inválida.'
    };
  }

  const filename =
    safeName(team) + '.' + image.extension;

  const path =
    `public/escudos/${filename}`;

  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    `${encodeURIComponent(path).replace(/%2F/g, '/')}`;

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
        error: `GitHub GET falhou (${current.status}).`
      };
    }

    const payload = {
      message:
        `Adicionar/atualizar escudo FPF→ZeroZero: ${filename}`,
      content: image.base64,
      branch,
      ...(sha ? { sha } : {})
    };

    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    const result =
      await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        error:
          result?.message ||
          `GitHub PUT falhou (${response.status}).`
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
      error:
        error?.message ||
        'Erro ao guardar o escudo no GitHub.'
    };
  }
}

async function processTeam(team) {
  try {
    const fpf = await searchFpfByName(team);

    const zeroZero =
      await searchZeroZeroByFpfNumber(
        fpf.fpfNumber,
        team
      );

    const image =
      await imageToDataUrl(zeroZero.imageUrl);

    const saved =
      await saveShieldToGitHub(
        team,
        image.dataUrl
      );

    return {
      ok: true,
      team,
      fpfName: fpf.team,
      fpfNumber: fpf.fpfNumber,
      fpfPage: fpf.pageUrl,
      zeroZeroTeam: zeroZero.team,
      zeroZeroNumFpf: zeroZero.zeroZeroNumFpf,
      zeroZeroPage: zeroZero.pageUrl,
      zeroZeroImage: zeroZero.imageUrl,
      imageDataUrl: image.dataUrl,
      saved: !!saved.ok,
      savedPath: saved.path || null,
      saveError: saved.ok ? null : saved.error
    };
  } catch (error) {
    return {
      ok: false,
      team,
      error: error?.message || 'Erro desconhecido'
    };
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const team = String(req.query?.team || '').trim();

    if (!team) {
      return res.status(400).json({
        ok: false,
        error: 'team obrigatório'
      });
    }

    const result = await processTeam(team);

    if (!result.ok) {
      return res.status(404).json(result);
    }

    return res.status(200).json(result);
  }

  if (req.method === 'POST') {
    const body = parseBody(req);

    /*
     * Mantém compatibilidade com src/escudos-online.js.
     * Também permite que o app envie várias equipas de uma vez.
     */
    const teams = Array.isArray(body.teams)
      ? body.teams
      : body.team
        ? [body.team]
        : [];

    const unique = [
      ...new Set(
        teams
          .map(String)
          .map(x => x.trim())
          .filter(Boolean)
      )
    ];

    if (!unique.length) {
      return res.status(400).json({
        ok: false,
        error: 'teams obrigatório'
      });
    }

    const results = [];

    for (const team of unique) {
      results.push(await processTeam(team));
    }

    return res.status(200).json({
      ok: true,
      results
    });
  }

  return res.status(405).json({
    ok: false,
    error: 'Method not allowed'
  });
}
