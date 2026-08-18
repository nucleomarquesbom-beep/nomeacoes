/*
 * Escudos — fonte oficial de validação: ZeroZero.pt
 *
 * Regras:
 * 1. A aplicação procura primeiro na biblioteca local.
 * 2. Só quando falta o escudo chama esta API.
 * 3. A pesquisa externa é feita exclusivamente no ZeroZero.pt.
 * 4. O resultado é validado pelo nome da equipa e, quando disponível,
 *    pela cidade/associação apresentada pelo ZeroZero.
 * 5. O escudo encontrado é guardado em public/escudos no GitHub.
 */

function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(s = '') {
  return String(s)
    .trim()
    .replace(/\b(?:SAD|SDUQ|OAF)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(name = '') {
  return cleanName(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(s = '') {
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(s = '') {
  return decodeHtml(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function tokens(s = '') {
  const stop = new Set([
    'de','da','do','das','dos','e','a','o',
    'clube','club','futebol','futebolista',
    'sad','sduq','oaf','fc','sc','cd','ac','af',
    'c','f','g','gc','cp'
  ]);

  return normalize(s)
    .split(' ')
    .filter(Boolean)
    .filter(x => !stop.has(x));
}

function score(query, candidate, context = '') {
  const q = normalize(query);
  const c = normalize(candidate);
  const ctx = normalize(context);

  if (!q || !c) return -9999;

  let result = 0;

  if (q === c) result += 1000;
  if (c.includes(q) || q.includes(c)) result += 650;

  const qt = tokens(query);
  const ct = new Set(tokens(candidate));
  const xt = new Set(tokens(context));

  for (const t of qt) {
    if (ct.has(t)) result += 180;
    else if (xt.has(t)) result += 75;
  }

  /*
   * Abreviaturas muito comuns no futebol português:
   * CP, FC, SC, GC, CD, etc. não são suficientes para
   * decidir uma equipa sozinhos.
   */
  if (qt.length && qt.every(t => ct.has(t))) {
    result += 500;
  }

  return result - Math.abs(c.length - q.length);
}

function searchVariants(raw) {
  const cleaned = cleanName(raw);

  return [...new Set([
    String(raw).trim(),
    cleaned,
    cleaned.replace(/\b(?:C\.|C|Clube)\b/gi, ' ').replace(/\s+/g, ' ').trim(),
    cleaned.replace(/\b(?:S\.?A\.?D\.?|SAD|SDUQ|OAF)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  ].filter(Boolean))];
}

function extractTeamCandidates(html) {
  const out = [];
  const seen = new Set();

  /*
   * O ZeroZero apresenta os resultados como links /equipa/...
   * Mantemos também o contexto do bloco para validar cidade,
   * associação e nome oficial.
   */
  const re =
    /<a\b[^>]*href=["'](\/equipa\/[^"'?#]+(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = re.exec(html))) {
    const href = decodeHtml(match[1]);
    const anchorText = stripTags(match[2]);

    if (!anchorText) continue;

    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const before = html.slice(
      Math.max(0, match.index - 900),
      match.index
    );

    const after = html.slice(
      match.index,
      Math.min(html.length, match.index + 1800)
    );

    out.push({
      href: new URL(href, 'https://www.zerozero.pt').href,
      name: anchorText,
      context: stripTags(before + after)
    });
  }

  return out;
}

async function fetchZeroZeroSearch(query) {
  const url =
    'https://www.zerozero.pt/search.php?search_string=' +
    encodeURIComponent(query);

  const r = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)'
    }
  });

  if (!r.ok) return null;

  return await r.text();
}

async function fetchZeroZeroTeam(url) {
  const r = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)'
    }
  });

  if (!r.ok) return null;

  return await r.text();
}

function extractOgImage(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
  ];

  for (const re of patterns) {
    const m = String(html).match(re);
    if (m?.[1]) {
      return decodeHtml(m[1]);
    }
  }

  return null;
}

function extractTeamFacts(html) {
  const text = stripTags(html);

  const city =
    text.match(
      /\b(?:Cidade|Localidade)\s+([A-ZÀ-Ý][^<\n]{2,50})/i
    )?.[1]?.trim() || '';

  const officialName =
    text.match(
      /\bNome\s+([A-ZÀ-Ý][^<\n]{2,100})/i
    )?.[1]?.trim() || '';

  const association =
    text.match(
      /\bAssociação\s+([A-ZÀ-Ý][^<\n]{2,80})/i
    )?.[1]?.trim() || '';

  return {
    text,
    city,
    officialName,
    association
  };
}

