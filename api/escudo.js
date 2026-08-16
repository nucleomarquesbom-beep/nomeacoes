const memoryCache = globalThis.__shieldCache || new Map();
globalThis.__shieldCache = memoryCache;

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return clean(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(sad|sduq|futebol clube|futebol|clube)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(title, team) {
  const a = norm(title);
  const b = norm(team);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const words = b.split(' ').filter(Boolean);
  const hit = words.filter(w => a.includes(w)).length;
  return Math.round(50 * hit / Math.max(words.length, 1));
}

function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

export default async function handler(req, res) {
  const team = clean(req.query?.team);
  if (!team) return res.status(400).json({ error: 'Missing team' });

  const cacheKey = norm(team);
  if (memoryCache.has(cacheKey)) {
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json(memoryCache.get(cacheKey));
  }

  try {
    const q = encodeURIComponent(`${team} football logo crest`);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=256&format=json&origin=*`;

    const t1 = timeoutSignal(4000);
    let r;
    try {
      r = await fetch(url, {
        signal: t1.signal,
        headers: { 'User-Agent': 'GeradorNomeacoesMarquesBom/2.0' }
      });
    } finally {
      t1.clear();
    }

    if (!r.ok) return res.status(404).json({ error: 'Shield search unavailable', team });

    const data = await r.json();
    const pages = Object.values(data?.query?.pages || {});
    const candidates = pages
      .map(p => ({
        title: p.title || '',
        url: p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url || '',
        mime: p.imageinfo?.[0]?.thumbmime || p.imageinfo?.[0]?.mime || '',
        score: score(p.title || '', team)
      }))
      .filter(x => x.url && /^image\/(png|jpeg|jpg|webp)$/i.test(x.mime))
      .sort((a, b) => b.score - a.score);

    const chosen = candidates[0];
    if (!chosen || chosen.score < 25) {
      return res.status(404).json({ error: 'No reliable crest found', team });
    }

    const t2 = timeoutSignal(4000);
    let imgResp;
    try {
      imgResp = await fetch(chosen.url, {
        signal: t2.signal,
        headers: { 'User-Agent': 'GeradorNomeacoesMarquesBom/2.0' }
      });
    } finally {
      t2.clear();
    }

    if (!imgResp.ok) return res.status(404).json({ error: 'Image download failed', team });

    const contentType = (imgResp.headers.get('content-type') || chosen.mime || '').toLowerCase();
    const mime = /^image\/(png|jpeg|jpg|webp)$/.test(contentType)
      ? contentType.replace('image/jpg', 'image/jpeg')
      : 'image/png';

    const ab = await imgResp.arrayBuffer();
    const b64 = Buffer.from(ab).toString('base64');
    const result = {
      imageDataUrl: `data:${mime};base64,${b64}`,
      source: `Wikimedia Commons — ${chosen.title}`,
      title: chosen.title
    };

    memoryCache.set(cacheKey, result);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json(result);
  } catch (e) {
    console.error('escudo', team, e);
    return res.status(404).json({ error: 'Shield search timed out or failed', team });
  }
}
