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
  let value = String(s).trim();
  value = value.replace(/(?:\s+|\/)OAF\s+SDUQ\s*$/i, '');
  value = value.replace(/(?:\s+|\/)(?:SAD|SDUQ|OAF)\s*$/i, '');
  return value.replace(/\s+/g, ' ').trim();
}

function safeName(name = '') {
  return cleanName(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return -9999;
  if (q === c) return 1000;
  if (c.includes(q) || q.includes(c)) return 700 - Math.abs(c.length - q.length);
  const qa = new Set(q.split(' ').filter(Boolean));
  const ca = new Set(c.split(' ').filter(Boolean));
  const common = [...qa].filter(x => ca.has(x)).length;
  return common * 50 - Math.abs(c.length - q.length);
}

async function sportsDb(name) {
  const url = 'https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' + encodeURIComponent(name);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  const data = await r.json();
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  return teams.filter(t => t?.strBadge)
    .map(t => ({ score: score(name, t.strTeam), url: t.strBadge, source: 'TheSportsDB', team: t.strTeam }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

async function wikidata(name) {
  const searchUrl = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' + encodeURIComponent(name) + '&language=pt&uselang=pt&format=json&limit=8';
  const sr = await fetch(searchUrl, { headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' } });
  if (!sr.ok) return null;
  const search = await sr.json();
  const ids = (search.search || []).map(x => x.id).filter(Boolean);
  if (!ids.length) return null;

  const getUrl = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + ids.join('|') + '&props=claims|labels&languages=pt|en&format=json';
  const gr = await fetch(getUrl, { headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' } });
  if (!gr.ok) return null;
  const entities = await gr.json();

  const ranked = [];
  for (const id of ids) {
    const entity = entities?.entities?.[id];
    const claim = entity?.claims?.P154?.[0];
    const fileName = claim?.mainsnak?.datavalue?.value;
    if (!fileName) continue;
    const label = entity?.labels?.pt?.value || entity?.labels?.en?.value || '';
    ranked.push({
      score: score(name, label),
      url: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(String(fileName).replace(/^File:/i, '')),
      source: 'Wikidata/Wikimedia Commons',
      team: label
    });
  }
  return ranked.sort((a, b) => b.score - a.score)[0] || null;
}

async function wikipedia(name) {
  const url = 'https://pt.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(name) + '&gsrnamespace=0&prop=pageimages&piprop=thumbnail&pithumbsize=800&format=json';
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'NAF-Marques-Bom/1.0' } });
  if (!r.ok) return null;
  const data = await r.json();
  const pages = Object.values(data?.query?.pages || {});
  return pages.filter(p => p?.thumbnail?.source)
    .map(p => ({ score: score(name, p.title), url: p.thumbnail.source, source: 'Wikipedia', team: p.title }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

async function imageToDataUrl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'NAF-Marques-Bom/1.0' } });
  if (!r.ok) return null;
  const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
  const buffer = Buffer.from(await r.arrayBuffer());
  return `data:${type};base64,${buffer.toString('base64')}`;
}

async function findShield(raw) {
  const names = [...new Set([String(raw).trim(), cleanName(raw)].filter(Boolean))];
  const results = [];

  for (const name of names) {
    const found = await Promise.allSettled([sportsDb(name), wikidata(name), wikipedia(name)]);
    for (const r of found) {
      if (r.status === 'fulfilled' && r.value?.url) results.push(r.value);
    }
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  if (!best) return null;

  const imageDataUrl = await imageToDataUrl(best.url);
  if (!imageDataUrl) return null;
  return { ...best, imageDataUrl };
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

async function saveShield(req, res) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return res.status(500).json({ error: 'GITHUB_TOKEN ou GITHUB_REPO não configurado no Vercel.' });

  const { team, dataUrl } = parseBody(req);
  if (!team || !dataUrl) return res.status(400).json({ error: 'team e dataUrl são obrigatórios.' });

  const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) return res.status(400).json({ error: 'Imagem inválida.' });

  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const filename = safeName(team) + '.' + ext;
  const path = `public/escudos/${filename}`;
  const apiBase = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };

  try {
    let sha;
    const current = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (current.ok) sha = (await current.json()).sha;
    else if (current.status !== 404) return res.status(current.status).json({ error: `GitHub GET falhou: ${(await current.text()).slice(0, 500)}` });

    const put = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Adicionar escudo: ${filename}`,
        content: match[2],
        branch,
        ...(sha ? { sha } : {})
      })
    });
    const result = await put.json().catch(() => ({}));
    if (!put.ok) return res.status(put.status).json({ error: result?.message || `GitHub PUT falhou (${put.status})` });
    return res.status(200).json({ ok: true, path, url: `/${path}`, commit: result?.commit?.sha || null });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao guardar escudo no GitHub.' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST') return saveShield(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.query?.team || '').trim();
  if (!raw) return res.status(400).json({ error: 'team obrigatório' });

  try {
    const result = await findShield(raw);
    if (!result) return res.status(404).json({ error: 'Escudo não encontrado' });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro na pesquisa do escudo' });
  }
}