function validateCandidate(query, candidate, facts) {
  const baseScore =
    score(
      query,
      candidate.name,
      candidate.context
    );

  const officialScore =
    facts.officialName
      ? score(query, facts.officialName, facts.text)
      : 0;

  const contextScore =
    score(query, '', facts.text);

  const total =
    Math.max(
      baseScore,
      officialScore
    ) + Math.min(250, Math.max(0, contextScore));

  /*
   * Segurança:
   * não aceitamos uma página ZeroZero que não tenha
   * uma correspondência mínima com o nome pesquisado.
   */
  const qTokens = tokens(query);
  const searchable =
    new Set([
      ...tokens(candidate.name),
      ...tokens(facts.officialName),
      ...tokens(candidate.context)
    ]);

  const matches =
    qTokens.filter(t => searchable.has(t)).length;

  if (
    qTokens.length &&
    matches === 0
  ) {
    return -9999;
  }

  return total;
}

async function zeroZero(name) {
  let best = null;

  for (const query of searchVariants(name)) {
    const html = await fetchZeroZeroSearch(query);
    if (!html) continue;

    const candidates =
      extractTeamCandidates(html);

    for (const candidate of candidates.slice(0, 20)) {
      const teamHtml =
        await fetchZeroZeroTeam(candidate.href);

      if (!teamHtml) continue;

      const facts =
        extractTeamFacts(teamHtml);

      const candidateScore =
        validateCandidate(
          name,
          candidate,
          facts
        );

      if (
        !best ||
        candidateScore > best.score
      ) {
        best = {
          score: candidateScore,
          candidate,
          facts,
          teamHtml
        };
      }
    }
  }

  if (!best || best.score < 500) {
    return null;
  }

  const imageUrl =
    extractOgImage(best.teamHtml);

  if (!imageUrl) {
    return null;
  }

  /*
   * O URL da imagem tem de continuar a ser do ZeroZero.
   * Não aceitamos redirecionar a pesquisa para outra fonte.
   */
  const imageHost =
    new URL(
      imageUrl,
      'https://www.zerozero.pt'
    ).hostname;

  if (
    imageHost !== 'www.zerozero.pt' &&
    !imageHost.endsWith('.zerozero.pt')
  ) {
    return null;
  }

  return {
    score: best.score,
    url: new URL(
      imageUrl,
      'https://www.zerozero.pt'
    ).href,
    source: 'ZeroZero.pt',
    team: best.facts.officialName || best.candidate.name,
    zerozeroUrl: best.candidate.href,
    city: best.facts.city || null,
    association: best.facts.association || null
  };
}

async function imageToDataUrl(url) {
  const r = await fetch(url, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*',
      Referer: 'https://www.zerozero.pt/',
      'User-Agent': 'Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)'
    }
  });

  if (!r.ok) return null;

  const type =
    (r.headers.get('content-type') || 'image/png')
      .split(';')[0]
      .toLowerCase();

  if (
    !type.startsWith('image/')
  ) {
    return null;
  }

  const buffer =
    Buffer.from(
      await r.arrayBuffer()
    );

  if (!buffer.length) return null;

  return {
    dataUrl:
      `data:${type};base64,${buffer.toString('base64')}`,
    type
  };
}

function parseBody(req) {
  if (
    req.body &&
    typeof req.body === 'object'
  ) {
    return req.body;
  }

  try {
    return JSON.parse(
      req.body || '{}'
    );
  } catch {
    return {};
  }
}

function parseImageDataUrl(dataUrl) {
  const match =
    String(dataUrl || '')
      .match(
        /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i
      );

  if (!match) return null;

  const ext =
    match[1].toLowerCase() === 'jpeg'
      ? 'jpg'
      : match[1].toLowerCase();

  return {
    extension: ext,
    base64: match[2]
  };
}

