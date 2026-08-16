const memoryCache = globalThis.__shieldCache || new Map();
globalThis.__shieldCache = memoryCache;

const UA = 'GeradorNomeacoesMarquesBom/3.0 (+https://github.com/nucleomarquesbom-beep/nomeacoes)';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripLegalSuffixes(s) {
  const value = clean(s);

  // IMPORTANT:
  // Remove SAD/SDUQ only when they are the final legal suffix of the club.
  // Do NOT remove SC, FC, CP, C., OAF, Futebol, Clube, etc.
  return value
    .replace(/\s+(?:S\.?\s*A\.?\s*D\.?|S\.?\s*D\.?\s*U\.?\s*Q\.?)$/i, '')
    .trim();
}

function baseClubName(s) {
  return stripLegalSuffixes(s);
}

function norm(s) {
  return baseClubName(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function variants(team) {
  const original = clean(team);
  const base = baseClubName(original);
  const values = [original];

  // Only add the shortened form when SAD/SDUQ is actually present at the end.
  if (base !== original) values.push(base);

  // Small spelling variants, without deleting club designations.
  values.push(
    base.replace(/\bAtlético\b/gi, 'Atletico'),
    base.replace(/\bAcadémica\b/gi, 'Academica'),
    base.replace(/\bSão\b/gi, 'Sao')
  );

  return [...new Set(values.map(clean).filter(Boolean))];
}

function tokenSimilarity(a, b) {
  const aa = norm(a).split(' ').filter(w => w.length >= 2);
  const bb = norm(b).split(' ').filter(w => w.length >= 2);
  if (!aa.length || !bb.length) return 0;

  const setA = new Set(aa);
  const setB = new Set(bb);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;

  const coverageA = common / setA.size;
  const coverageB = common / setB.size;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = common / Math.max(union, 1);

  return Math.round(
    100 * Math.max(
      coverageA * 0.78 + coverageB * 0.22,
      jaccard
    )
  );
}

function scoreName(candidate, team) {
  const a = norm(candidate);
  const b = norm(team);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 94;

  const sim = tokenSimilarity(candidate, team);
  const base = baseClubName(team);
  const candBase = baseClubName(candidate);

  // Reward a strong match after legal suffixes are removed.
  if (norm(candBase) === norm(base)) return 100;

  return sim;
}

function searchQueries(team, suffix = '') {
  return variants(team)
    .slice(0, 5)
    .map(v => suffix ? `${v} ${suffix}`.trim() : v);
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


function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractLinksFromSearchHtml(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    let href = decodeHtml(m[1]);
    const title = clean(m[2].replace(/<[^>]+>/g, ' '));
    if (!href || !title) continue;

    // DuckDuckGo sometimes wraps links in /l/?uddg=...
    try {
      if (/^https?:\/\/duckduckgo\.com\/l\//i.test(href)) {
        const u = new URL(href);
        href = u.searchParams.get('uddg') || href;
      }
    } catch {}

    if (!/^https?:\/\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title });
    if (out.length >= 10) break;
  }
  return out;
}

function socialOrOfficialScore(url, title, team) {
  const u = String(url || '').toLowerCase();
  let score = scoreName(title, team);
  if (/facebook\.com|instagram\.com/.test(u)) score += 8;
  if (/zerozero\.pt/.test(u)) score += 7;
  if (/fpf\.pt/.test(u)) score += 7;
  if (/wikipedia\.org|wikimedia\.org|wikidata\.org/.test(u)) score += 5;
  if (/\.pt\b/.test(u)) score += 2;
  return Math.min(100, score);
}

async function searchDuckDuckGo(query) {
  const q = encodeURIComponent(query);
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${q}`,
    2500
  );
  return extractLinksFromSearchHtml(html || '');
}

function extractPageImage(html, baseUrl) {
  if (!html) return null;

  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i
  ];

  for (const rx of patterns) {
    const m = html.match(rx);
    const url = absoluteUrl(decodeHtml(m?.[1] || ''), baseUrl);
    if (isImageUrl(url)) return url;
  }

  // Last resort: inspect a small number of image tags and prefer crest/logo/badge files.
  const imgs = [...html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)]
    .map(m => absoluteUrl(decodeHtml(m[1]), baseUrl))
    .filter(isImageUrl);

  return imgs.find(u => /logo|escudo|badge|crest|emblema|simbolo/i.test(u)) || null;
}

async function fromWebSearch(team) {
  try {
    const qs = [];
    for (const v of variants(team).slice(0, 3)) {
      qs.push(`"${v}" futebol escudo`);
      qs.push(`"${v}" clube Portugal`);
      qs.push(`site:facebook.com "${v}"`);
      qs.push(`site:instagram.com "${v}"`);
    }

    const searchResults = await Promise.allSettled(qs.map(searchDuckDuckGo));
    const links = [];
    const seen = new Set();

    for (const r of searchResults) {
      if (r.status !== 'fulfilled') continue;
      for (const x of r.value) {
        if (seen.has(x.href)) continue;
        seen.add(x.href);
        links.push(x);
      }
    }

    const likely = links
      .filter(x => !/google\.|duckduckgo\.|bing\.com|youtube\.com/i.test(x.href))
      .map(x => ({ ...x, score: socialOrOfficialScore(x.href, x.title, team) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const pages = await Promise.allSettled(likely.map(async x => {
      const html = await fetchText(x.href, 2200);
      const image = extractPageImage(html, x.href);
      if (!image) return null;
      return {
        url: image,
        name: x.title,
        source: `Pesquisa web — ${x.href}`,
        score: Math.min(100, x.score + 3)
      };
    }));

    const candidates = pages
      .filter(r => r.status === 'fulfilled' && r.value?.url)
      .map(r => r.value)
      .sort((a, b) => b.score - a.score);

    return candidates[0] || null;
  } catch (e) {
    console.warn('Web/social shield lookup failed:', team, e?.message || e);
    return null;
  }
}


async function fromSportsDB(team) {
  try {
    const results = [];
    for (const query of variants(team).slice(0, 4)) {
      const url = `https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=${encodeURIComponent(query)}`;
      const data = await fetchJson(url, 2200);
      for (const t of (data?.teams || [])) {
        const badge = t.strBadge || t.strLogo || t.strTeamBadge;
        if (!badge) continue;
        const score = scoreName(t.strTeam || '', team) +
          (/Portugal/i.test(t.strCountry || '') ? 8 : 0) +
          (/Soccer|Football/i.test(t.strSport || '') ? 4 : 0);
        results.push({
          url: badge,
          name: t.strTeam || '',
          source: `TheSportsDB — ${t.strTeam || ''}`,
          score: Math.min(100, score)
        });
      }
    }
    results.sort((a,b)=>b.score-a.score);
    return results.find(x => x.score >= 55) || null;
  } catch (e) {
    console.warn('TheSportsDB shield lookup failed:', team, e?.message || e);
    return null;
  }
}

async function fromWikidata(team) {
  try {
    const hitsMap = new Map();

    for (const query of searchQueries(team)) {
      const q = encodeURIComponent(query);
      const search = await fetchJson(
        `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=pt&uselang=pt&format=json&limit=8`,
        2500
      );

      for (const x of (search?.search || [])) {
        if (!x.id) continue;
        const hit = {
          id: x.id,
          label: x.label || '',
          description: x.description || ''
        };
        const score = scoreName(hit.label, team);
        if (score >= 45) hitsMap.set(hit.id, { ...hit, score });
      }
    }

    const hits = [...hitsMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    for (const hit of hits) {
      const entity = await fetchJson(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(hit.id)}&props=claims|labels&languages=pt|en&format=json`,
        2500
      );
      const claims = entity?.entities?.[hit.id]?.claims || {};
      const logo = claims.P154?.[0]?.mainsnak?.datavalue?.value;
      if (!logo) continue;

      const title = `File:${logo}`;
      const info = await fetchJson(
        `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|mime&iiurlwidth=256&format=json&origin=*`,
        2500
      );
      const page = Object.values(info?.query?.pages || {})[0];
      const ii = page?.imageinfo?.[0];
      const url = ii?.thumburl || ii?.url;
      if (url) {
        return {
          url,
          name: hit.label,
          source: `Wikidata/Wikimedia Commons — ${logo}`,
          score: Math.min(100, hit.score + 8)
        };
      }
    }
  } catch (e) {
    console.warn('Wikidata shield lookup failed:', team, e?.message || e);
  }
  return null;
}

