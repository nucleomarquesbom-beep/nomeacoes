/**
 * Escudos — fluxo único:
 * PDF -> FPF (nome) -> Nº FPF -> ZeroZero (Num.FPF) -> escudo.
 *
 * Não aceita escudo por semelhança de nome.
 * O ZeroZero só é aceite quando Num.FPF === número obtido na FPF.
 *
 * Variáveis opcionais:
 *   GITHUB_TOKEN
 *   GITHUB_REPO
 *   GITHUB_BRANCH (default main)
 *   FPF_SEARCH_URL_TEMPLATE
 *      Ex.: https://resultados.fpf.pt/Club/Club?name={name}
 */

const FPF = 'https://resultados.fpf.pt';
const ZEROZERO = 'https://www.zerozero.pt';

const USER_AGENT =
  process.env.FPF_ZEROZERO_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151 Safari/537.36';

function clean(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()\-]/g, ' ')
    .replace(/\b(?:sad|sduq|oaf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreName(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return -Infinity;
  if (x === y) return 10000;
  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  const common = [...xs].filter(v => ys.has(v)).length;
  const containment = x.includes(y) || y.includes(x) ? 2500 : 0;
  return containment + common * 500 - Math.abs(x.length - y.length);
}

function absolute(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

function decodeHtml(s = '') {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function textOnly(html = '') {
  return decodeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
      Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP_${response.status}:${url}`);
  }
  return response;
}

function links(html, base, regex) {
  const result = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = absolute(decodeHtml(m[1]), base);
    if (!href || (regex && !regex.test(href))) continue;
    result.push({ href, text: textOnly(m[2]) });
  }
  const seen = new Map();
  for (const item of result) {
    if (!seen.has(item.href)) seen.set(item.href, item);
  }
  return [...seen.values()];
}

function extractFpfNumber(html) {
  // Prefer labelled fields; do not accept arbitrary IDs.
  const text = textOnly(html);
  const patterns = [
    /\b(?:N(?:º|o|úmero)?|Num\.?)\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bF\.?\s*P\.?\s*F\.?\s*(?:n(?:º|o)?|número|num\.?)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /["'](?:fpfNumber|fpfNo|fpfCode|numeroFpf|numFpf)["']\s*:\s*["']?(\d{1,6})/i
  ];
  for (const re of patterns) {
    const m = text.match(re) || html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return textOnly(h1[1]);
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeHtml(og[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? textOnly(title[1]) : '';
}

function fpfSearchUrls(team) {
  const q = encodeURIComponent(clean(team));
  const configured = process.env.FPF_SEARCH_URL_TEMPLATE;
  if (configured) {
    return [configured.replaceAll('{name}', q)];
  }

  // Public directory variants. We try them independently because the
  // FPF front-end has changed its query parameter names over time.
  return [
    `${FPF}/Club/Club?search=${q}`,
    `${FPF}/Club/Club?name=${q}`,
    `${FPF}/Club/Club?query=${q}`,
    `${FPF}/Club/Club?clubName=${q}`,
    `${FPF}/Club/Club?Name=${q}`
  ];
}

async function searchFpf(team) {
  const wanted = clean(team);
  const candidates = [];

  for (const url of fpfSearchUrls(wanted)) {
    try {
      const response = await get(url);
      const html = await response.text();

      const detailLinks = links(
        html,
        FPF,
        /resultados\.fpf\.pt\/Club\/Details\?clubId=\d+/i
      );

      for (const link of detailLinks) {
        candidates.push({
          ...link,
          score: scoreName(wanted, link.text)
        });
      }

      // Some versions render the number directly in the search page.
      const number = extractFpfNumber(html);
      if (number && scoreName(wanted, extractTitle(html)) >= 1000) {
        candidates.push({
          href: url,
          text: extractTitle(html) || wanted,
          score: scoreName(wanted, extractTitle(html)),
          fpfNumber: number
        });
      }
    } catch (error) {
      console.warn('[FPF] pesquisa falhou', url, error.message);
    }
  }

  const unique = new Map();
  for (const c of candidates) {
    const key = c.href + '|' + c.text;
    if (!unique.has(key) || unique.get(key).score < c.score) {
      unique.set(key, c);
    }
  }

  const ranked = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  for (const candidate of ranked) {
    if (candidate.fpfNumber) {
      return {
        name: candidate.text,
        fpfNumber: String(candidate.fpfNumber),
        url: candidate.href
      };
    }

    try {
      const response = await get(candidate.href);
      const html = await response.text();
      const name = extractTitle(html) || candidate.text;
      const number = extractFpfNumber(html);

      if (!number) continue;
      if (scoreName(wanted, name) < 1000) continue;

      return {
        name,
        fpfNumber: String(number),
        url: candidate.href
      };
    } catch (error) {
      console.warn('[FPF] candidato inválido', candidate.href, error.message);
    }
  }

  throw new Error('FPF_NUMBER_NOT_FOUND');
}

function zeroZeroSearchUrls(number) {
  const q = encodeURIComponent(String(number));
  return [
    `${ZEROZERO}/pesquisa?search=${q}`,
    `${ZEROZERO}/pesquisa?search=Num.FPF%20${q}`
  ];
}

function zeroZeroCandidates(html) {
  return links(
    html,
    ZEROZERO,
    /(?:www\.)?zerozero\.pt\/equipa\//i
  ).filter(x => {
    try {
      const u = new URL(x.href);
      return /\/equipa\//i.test(u.pathname);
    } catch {
      return false;
    }
  });
}

function extractZeroZeroFpfNumber(html) {
  const text = textOnly(html);
  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:ú|u)mero\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /["'](?:numFpf|fpfNumber)["']\s*:\s*["']?(\d{1,6})/i
  ];
  for (const re of patterns) {
    const m = text.match(re) || html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractShieldUrl(html) {
  const candidates = [];
  const re = /<img\b[^>]*>/gi;
  let m;

  while ((m = re.exec(html))) {
    const tag = m[0];
    const context = tag.toLowerCase();

    const attrs = [
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1]?.split(',')[0]?.trim()?.split(/\s+/)[0]
    ].filter(Boolean);

    for (const raw of attrs) {
      const url = absolute(decodeHtml(raw), ZEROZERO);
      if (!url) continue;
      if (/(logo|escudo|emblema|badge|club|team|equipa)/i.test(context)) {
        candidates.push(url);
      }
    }
  }

  // Prefer likely crest assets and keep ZeroZero as the only host.
  const filtered = [...new Set(candidates)].filter(url => {
    try {
      const u = new URL(url);
      return /zerozero\.(pt|eu)$/i.test(u.hostname);
    } catch {
      return false;
    }
  });

  return filtered[0] || null;
}

async function searchZeroZero(number, team) {
  const candidates = [];

  for (const url of zeroZeroSearchUrls(number)) {
    const response = await get(url);
    const html = await response.text();
    candidates.push(...zeroZeroCandidates(html));
  }

  const unique = new Map();
  for (const c of candidates) {
    if (!unique.has(c.href)) unique.set(c.href, c);
  }

  const ranked = [...unique.values()]
    .map(c => ({ ...c, score: scoreName(team, c.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  for (const candidate of ranked) {
    try {
      const response = await get(candidate.href);
      const html = await response.text();

      const numFpf = extractZeroZeroFpfNumber(html);

      // Hard validation. No Num.FPF = no crest.
      if (!numFpf || String(numFpf) !== String(number)) continue;

      const imageUrl = extractShieldUrl(html);
      if (!imageUrl) continue;

      return {
        name: extractTitle(html) || candidate.text || team,
        numFpf: String(numFpf),
        pageUrl: candidate.href,
        imageUrl
      };
    } catch (error) {
      console.warn('[ZeroZero] candidato rejeitado', candidate.href, error.message);
    }
  }

  throw new Error('ZEROZERO_NUM_FPF_MISMATCH_OR_SHIELD_NOT_FOUND');
}

async function downloadImage(url) {
  const response = await get(url, {
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  });

  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!type.startsWith('image/')) throw new Error('ZEROZERO_RESPONSE_NOT_IMAGE');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('ZEROZERO_EMPTY_IMAGE');

  return `data:${type};base64,${buffer.toString('base64')}`;
}

function dataUrlParts(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (!m) return null;

  const ext = ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
  })[m[1].toLowerCase()];

  return ext ? { mime: m[1], ext, base64: m[2] } : null;
}

function safeFilename(name) {
  return clean(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'escudo';
}

async function saveGitHub(team, dataUrl) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return { ok: false, skipped: true, error: 'GitHub cache não configurada.' };
  }

  const image = dataUrlParts(dataUrl);
  if (!image) return { ok: false, error: 'Imagem inválida para GitHub.' };

  const path = `public/escudos/${safeFilename(team)}.${image.ext}`;
  const api = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };

  try {
    const current = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    let sha = null;

    if (current.ok) sha = (await current.json()).sha || null;
    else if (current.status !== 404) {
      return { ok: false, error: `GitHub GET ${current.status}` };
    }

    const response = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Escudo FPF→ZeroZero: ${safeFilename(team)}`,
        content: image.base64,
        branch,
        ...(sha ? { sha } : {})
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: body.message || `GitHub PUT ${response.status}` };
    }

    return { ok: true, path, commit: body.commit?.sha || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function processTeam(team) {
  const requested = clean(team);
  if (!requested) throw new Error('TEAM_REQUIRED');

  const fpf = await searchFpf(requested);
  const zz = await searchZeroZero(fpf.fpfNumber, requested);
  const imageDataUrl = await downloadImage(zz.imageUrl);
  const saved = await saveGitHub(requested, imageDataUrl);

  return {
    ok: true,
    team: requested,
    fpfName: fpf.name,
    fpfNumber: fpf.fpfNumber,
    fpfPage: fpf.url,
    zeroZeroTeam: zz.name,
    zeroZeroNumFpf: zz.numFpf,
    zeroZeroPage: zz.pageUrl,
    zeroZeroImage: zz.imageUrl,
    imageDataUrl,
    saved: !!saved.ok,
    savedPath: saved.path || null,
    saveError: saved.ok ? null : saved.error || null
  };
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const team = clean(req.query?.team);
      if (!team) return res.status(400).json({ ok: false, error: 'team obrigatório' });

      const result = await processTeam(team);
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      const input = body(req);
      const teams = Array.isArray(input.teams)
        ? input.teams
        : input.team ? [input.team] : [];

      const unique = [...new Set(teams.map(clean).filter(Boolean))];
      if (!unique.length) {
        return res.status(400).json({ ok: false, error: 'teams obrigatório' });
      }

      const results = [];
      for (const team of unique) {
        try {
          results.push(await processTeam(team));
        } catch (error) {
          results.push({ ok: false, team, error: error.message });
        }
      }

      return res.status(200).json({
        ok: true,
        results,
        summary: {
          total: results.length,
          found: results.filter(x => x.ok).length,
          failed: results.filter(x => !x.ok).length
        }
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[ESCUDO]', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Erro interno'
    });
  }
}
