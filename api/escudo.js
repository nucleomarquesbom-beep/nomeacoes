const memoryCache = globalThis.__shieldCache || new Map();
globalThis.__shieldCache = memoryCache;

const UA = 'GeradorNomeacoesMarquesBom/3.0 (+https://github.com/nucleomarquesbom-beep/nomeacoes)';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return clean(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(sad|sduq|futebol clube|futebol|clube|sporting clube|sociedade desportiva)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreName(candidate, team) {
  const a = norm(candidate);
  const b = norm(team);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 88;
  const words = b.split(' ').filter(w => w.length >= 3);
  const hit = words.filter(w => a.includes(w)).length;
  return Math.round(72 * hit / Math.max(words.length, 1));
}

function timeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function fetchJson(url, ms = 3500) {
  const t = timeout(ms);
  try {
    const r = await fetch(url, {
      signal: t.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }
    });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    t.clear();
  }
}

async function fetchText(url, ms = 3500) {
  const t = timeout(ms);
  try {
    const r = await fetch(url, {
      signal: t.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) return null;
    return await r.text();
  } finally {
    t.clear();
  }
}

function absoluteUrl(u, base) {
  if (!u) return '';
  try { return new URL(u, base).href; } catch { return ''; }
}

function isImageUrl(u) {
  return /^https?:\/\//i.test(u || '') && /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(u || '');
}

function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1].replace(/<[^>]+>/g, '')) : '';
}

async function fromWikidata(team) {
  try {
    const q = encodeURIComponent(team);
    const search = await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=pt&uselang=pt&format=json&limit=6`,
      3000
    );
    const hits = (search?.search || [])
      .map(x => ({ id: x.id, label: x.label || '', description: x.description || '' }))
      .filter(x => scoreName(x.label, team) >= 45)
      .sort((a, b) => scoreName(b.label, team) - scoreName(a.label, team));

    for (const hit of hits.slice(0, 4)) {
      const entity = await fetchJson(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(hit.id)}&props=claims|labels&languages=pt|en&format=json`,
        3000
      );
      const claims = entity?.entities?.[hit.id]?.claims || {};
      const logo = claims.P154?.[0]?.mainsnak?.datavalue?.value;
      if (!logo) continue;

      const title = `File:${logo}`;
      const info = await fetchJson(
        `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|mime&iiurlwidth=256&format=json&origin=*`,
        3000
      );
      const page = Object.values(info?.query?.pages || {})[0];
      const ii = page?.imageinfo?.[0];
      const url = ii?.thumburl || ii?.url;
      if (url) return { url, name: hit.label, source: `Wikidata/Wikimedia Commons — ${logo}`, score: Math.min(100, scoreName(hit.label, team) + 8) };
    }
  } catch (e) {
    console.warn('Wikidata shield lookup failed:', team, e?.message || e);
  }
  return null;
}

async function fromWikipedia(team) {
  try {
    const q = encodeURIComponent(`${team} clube futebol Portugal`);
    const data = await fetchJson(
      `https://pt.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=0&gsrlimit=6&prop=pageimages|info&piprop=thumbnail&pilimit=6&pithumbsize=256&format=json&origin=*`,
      3000
    );
    const candidates = Object.values(data?.query?.pages || {})
      .map(p => ({
        title: p.title || '',
        url: p.thumbnail?.source || '',
        score: scoreName(p.title || '', team)
      }))
      .filter(x => x.url && x.score >= 45)
      .sort((a, b) => b.score - a.score);
    const c = candidates[0];
    return c ? { url: c.url, name: c.title, source: `Wikipedia — ${c.title}`, score: c.score } : null;
  } catch (e) {
    console.warn('Wikipedia shield lookup failed:', team, e?.message || e);
    return null;
  }
}