async function fromWikipedia(team) {
  try {
    const candidatesMap = new Map();

    for (const query of searchQueries(team, 'clube futebol Portugal')) {
      const q = encodeURIComponent(query);
      const data = await fetchJson(
        `https://pt.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=0&gsrlimit=8&prop=pageimages|info&piprop=thumbnail&pilimit=8&pithumbsize=256&format=json&origin=*`,
        2500
      );

      for (const p of Object.values(data?.query?.pages || {})) {
        const score = scoreName(p.title || '', team);
        if (p.thumbnail?.source && score >= 42) {
          const key = p.pageid || p.title;
          candidatesMap.set(key, {
            title: p.title || '',
            url: p.thumbnail.source,
            score
          });
        }
      }
    }

    const candidates = [...candidatesMap.values()]
      .sort((a, b) => b.score - a.score);

    const c = candidates[0];
    return c
      ? { url: c.url, name: c.title, source: `Wikipedia — ${c.title}`, score: c.score }
      : null;
  } catch (e) {
    console.warn('Wikipedia shield lookup failed:', team, e?.message || e);
    return null;
  }
}

async function fromZeroZero(team) {
  try {
    const all = [];

    for (const query of searchQueries(team)) {
      const q = encodeURIComponent(query);
      const html = await fetchText(
        `https://www.zerozero.pt/search.php?search_string=${q}`,
        3000
      );
      if (!html) continue;

      const re = /<a[^>]+href=["'](?:https?:\/\/(?:www\.)?zerozero\.pt)?\/team\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;

      while ((m = re.exec(html))) {
        const label = clean(m[2].replace(/<[^>]+>/g, ''));
        if (!label) continue;

        all.push({
          id: m[1],
          label,
          score: scoreName(label, team)
        });

        if (all.length >= 30) break;
      }
    }

    const unique = [...new Map(all.map(x => [x.id, x])).values()]
      .sort((a, b) => b.score - a.score);

    const best = unique.find(x => x.score >= 48);
    if (!best) return null;

    const page = await fetchText(
      `https://www.zerozero.pt/team.php?id=${best.id}`,
      3000
    );
    if (!page) return null;

    const metas = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    ];

    for (const rx of metas) {
      const hit = page.match(rx);
      const url = absoluteUrl(hit?.[1], 'https://www.zerozero.pt/');
      if (url) {
        return {
          url,
          name: best.label,
          source: `zerozero.pt — ${best.label}`,
          score: Math.min(100, best.score + 7)
        };
      }
    }

    const imgs = [...page.matchAll(
      /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi
    )]
      .map(x => absoluteUrl(x[1], 'https://www.zerozero.pt/'))
      .filter(isImageUrl);

    const likely = imgs.find(u =>
      /logo|escudo|badge|equipa|team|clube|crest/i.test(u)
    );

    if (likely) {
      return {
        url: likely,
        name: best.label,
        source: `zerozero.pt — ${best.label}`,
        score: best.score
      };
    }
  } catch (e) {
    console.warn('zerozero shield lookup failed:', team, e?.message || e);
  }
  return null;
}

