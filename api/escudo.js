export default async function handler(req, res) {
  const team = String(req.query?.team || '').trim();

  if (!team) {
    return res.status(400).json({ error: 'Falta o nome da equipa.' });
  }

  const candidates = buildCandidates(team);

  // Priority:
  // 1. Wikidata logo property (P154)
  // 2. Wikimedia Commons file search
  // 3. Portuguese Wikipedia article image
  // The endpoint is server-side so the browser is not responsible for
  // scraping third-party sites and the application remains usable on Vercel.
  for (const candidate of candidates) {
    const result = await tryWikidata(candidate);
    if (result) return res.status(200).json(result);
  }

  for (const candidate of candidates) {
    const result = await tryCommons(candidate);
    if (result) return res.status(200).json(result);
  }

  for (const candidate of candidates) {
    const result = await tryWikipedia(candidate);
    if (result) return res.status(200).json(result);
  }

  return res.status(404).json({
    error: 'Escudo não encontrado automaticamente.',
    team
  });
}

function normalize(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(sad|sduq|lda|ltda|futebol|football|club|clube)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCandidates(team) {
  const clean = team
    .replace(/\b(SAD|SDUQ|LDA|LTDA)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const base = [
    clean,
    clean.replace(/\bfutebol\b/gi, '').replace(/\bclube\b/gi, '').trim(),
    clean.replace(/\bS\.?C\.?\b/gi, 'Sporting Clube').trim(),
    clean.replace(/\bF\.?C\.?\b/gi, 'Futebol Clube').trim(),
    clean.replace(/\bA\.?C\.?\b/gi, 'Atlético Clube').trim(),
    clean.replace(/\bG\.?D\.?\b/gi, 'Grupo Desportivo').trim(),
    clean.replace(/\bU\.?D\.?\b/gi, 'União Desportiva').trim(),
    clean.replace(/\bA\.?D\.?\b/gi, 'Associação Desportiva').trim()
  ];

  return [...new Set(base.filter(Boolean))];
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'NAF-Marques-Bom-Nomeacoes/1.0'
    }
  });
  if (!r.ok) return null;
  return r.json();
}

async function tryWikidata(team) {
  const q = encodeURIComponent(team);

  const searchUrl =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
    `&search=${q}&language=pt&uselang=pt&format=json&limit=5`;

  const search = await getJson(searchUrl);
  const ids = search?.search?.map(x => x.id) || [];

  for (const id of ids) {
    const data = await getJson(
      `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`
    );

    const claims = data?.entities?.[id]?.claims?.P154;
    const filename = claims?.[0]?.mainsnak?.datavalue?.value;

    if (!filename) continue;

    const imageUrl =
      `https://commons.wikimedia.org/wiki/Special:Redirect/file/` +
      `${encodeURIComponent(filename)}`;

    return {
      imageUrl,
      source: 'Wikimedia Commons / Wikidata',
      sourcePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, '_'))}`
    };
  }

  return null;
}

async function tryCommons(team) {
  const q = encodeURIComponent(`${team} football logo`);

  const url =
    `https://commons.wikimedia.org/w/api.php?action=query` +
    `&generator=search&gsrnamespace=6&gsrlimit=10` +
    `&gsrsearch=${q}` +
    `&prop=imageinfo&iiprop=url|mime&iiurlwidth=800` +
    `&format=json&origin=*`;

  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages || {});

  const ranked = pages
    .filter(p => {
      const mime = p.imageinfo?.[0]?.mime || '';
      return /^image\/(png|jpeg|webp|svg\+xml)$/i.test(mime);
    })
    .map(p => ({
      p,
      score: scoreFile(p.title || '', team)
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  if (!best || best.score < 4) return null;

  const info = best.p.imageinfo?.[0];
  if (!info?.thumburl && !info?.url) return null;

  return {
    imageUrl: info.thumburl || info.url,
    source: 'Wikimedia Commons',
    sourcePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent(best.p.title.replace(/ /g, '_'))}`
  };
}

async function tryWikipedia(team) {
  const q = encodeURIComponent(team);

  const url =
    `https://pt.wikipedia.org/w/api.php?action=query` +
    `&generator=search&gsrsearch=${q}&gsrlimit=5` +
    `&prop=pageimages&piprop=thumbnail|name&pilicense=any` +
    `&pithumbsize=800&format=json&origin=*`;

  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages || {});

  const ranked = pages
    .filter(p => p.thumbnail?.source)
    .map(p => ({
      p,
      score: scoreFile(p.title || '', team)
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  if (!best || best.score < 5) return null;

  return {
    imageUrl: best.p.thumbnail.source,
    source: 'Wikipédia',
    sourcePage: `https://pt.wikipedia.org/wiki/${encodeURIComponent(best.p.title.replace(/ /g, '_'))}`
  };
}

function scoreFile(title, team) {
  const a = normalize(title);
  const b = normalize(team);

  if (!a || !b) return 0;

  const aw = new Set(a.split(' '));
  const bw = b.split(' ');

  let score = 0;
  for (const word of bw) {
    if (word.length >= 3 && aw.has(word)) score += 2;
  }

  if (a.includes(b) || b.includes(a)) score += 5;
  if (/logo|escudo|emblema|badge|crest|coat of arms/i.test(title)) score += 4;

  // Penalise obvious national/competition badges.
  if (/portugal|uefa|fpf|liga|competition|champions/i.test(title)) score -= 3;

  return score;
}
