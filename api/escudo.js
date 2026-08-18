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


async function zeroZeroReference(name) {
  let best = null;

  for (const query of searchVariants(name)) {
    const html = await fetchZeroZeroSearch(query);
    if (!html) continue;

    const candidates = extractTeamCandidates(html);

    for (const candidate of candidates.slice(0, 20)) {
      const teamHtml = await fetchZeroZeroTeam(candidate.href);
      if (!teamHtml) continue;

      const facts = extractTeamFacts(teamHtml);
      const candidateScore =
        validateCandidate(name, candidate, facts);

      if (!best || candidateScore > best.score) {
        best = {
          score: candidateScore,
          candidate,
          facts,
          teamHtml
        };
      }
    }
  }

  if (!best || best.score < 500) return null;

  /*
   * O ZeroZero é usado aqui exclusivamente como referência
   * de identidade. A imagem dele NÃO é usada para gerar
   * a publicação.
   */
  return {
    score: best.score,
    team:
      best.facts.officialName ||
      best.candidate.name,
    zerozeroUrl: best.candidate.href,
    city: best.facts.city || null,
    association: best.facts.association || null,
    referenceImageUrl: extractOgImage(best.teamHtml)
  };
}

function sourceScore(query, canonical, candidate, context = '') {
  const a = score(query, candidate, context);
  const b = canonical
    ? score(canonical, candidate, context)
    : 0;

  return Math.max(a, b);
}

async function fetchJson(url, options = {}) {
  try {
    const r = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)',
        ...(options.headers || {})
      }
    });

    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/*
 * TheSportsDB
 * Fonte de imagem, não de validação.
 */
async function searchSportsDB(name, canonical) {
  const queries = searchVariants(name);
  const results = [];

  for (const query of queries) {
    const url =
      'https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' +
      encodeURIComponent(query);

    const data = await fetchJson(url);

    for (const team of data?.teams || []) {
      const candidate =
        team.strTeam ||
        team.strTeamAlternate ||
        '';

      const context = [
        team.strTeamAlternate,
        team.strLeague,
        team.strCountry,
        team.strStadiumLocation
      ].filter(Boolean).join(' ');

      const teamScore =
        sourceScore(
          name,
          canonical,
          candidate,
          context
        );

      const images = [
        ['badge', team.strBadge],
        ['logo', team.strLogo],
        ['poster', team.strPoster]
      ];

      for (const [kind, url] of images) {
        if (
          typeof url === 'string' &&
          /^https?:\/\//i.test(url)
        ) {
          results.push({
            source: `TheSportsDB:${kind}`,
            url,
            team: candidate,
            score: teamScore
          });
        }
      }
    }
  }

  return results;
}

/*
 * Wikidata
 *
 * P154 = logo, que é a propriedade preferida.
 * P18 (imagem) não é usada porque pode ser fotografia do clube.
 */
async function searchWikidata(name, canonical) {
  const queries = [
    canonical,
    ...searchVariants(name)
  ];

  const results = [];
  const seen = new Set();

  for (const query of [...new Set(queries.filter(Boolean))]) {
    const searchUrl =
      'https://www.wikidata.org/w/api.php?' +
      new URLSearchParams({
        action: 'wbsearchentities',
        search: query,
        language: 'pt',
        uselang: 'pt',
        format: 'json',
        limit: '8'
      }).toString();

    const searchData = await fetchJson(searchUrl);

    for (const item of searchData?.search || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);

      const dataUrl =
        'https://www.wikidata.org/w/api.php?' +
        new URLSearchParams({
          action: 'wbgetentities',
          ids: item.id,
          props: 'labels|aliases|claims',
          languages: 'pt|en',
          format: 'json'
        }).toString();

      const entityData = await fetchJson(dataUrl);
      const entity =
        entityData?.entities?.[item.id];

      if (!entity) continue;

      const label =
        entity.labels?.pt?.value ||
        entity.labels?.en?.value ||
        item.label ||
        '';

      const aliases = Object.values(
        entity.aliases || {}
      ).flat().map(x => x.value);

      const context = [
        entity.descriptions?.pt?.value,
        entity.descriptions?.en?.value,
        ...aliases
      ].filter(Boolean).join(' ');

      const teamScore =
        sourceScore(
          name,
          canonical,
          label,
          context
        );

      if (teamScore < 500) continue;

      const logos =
        entity.claims?.P154 || [];

      for (const claim of logos) {
        const file =
          claim?.mainsnak?.datavalue?.value;

        if (!file) continue;

        const title =
          String(file).startsWith('File:')
            ? String(file).slice(5)
            : String(file);

        const commonsUrl =
          'https://commons.wikimedia.org/wiki/Special:Redirect/file/' +
          encodeURIComponent(title);

        results.push({
          source: 'Wikidata P154',
          url: commonsUrl,
          team: label,
          score: teamScore + 80
        });
      }
    }
  }

  return results;
}

/*
 * Wikipedia / MediaWiki PageImages.
 *
 * Procuramos páginas em PT e EN e usamos a imagem principal
 * apenas quando a página corresponde ao clube validado.
 */