async function fromCommons(team) {
  try {
    const candidatesMap = new Map();

    for (const query of searchQueries(team, 'football logo crest')) {
      const q = encodeURIComponent(query);
      const data = await fetchJson(
        `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|mime&iiurlwidth=256&format=json&origin=*`,
        3000
      );

      for (const p of Object.values(data?.query?.pages || {})) {
        const ii = p.imageinfo?.[0];
        const url = ii?.thumburl || ii?.url || '';
        const mime = ii?.thumbmime || ii?.mime || '';
        const score = scoreName(p.title || '', team);

        if (url && /^image\/(png|jpeg|jpg|webp)$/i.test(mime) && score >= 35) {
          candidatesMap.set(p.pageid || p.title, {
            title: p.title || '',
            url,
            mime,
            score
          });
        }
      }
    }

    const candidates = [...candidatesMap.values()]
      .sort((a, b) => b.score - a.score);

    const c = candidates[0];
    return c
      ? {
          url: c.url,
          name: c.title,
          source: `Wikimedia Commons — ${c.title}`,
          score: c.score
        }
      : null;
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
    fromSportsDB(team),
    fromWikidata(team),
    fromWikipedia(team),
    fromZeroZero(team),
    fromCommons(team),
    fromWebSearch(team)
  ]);

  const candidates = results
    .filter(r => r.status === 'fulfilled' && r.value?.url)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);

  // Download several strong candidates in parallel. The first successful
  // download wins, avoiding long waits when one image host is slow.
  const top = candidates.slice(0, 6);
  const downloads = await Promise.allSettled(top.map(downloadAsDataUrl));

  for (let i = 0; i < downloads.length; i++) {
    const d = downloads[i];
    if (d.status === 'fulfilled' && d.value) {
      const c = top[i];
      return { imageDataUrl: d.value, source: c.source, title: c.name };
    }
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
      new Promise(resolve => setTimeout(() => resolve(null), 9000))
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
