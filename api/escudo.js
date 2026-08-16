function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()\-]/g, ' ')
    .replace(/\b(sad|sduq|oaf)\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(s = '') {
  return String(s)
    .replace(/(?:\s+|\/)(?:SAD|SDUQ|OAF)\s*$/i, '')
    .trim();
}

function score(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1000;
  if (c === q) return 1000;
  if (c.includes(q) || q.includes(c)) return 700 - Math.abs(c.length - q.length);
  const qa = new Set(q.split(' ').filter(Boolean));
  const ca = new Set(c.split(' ').filter(Boolean));
  const common = [...qa].filter(x => ca.has(x)).length;
  return common * 50 - Math.abs(c.length - q.length);
}

async function sportsDb(name) {
  const url =
    'https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' +
    encodeURIComponent(name);

  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;

  const data = await r.json();
  const teams = Array.isArray(data?.teams) ? data.teams : [];

  const ranked = teams
    .filter(t => t?.strBadge)
    .map(t => ({
      score: score(name, t.strTeam),
      url: t.strBadge,
      source: 'TheSportsDB',
      team: t.strTeam
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

async function wikidata(name) {
  const searchUrl =
    'https://www.wikidata.org/w/api.php?action=wbsearchentities' +
    '&search=' + encodeURIComponent(name) +
    '&language=pt&uselang=pt&format=json&limit=8';

  const sr = await fetch(searchUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' }
  });
  if (!sr.ok) return null;

  const search = await sr.json();
  const ids = (search.search || []).map(x => x.id).filter(Boolean);

  if (!ids.length) return null;

  const getUrl =
    'https://www.wikidata.org/w/api.php?action=wbgetentities' +
    '&ids=' + ids.join('|') +
    '&props=claims|labels' +
    '&languages=pt&format=json';

  const gr = await fetch(getUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' }
  });
  if (!gr.ok) return null;

  const entities = await gr.json();

  for (const id of ids) {
    const entity = entities?.entities?.[id];
    const badgeClaim = entity?.claims?.P154?.[0];
    const fileName = badgeClaim?.mainsnak?.datavalue?.value;

    if (!fileName) continue;

    const label =
      entity?.labels?.pt?.value ||
      entity?.labels?.en?.value ||
      '';

    const scoreValue = score(name, label);

    // P154 is specifically the organisation logo/emblem property.
    if (scoreValue >= 0) {
      return {
        score: scoreValue,
        url:
          'https://commons.wikimedia.org/wiki/Special:FilePath/' +
          encodeURIComponent(String(fileName).replace(/^File:/i, '')),
        source: 'Wikidata/Wikimedia Commons',
        team: label
      };
    }
  }

  return null;
}

async function wikipedia(name) {
  const url =
    'https://pt.wikipedia.org/w/api.php?action=query&generator=search' +
    '&gsrsearch=' + encodeURIComponent(name) +
    '&gsrnamespace=0&prop=pageimages&piprop=thumbnail&pithumbsize=800' +
    '&format=json';

  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' }
  });
  if (!r.ok) return null;

  const data = await r.json();
  const pages = Object.values(data?.query?.pages || {});

  const ranked = pages
    .filter(p => p?.thumbnail?.source)
    .map(p => ({
      score: score(name, p.title),
      url: p.thumbnail.source,
      source: 'Wikipedia',
      team: p.title
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = String(req.query?.team || '').trim();
  if (!raw) return res.status(400).json({ error: 'team obrigatório' });

  const names = [...new Set([raw, cleanName(raw)].filter(Boolean))];

  try {
    const results = [];

    for (const name of names) {
      const [sdb, wd, wiki] = await Promise.allSettled([
        sportsDb(name),
        wikidata(name),
        wikipedia(name)
      ]);

      for (const r of [sdb, wd, wiki]) {
        if (r.status === 'fulfilled' && r.value?.url) {
          results.push(r.value);
        }
      }
    }

    results.sort((a, b) => b.score - a.score);

    if (!results.length) {
      return res.status(404).json({ error: 'Escudo não encontrado' });
    }

    return res.status(200).json({
      url: results[0].url,
      source: results[0].source,
      team: results[0].team
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro na pesquisa do escudo' });
  }
}