async function saveShieldToGitHub(
  team,
  dataUrl
) {
  const token =
    process.env.GITHUB_TOKEN;

  const repo =
    process.env.GITHUB_REPO;

  const branch =
    process.env.GITHUB_BRANCH ||
    'main';

  if (!token || !repo) {
    return {
      ok: false,
      error:
        'GITHUB_TOKEN ou GITHUB_REPO não configurado no Vercel.'
    };
  }

  const image =
    parseImageDataUrl(dataUrl);

  if (!image) {
    return {
      ok: false,
      error: 'Imagem inválida.'
    };
  }

  const filename =
    safeName(team) +
    '.' +
    image.extension;

  const path =
    `public/escudos/${filename}`;

  const apiBase =
    `https://api.github.com/repos/${repo}/contents/` +
    `${encodeURIComponent(path).replace(/%2F/g, '/')}`;

  const headers = {
    Accept:
      'application/vnd.github+json',
    Authorization:
      `Bearer ${token}`,
    'X-GitHub-Api-Version':
      '2022-11-28',
    'Content-Type':
      'application/json'
  };

  try {
    let sha;

    const current =
      await fetch(
        `${apiBase}?ref=${encodeURIComponent(branch)}`,
        { headers }
      );

    if (current.ok) {
      const currentData =
        await current.json();

      sha =
        currentData?.sha;
    } else if (
      current.status !== 404
    ) {
      const detail =
        await current
          .text()
          .catch(() => '');

      return {
        ok: false,
        error:
          `GitHub GET falhou: ${detail.slice(0, 500)}`
      };
    }

    const payload = {
      message:
        `Adicionar escudo: ${filename}`,
      content:
        image.base64,
      branch,
      ...(sha ? { sha } : {})
    };

    const put =
      await fetch(
        apiBase,
        {
          method: 'PUT',
          headers,
          body:
            JSON.stringify(payload)
        }
      );

    const result =
      await put
        .json()
        .catch(() => ({}));

    if (!put.ok) {
      return {
        ok: false,
        error:
          result?.message ||
          `GitHub PUT falhou (${put.status})`
      };
    }

    return {
      ok: true,
      path,
      commit:
        result?.commit?.sha ||
        null
    };

  } catch (error) {
    return {
      ok: false,
      error:
        error?.message ||
        'Erro ao guardar escudo no GitHub.'
    };
  }
}

async function saveShield(
  req,
  res
) {
  const {
    team,
    dataUrl
  } = parseBody(req);

  if (
    !team ||
    !dataUrl
  ) {
    return res
      .status(400)
      .json({
        error:
          'team e dataUrl são obrigatórios.'
      });
  }

  const result =
    await saveShieldToGitHub(
      team,
      dataUrl
    );

  if (!result.ok) {
    return res
      .status(500)
      .json({
        error: result.error
      });
  }

  return res
    .status(200)
    .json({
      ok: true,
      path: result.path,
      url: `/${result.path}`,
      commit: result.commit
    });
}

export default async function handler(
  req,
  res
) {
  if (req.method === 'POST') {
    return saveShield(req, res);
  }

  if (req.method !== 'GET') {
    return res
      .status(405)
      .json({
        error: 'Method not allowed'
      });
  }

  const raw =
    String(
      req.query?.team || ''
    ).trim();

  if (!raw) {
    return res
      .status(400)
      .json({
        error: 'team obrigatório'
      });
  }

  try {
    const result =
      await zeroZero(raw);

    if (!result) {
      return res
        .status(404)
        .json({
          error:
            'Escudo não confirmado no ZeroZero.pt'
        });
    }

    const image =
      await imageToDataUrl(
        result.url
      );

    if (!image) {
      return res
        .status(404)
        .json({
          error:
            'O ZeroZero confirmou a equipa, mas a imagem do escudo não está disponível.'
        });
    }

    const saved =
      await saveShieldToGitHub(
        raw,
        image.dataUrl
      );

    return res
      .status(200)
      .json({
        imageDataUrl:
          image.dataUrl,
        source:
          result.source,
        team:
          result.team,
        zerozeroUrl:
          result.zerozeroUrl,
        city:
          result.city,
        association:
          result.association,
        score:
          result.score,
        saved:
          !!saved.ok,
        savedPath:
          saved.path || null,
        saveError:
          saved.ok
            ? null
            : saved.error
      });

  } catch (error) {
    return res
      .status(500)
      .json({
        error:
          error?.message ||
          'Erro na pesquisa do escudo no ZeroZero.pt'
      });
  }
}