async function searchWikipedia(name, canonical) {
  const results = [];
  const seen = new Set();

  for (const lang of ['pt', 'en']) {
    const query =
      canonical || name;

    const searchUrl =
      `https://${lang}.wikipedia.org/w/api.php?` +
      new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: query,
        srnamespace: '0',
        srlimit: '8',
        format: 'json',
        origin: '*'
      }).toString();

    const data =
      await fetchJson(searchUrl);

    for (const item of data?.query?.search || []) {
      const title = item.title;
      const key = `${lang}:${title}`;

      if (seen.has(key)) continue;
      seen.add(key);

      const pageUrl =
        `https://${lang}.wikipedia.org/w/api.php?` +
        new URLSearchParams({
          action: 'query',
          prop: 'pageimages',
          titles: title,
          piprop: 'original|name',
          format: 'json',
          origin: '*'
        }).toString();

      const pageData =
        await fetchJson(pageUrl);

      const pages =
        Object.values(
          pageData?.query?.pages || {}
        );

      const page = pages[0];
      const image =
        page?.original?.source;

      if (!image) continue;

      const teamScore =
        sourceScore(
          name,
          canonical,
          title,
          item.snippet || ''
        );

      if (teamScore < 600) continue;

      results.push({
        source: `Wikipedia ${lang}`,
        url: image,
        team: title,
        score: teamScore
      });
    }
  }

  return results;
}

/*
 * Wikimedia Commons
 *
 * Procuramos ficheiros de escudo/logo e não apenas páginas
 * genéricas. É uma fonte adicional de imagens.
 */
async function searchCommons(name, canonical) {
  const results = [];

  const queries = [
    `${canonical || name} logo`,
    `${canonical || name} crest`,
    `${canonical || name} escudo`
  ];

  for (const query of [...new Set(queries)]) {
    const url =
      'https://commons.wikimedia.org/w/api.php?' +
      new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: '6',
        gsrlimit: '10',
        prop: 'imageinfo',
        iiprop: 'url|mime',
        format: 'json',
        origin: '*'
      }).toString();

    const data =
      await fetchJson(url);

    for (const page of Object.values(
      data?.query?.pages || {}
    )) {
      const image =
        page?.imageinfo?.[0];

      if (!image?.url) continue;

      const mime =
        String(image.mime || '').toLowerCase();

      if (
        !['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg']
          .includes(mime)
      ) {
        continue;
      }

      const teamScore =
        sourceScore(
          name,
          canonical,
          page.title,
          query
        );

      if (teamScore < 500) continue;

      /*
       * Reforço: ficheiros com termos típicos de escudo/logo
       * recebem prioridade.
       */
      const filename =
        normalize(page.title);

      const logoBonus =
        /(logo|crest|escudo|badge|emblem|brasao)/i.test(filename)
          ? 80
          : 0;

      results.push({
        source: 'Wikimedia Commons',
        url: image.url,
        team: page.title,
        score: teamScore + logoBonus
      });
    }
  }

  return results;
}

async function imageToDataUrl(url) {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') {
      return null;
    }

    const r = await fetch(url, {
      headers: {
        Accept:
          'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*',
        Referer:
          'https://www.zerozero.pt/',
        'User-Agent':
          'Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)'
      }
    });

    if (!r.ok) return null;

    const type =
      (r.headers.get('content-type') || '')
        .split(';')[0]
        .toLowerCase();

    if (!type.startsWith('image/')) {
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
      type,
      bytes: buffer.length
    };
  } catch {
    return null;
  }
}

/*
 * ZeroZero é a referência de identidade.
 * As imagens são recolhidas das bases disponíveis e
 * ordenadas pela correspondência com essa referência.
 */
async function findBestShield(name) {
  const reference =
    await zeroZeroReference(name);

  if (!reference) {
    return null;
  }

  const canonical =
    reference.team;

  const settled =
    await Promise.allSettled([
      searchSportsDB(name, canonical),
      searchWikidata(name, canonical),
      searchWikipedia(name, canonical),
      searchCommons(name, canonical)
    ]);

  const candidates =
    settled.flatMap(
      result =>
        result.status === 'fulfilled'
          ? result.value
          : []
    );

  /*
   * Remover URLs duplicados e ordenar pela confiança.
   */
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates.sort(
    (a, b) => b.score - a.score
  )) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  /*
   * Só aceitamos candidatos suficientemente próximos
   * do clube confirmado pelo ZeroZero.
   */
  const acceptable =
    unique.filter(
      candidate => candidate.score >= 580
    );

  for (const candidate of acceptable.slice(0, 12)) {
    const image =
      await imageToDataUrl(candidate.url);

    if (!image) continue;

    return {
      image,
      source: candidate.source,
      team: canonical,
      sourceTeam: candidate.team,
      score: candidate.score,
      zerozeroUrl: reference.zerozeroUrl,
      zerozeroScore: reference.score,
      city: reference.city,
      association: reference.association
    };
  }

  return null;
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
      await findBestShield(raw);

    if (!result) {
      return res
        .status(404)
        .json({
          error:
            'O clube não foi confirmado no ZeroZero.pt ou não foi encontrada uma imagem válida nas bases de dados disponíveis.'
        });
    }

    const saved =
      await saveShieldToGitHub(
        raw,
        result.image.dataUrl
      );

    return res
      .status(200)
      .json({
        imageDataUrl:
          result.image.dataUrl,
        source:
          result.source,
        team:
          result.team,
        sourceTeam:
          result.sourceTeam,
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
    console.error(
      'Erro na pesquisa de escudo:',
      error
    );

    return res
      .status(500)
      .json({
        error:
          error?.message ||
          'Erro na pesquisa do escudo.'
      });
  }
}