async function fromZeroZero(team) {
  try {
    const q = encodeURIComponent(team);
    const searchUrl = `https://www.zerozero.pt/search.php?search_string=${q}`;
    const html = await fetchText(searchUrl, 3500);
    if (!html) return null;

    const links = [];
    const re = /<a[^>]+href=["'](?:https?:\/\/www\.zerozero\.pt)?\/team\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && links.length < 12) {
      const label = clean(m[2].replace(/<[^>]+>/g, ''));
      if (!label) continue;
      links.push({ id: m[1], label, score: scoreName(label, team) });
    }

    links.sort((a, b) => b.score - a.score);
    const best = links.find(x => x.score >= 50);
    if (!best) return null;

    const page = await fetchText(`https://www.zerozero.pt/team.php?id=${best.id}`, 3500);
    if (!page) return null;

    const metas = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    ];

    for (const rx of metas) {
      const hit = page.match(rx);
      const url = absoluteUrl(hit?.[1], 'https://www.zerozero.pt/');
      if (url) return { url, name: best.label, source: `zerozero.pt — ${best.label}`, score: Math.min(100, best.score + 5) };
    }

    // Last resort: look for an image URL in the page that contains logo/escudo/badge.
    const imgs = [...page.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)]
      .map(x => absoluteUrl(x[1], 'https://www.zerozero.pt/'))
      .filter(isImageUrl);
    const likely = imgs.find(u => /logo|escudo|badge|equipa|team/i.test(u));
    if (likely) return { url: likely, name: best.label, source: `zerozero.pt — ${best.label}`, score: best.score };
  } catch (e) {
    console.warn('zerozero shield lookup failed:', team, e?.message || e);
  }
  return null;
}

async function fromCommons(team) {
  try {
    const q = encodeURIComponent(`${team} football logo crest`);
    const data = await fetchJson(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime&iiurlwidth=256&format=json&origin=*`,
      3500
    );
    const candidates = Object.values(data?.query?.pages || {})
      .map(p => ({
        title: p.title || '',
        url: p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url || '',
        mime: p.imageinfo?.[0]?.thumbmime || p.imageinfo?.[0]?.mime || '',
        score: scoreName(p.title || '', team)
      }))
      .filter(x => x.url && /^image\/(png|jpeg|jpg|webp)$/i.test(x.mime) && x.score >= 35)
      .sort((a, b) => b.score - a.score);
    const c = candidates[0];
    return c ? { url: c.url, name: c.title, source: `Wikimedia Commons — ${c.title}`, score: c.score } : null;
  } catch (e) {
    console.warn('Commons shield lookup failed:', team, e?.message || e);
    return null;
  }
}

async function downloadAsDataUrl(candidate) {
  if (!candidate?.url) return null;
  const t = timeout(3500);
  try {
    const r = await fetch(candidate.url, { signal: t.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || 'image/png').toLowerCase().split(';')[0];
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(type)) return null;
    const ab = await r.arrayBuffer();
    const mime = type === 'image/jpg' ? 'image/jpeg' : type;
    return `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
  } finally {
    t.clear();
  }
}

async function resolveOnline(team) {
  // Independent sources run concurrently so a slow source does not make the
  // total lookup equal to the sum of all source times.
  const results = await Promise.allSettled([
    fromWikidata(team),
    fromWikipedia(team),
    fromZeroZero(team),
    fromCommons(team)
  ]);

  const candidates = results
    .filter(r => r.status === 'fulfilled' && r.value?.url)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);

  // Try the strongest candidates first. If an image server blocks a download,
  // the next source can still succeed.
  for (const c of candidates.slice(0, 4)) {
    const imageDataUrl = await downloadAsDataUrl(c);
    if (imageDataUrl) return { imageDataUrl, source: c.source, title: c.name };
  }
  return null;
}

export default async function handler(req, res) {
  const team = clean(req.query?.team);
  if (!team) return res.status(400).json({ error: 'Missing team' });

  const cacheKey = norm(team);
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json(cached);
  }

  try {
    const result = await Promise.race([
      resolveOnline(team),
      new Promise(resolve => setTimeout(() => resolve(null), 7500))
    ]);

    if (!result) {
      return res.status(404).json({ error: 'No reliable online crest found', team });
    }

    memoryCache.set(cacheKey, result);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json(result);
  } catch (e) {
    console.error('escudo', team, e);
    return res.status(404).json({ error: 'Online crest search failed', team });
  }
}
