import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = id => document.getElementById(id);
const state = { pages: [], games: [], names: new Map(), assets: new Map() };

function normalizeText(v = '') {
  return String(v).toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(v = '') {
  return normalizeText(v).replace(/\s+/g, '');
}

function safeFile(v = '') {
  return String(v)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function setStatus(s) {
  $('status').textContent = s;
  $('error').textContent = '';
}

function setError(s) {
  $('error').textContent = s;
  $('status').textContent = '';
}

/*
 * PESQUISA DE NOMES
 *
 * Esta é a lógica importante:
 * - a lista do utilizador é guardada com o nome original;
 * - o PDF é pesquisado como texto normalizado;
 * - os espaços e acentos deixam de impedir a correspondência;
 * - a pesquisa é feita no texto da própria linha, não nas coordenadas X.
 */
function findListedName(text) {
  const normalized = normalizeText(text);
  const compactText = compact(text);

  const entries = [...state.names.entries()]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [key, original] of entries) {
    if (normalized.includes(normalizeText(original)) || compactText.includes(key)) {
      return original;
    }
  }

  return null;
}

function findListedInText(text) {
  const normalized = normalizeText(text);
  const compactText = compact(text);

  const entries = [...state.names.entries()]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [key, original] of entries) {
    const target = normalizeText(original);
    const pos = normalized.indexOf(target);

    if (pos >= 0) {
      return {
        name: original,
        normalizedStart: pos,
        normalizedEnd: pos + target.length
      };
    }

    const cpos = compactText.indexOf(key);
    if (cpos >= 0) {
      return {
        name: original,
        normalizedStart: cpos,
        normalizedEnd: cpos + key.length
      };
    }
  }

  return null;
}

function isObserver(t) {
  return /^OBSV\s*:/i.test(t.trim());
}

function isVAR(t) {
  return /^(VAR|AVAR)\s*:/i.test(t.trim());
}

function isHeader(t) {
  return normalizeText(t) === 'jogo arbitro associacao';
}

function isMeta(t) {
  return /^(NOTA INFORMATIVA|N\.?\s*:|DATA\s*:|NI\s+)/i.test(t.trim());
}

function isCompetition(t) {
  const n = normalizeText(t);
  if (!n || isHeader(t) || isObserver(t) || isVAR(t) || isMeta(t)) return false;

  return /\b(liga|campeonato|taca|supertaca|sub-\d+|futsal|futebol de praia)\b/i.test(n)
    && !/\bA\.?\s*F\.?\b/i.test(t);
}

function detectModality(c = '') {
  const n = normalizeText(c);
  if (n.includes('futsal') || n.includes('liga placard') || n.includes('liga feminina placard')) {
    return 'FUTSAL';
  }
  return 'FUTEBOL';
}

function isLiga3BPI(c = '') {
  const n = normalizeText(c);
  return n.includes('liga 3') || n.includes('liga bpi');
}

function hasAssociation(t) {
  return /\bA\.?\s*F\.?\s+/i.test(t);
}

/*
 * Retira a parte da associação e deixa apenas:
 *   equipa 1 - equipa 2 + nome do oficial
 *
 * O nome do oficial é encontrado pela lista do utilizador.
 */
function removeAssociation(t) {
  return t.replace(/\s+A\.?\s*F\.?\s+.*$/i, '').trim();
}

function looksLikeGameLine(t) {
  return hasAssociation(t) && /\s-\s/.test(t);
}

function looksLikeOfficialLine(t) {
  return hasAssociation(t) && !/\s-\s/.test(t);
}

function splitGamePrefix(prefix) {
  const clean = prefix.replace(/\s+/g, ' ').trim();
  const dash = clean.lastIndexOf(' - ');

  if (dash < 0) return null;

  return {
    home: clean.slice(0, dash).trim(),
    away: clean.slice(dash + 3).trim()
  };
}

function roleForPosition(index, competition, modality) {
  if (modality === 'FUTSAL') {
    if (index === 0) return 'Árbitro';
    if (index === 1) return '2.º Árbitro';
    if (index === 2) return '3.º Árbitro';
    if (index === 3) return 'Cronometrista';
    return 'Oficial';
  }

  if (isLiga3BPI(competition)) {
    if (index === 0) return 'Árbitro';
    if (index === 1) return '4.º Árbitro';
    if (index === 2) return 'Assistente 1';
    if (index === 3) return 'Assistente 2';
    return 'Oficial';
  }

  if (index === 0) return 'Árbitro';
  if (index === 1) return 'Assistente 1';
  if (index === 2) return 'Assistente 2';
  return 'Oficial';
}

function finalizeGame(current) {
  if (!current) return null;

  const modality = detectModality(current.competition);

  const officials = current.officials
    .filter(o => o.name)
    .map((o, index) => ({
      name: o.name,
      role: roleForPosition(o.position, current.competition, modality)
    }));

  if (current.observer) {
    officials.push({
      name: current.observer,
      role: 'Observador'
    });
  }

  if (!officials.length) return null;

  return {
    competition: current.competition,
    home: current.home,
    away: current.away,
    officials,
    page: current.page
  };
}

/*
 * NOVO LEITOR:
 * não usa coordenadas X para descobrir quem é o árbitro.
 *
 * Cada linha é tratada como texto.
 * A existência de "A.F." identifica uma linha de nomeação.
 * A lista do utilizador identifica quais nomes nos interessam.
 *
 * Isto permite, por exemplo:
 *
 * LUSITANO ... - ATLÉTICO ... GONCALO ROSA A.F. COIMBRA
 * NUNO GUERRA A.F. COIMBRA
 *
 * mesmo que apenas Nuno Guerra esteja na lista.
 * O primeiro continua a ocupar a posição 0 e Nuno a posição 1,
 * logo Nuno = 4.º Árbitro.
 */
function headerAnchors(items) {
  const a = { game: null, official: null, assoc: null };
  for (const it of items) {
    const n = normalizeText(it.text);
    if (n === 'jogo') a.game = it.x;
    else if (n === 'arbitro') a.official = it.x;
    else if (n === 'associacao') a.assoc = it.x;
  }
  return a;
}

function columnText(line, anchors) {
  const out = { game: [], official: [], assoc: [] };
  if (anchors.game == null || anchors.official == null || anchors.assoc == null) return out;

  for (const it of line.items) {
    const candidates = [
      ['game', Math.abs(it.x - anchors.game)],
      ['official', Math.abs(it.x - anchors.official)],
      ['assoc', Math.abs(it.x - anchors.assoc)]
    ].sort((a, b) => a[1] - b[1]);
    out[candidates[0][0]].push(it.text);
  }
  return {
    game: out.game.join(' ').replace(/\s+/g, ' ').trim(),
    official: out.official.join(' ').replace(/\s+/g, ' ').trim(),
    assoc: out.assoc.join(' ').replace(/\s+/g, ' ').trim()
  };
}

function parsePage(page) {
  const games = [];
  let competition = '';
  let current = null;
  let table = false;
  let anchors = null;

  function pushCurrent() {
    const game = finalizeGame(current);
    if (game) games.push(game);
    current = null;
  }

  for (let i = 0; i < page.lines.length; i++) {
    const line = page.lines[i];
    const text = line.text.trim();
    if (!text) continue;

    if (isHeader(text)) {
      pushCurrent();
      anchors = headerAnchors(line.items);
      table = true;
      continue;
    }

    if (!table) {
      if (isCompetition(text)) competition = text;
      continue;
    }

    if (isMeta(text)) {
      pushCurrent();
      table = false;
      anchors = null;
      continue;
    }

    if (isCompetition(text) && !hasAssociation(text)) {
      pushCurrent();
      competition = text;
      table = false;
      anchors = null;
      continue;
    }

    if (isObserver(text)) {
      if (current) {
        const observerText = text.replace(/^OBSV\s*:/i, '').trim();
        const listed = findListedName(observerText);
        if (listed) current.observer = listed;
      }
      continue;
    }

    if (isVAR(text)) continue;
    if (!hasAssociation(text)) continue;

    const cols = columnText(line, anchors);
    const assoc = cols.assoc || '';
    const official = cols.official || '';
    const gameText = cols.game || '';

    // FPF's table has a fixed semantic boundary: the game is under "Jogo",
    // the referee under "Árbitro", and the association under "Associação".
    // This is much safer than trying to guess where a team name ends from
    // the concatenated text string.
    if (gameText.includes(' - ') && official && /^A\.?\s*F\.?/i.test(assoc)) {
      pushCurrent();

      const dash = gameText.lastIndexOf(' - ');
      const home = gameText.slice(0, dash).trim();
      const away = gameText.slice(dash + 3).trim();
      const listed = findListedName(official);

      current = {
        competition,
        home,
        away,
        officials: [{ name: listed || null, position: 0 }],
        observer: null,
        page: page.page
      };
      continue;
    }

    // Continuation lines contain only the official + association columns.
    if (official && /^A\.?\s*F\.?/i.test(assoc) && current) {
      const listed = findListedName(official);
      current.officials.push({
        name: listed || null,
        position: current.officials.length
      });
    }
  }

  pushCurrent();
  return games;
}

function parsePages(pages) {
  return pages.flatMap(parsePage);
}

async function extractPDF(file) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: true
    });

    const items = content.items
      .filter(i => i.str?.trim())
      .map(i => ({
        text: i.str.trim(),
        x: i.transform[4],
        y: i.transform[5],
        width: i.width || 0
      }));

    items.sort((a, b) => b.y - a.y || a.x - b.x);

    const groups = [];
    const tol = 3.5;

    for (const it of items) {
      let g = groups.find(x => Math.abs(x.y - it.y) <= tol);

      if (!g) {
        g = { y: it.y, items: [] };
        groups.push(g);
      }

      g.items.push(it);
    }

    const lines = groups
      .sort((a, b) => b.y - a.y)
      .map(g => {
        g.items.sort((a, b) => a.x - b.x);

        return {
          text: g.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(),
          items: g.items
        };
      })
      .filter(x => x.text);

    pages.push({ page: p, lines });
  }

  return {
    numPages: pdf.numPages,
    pages
  };
}

function tryImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadFirst(key, urls) {
  for (const u of urls) {
    const img = await tryImage(u + '?v=2');

    if (img) {
      state.assets.set(key, img);
      return img;
    }
  }

  return null;
}

async function loadIdentity() {
  await loadFirst('logo', [
    '/fotografias/logo.png',
    '/fotografias/logo.jpeg',
    '/fotografias/logo.jpg'
  ]);

  await loadFirst('background', [
    '/assets/fundo_nomeacao.png'
  ]);
}

function personUrls(name) {
  const base = safeFile(name);
  const variants = [...new Set([
    base,
    base.toLowerCase(),
    base.toUpperCase(),
    base.replace(/\b\w/g, c => c.toUpperCase())
  ])];

  const urls = [];
  for (const f of variants) {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      urls.push(`/fotografias/${encodeURIComponent(f)}.${ext}`);
    }
  }
  return urls;
}

async function personImage(name) {
  const key = 'p:' + compact(name);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  return loadFirst(key, personUrls(name));
}

function teamVariants(team) {
  const a = new Set([
    team.trim(),
    team.replace(/\bSAD\b/ig, '').replace(/\bSDUQ\b/ig, '').trim(),
    team.replace(/[,.]/g, '').trim()
  ]);

  return [...a].filter(Boolean);
}

let shieldDbPromise = null;

function shieldLookupVariants(team) {
  const raw = String(team || '').trim();
  const withoutBusinessSuffix = raw
    .replace(/\bSAD\b/ig, '')
    .replace(/\bSDUQ\b/ig, '')
    .replace(/\bOAF\b/ig, '')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const variants = [raw, withoutBusinessSuffix];
  return [...new Set(variants.map(compact).filter(Boolean))];
}

async function loadShieldDatabase() {
  if (!shieldDbPromise) {
    shieldDbPromise = fetch('/escudos-db.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}));
  }
  return shieldDbPromise;
}

async function shieldFromDatabase(team) {
  const db = await loadShieldDatabase();
  const variants = shieldLookupVariants(team);
  for (const key of variants) {
    const entry = db?.[key];
    if (!entry) continue;
    const src = typeof entry === 'string' ? entry : entry.image;
    if (!src) continue;
    const img = await tryImage(src);
    if (img) {
      state.assets.set('s:' + compact(team), img);
      state.assets.set('source:' + compact(team), typeof entry === 'object' ? (entry.source || 'Base de dados') : 'Base de dados');
      return img;
    }
  }
  return null;
}

async function shieldFromPersistentCache(team) {
  try {
    const variants = shieldLookupVariants(team);
    for (const key of variants) {
      const raw = localStorage.getItem('nafmb-shield-db:' + key);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      const src = entry?.imageDataUrl || entry?.image;
      if (!src) continue;
      const img = await tryImage(src);
      if (img) {
        state.assets.set('s:' + compact(team), img);
        state.assets.set('source:' + compact(team), entry.source || 'Base de dados local');
        return img;
      }
    }
  } catch {}
  return null;
}

function rememberShield(team, data) {
  try {
    const payload = JSON.stringify({
      imageDataUrl: data?.imageDataUrl || '',
      source: data?.source || 'Pesquisa automática',
      updatedAt: Date.now()
    });
    for (const key of shieldLookupVariants(team)) {
      try { localStorage.setItem('nafmb-shield-db:' + key, payload); } catch {}
    }
  } catch {}
}

async function searchRemoteShield(team, timeoutMs = 4500) {
  const key = 'remoteShield:' + compact(team);
  const cached = state.assets.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`/api/escudo?team=${encodeURIComponent(team)}`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!r.ok) return null;

    const data = await r.json();
    const imageSrc = data?.imageDataUrl;
    if (!imageSrc) return null;

    const img = await tryImage(imageSrc);
    if (!img) return null;

    state.assets.set(key, img);
    state.assets.set('s:' + compact(team), img);
    state.assets.set('source:' + compact(team), data.source || '');
    rememberShield(team, data);
    return img;
  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.warn('Pesquisa automática de escudo falhou:', team, e);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function shieldLocalImage(team) {
  const key = 's:' + compact(team);
  if (state.assets.has(key)) return state.assets.get(key);

  for (const v of teamVariants(team)) {
    const f = safeFile(v);
    // The normal repository convention is PNG first. This avoids four
    // unnecessary failed requests for the common case.
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const img = await tryImage(`/escudos/${f}.${ext}?v=5`);
      if (img) {
        state.assets.set(key, img);
        state.assets.set('source:' + compact(team), 'Biblioteca local do Núcleo');
        return img;
      }
    }
  }
  return null;
}

async function prepareOneShield(team) {
  // Ordem de prioridade: base de dados -> ficheiro local -> cache persistente -> pesquisa online.
  // Assim, se o escudo já existir, nunca fazemos uma pesquisa desnecessária.
  if (await shieldFromDatabase(team)) return true;
  if (await shieldLocalImage(team)) return true;
  if (await shieldFromPersistentCache(team)) return true;
  return !!(await searchRemoteShield(team));
}

async function prefetchShields(games) {
  const teams = new Map();
  for (const g of games) {
    teams.set(compact(g.home), g.home);
    teams.set(compact(g.away), g.away);
  }

  const uniqueTeams = [...teams.values()];
  const started = performance.now();

  // All teams in parallel. No sequential club-by-club wait.
  await Promise.all(uniqueTeams.map(team => prepareOneShield(team)));

  return {
    total: uniqueTeams.length,
    found: uniqueTeams.filter(team => state.assets.has('s:' + compact(team))).length,
    seconds: (performance.now() - started) / 1000
  };
}

function drawContain(ctx, img, x, y, w, h) {
  if (!img) return;

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;

  ctx.drawImage(
    img,
    x + (w - dw) / 2,
    y + (h - dh) / 2,
    dw,
    dh
  );
}

function drawCover(ctx, img, x, y, w, h, r = 0) {
  if (!img) return;

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;

  ctx.save();

  if (r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.clip();
  }

  ctx.drawImage(
    img,
    x + (w - dw) / 2,
    y + (h - dh) / 2,
    dw,
    dh
  );

  ctx.restore();
}

function wrap(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';

  for (const w of words) {
    const t = line ? line + ' ' + w : w;

    if (ctx.measureText(t).width <= maxWidth) {
      line = t;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }

  if (line) lines.push(line);

  lines.slice(0, maxLines).forEach((l, i) => {
    ctx.fillText(l, x, y + i * lineHeight);
  });
}

function fit(ctx, text, max, start, min = 24) {
  let s = start;

  while (s > min) {
    ctx.font = `700 ${s}px Arial`;

    if (ctx.measureText(text).width <= max) {
      return s;
    }

    s -= 2;
  }

  return s;
}

function roundRect(ctx, x, y, w, h, r, fill, stroke = null, lineWidth = 1) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function displayCompetition(competition = '') {
  const n = normalizeText(competition);
  let title = competition.trim();
  let detail = '';

  if (n.includes('liga 3')) {
    title = 'LIGA 3';
    detail = competition.replace(/.*?liga\s*3\s*/i, '').replace(/^[-–—•|]+\s*/, '').trim();
  } else if (n.includes('liga placard')) {
    title = 'LIGA PLACARD';
    detail = competition.replace(/.*?liga\s*placard\s*/i, '').replace(/^[-–—•|]+\s*/, '').trim();
  } else if (n.includes('liga bpi')) {
    title = 'LIGA BPI';
    detail = competition.replace(/.*?liga\s*bpi\s*/i, '').replace(/^[-–—•|]+\s*/, '').trim();
  } else if (n.includes('supertaca')) {
    title = 'SUPERTAÇA';
    detail = competition.replace(/.*?supertaca\s*/i, '').replace(/^[-–—•|]+\s*/, '').trim();
  } else {
    const parts = competition.split(/\s+-\s+/);
    if (parts.length > 1) {
      title = parts.shift().trim();
      detail = parts.join(' • ').trim();
    }
  }

  return { title, detail };
}

function drawGoldLine(ctx, x1, y, x2, thickness = 2) {
  ctx.save();
  ctx.strokeStyle = '#e7b63d';
  ctx.lineWidth = thickness;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.fillStyle = '#e7b63d';
  ctx.fillRect((x1 + x2) / 2 - 22, y - 4, 44, 8);
  ctx.restore();
}

function drawMixedTitle(ctx, text, x, y, maxWidth, startSize = 110) {
  const match = String(text).match(/^(.*?)(\d+)$/);
  if (!match) {
    ctx.fillStyle = '#f5f7f8';
    const size = fit(ctx, text, maxWidth, startSize, 54);
    ctx.font = `900 ${size}px Impact, Arial Black, Arial`;
    ctx.fillText(text, x, y);
    return;
  }

  const left = match[1].trimEnd();
  const number = match[2];
  let size = startSize;
  while (size > 54) {
    ctx.font = `900 ${size}px Impact, Arial Black, Arial`;
    const total = ctx.measureText(left).width + ctx.measureText(number).width + 12;
    if (total <= maxWidth) break;
    size -= 2;
  }

  ctx.font = `900 ${size}px Impact, Arial Black, Arial`;
  const lw = ctx.measureText(left).width;
  const nw = ctx.measureText(number).width;
  const total = lw + nw + 12;
  const sx = x - total / 2;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#f5f7f8';
  ctx.fillText(left, sx, y);
  ctx.fillStyle = '#e7b63d';
  ctx.fillText(number, sx + lw + 12, y);
  ctx.textAlign = 'center';
}

function drawHashtag(ctx) {
  // Deliberately separated into three parts so it never collides with itself.
  const y = 178;
  ctx.textAlign = 'center';
  ctx.font = '900 italic 52px Arial';
  const parts = [
    { text: '#TambemEstamos', color: '#f5f7f8' },
    { text: 'EmJogo', color: '#e7b63d' }
  ];
  const widths = parts.map(p => ctx.measureText(p.text).width);
  const gap = 8;
  const total = widths.reduce((a,b)=>a+b,0) + gap;
  let x = 540 - total/2;
  ctx.textAlign = 'left';
  parts.forEach((p, i) => {
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, y);
    x += widths[i] + gap;
  });
  ctx.textAlign = 'center';
}

function drawTeamBlock(ctx, game, homeShield, awayShield, y = 470) {
  const leftCenter = 270;
  const rightCenter = 810;
  const shieldY = y + 5;
  const shieldSize = 155;

  ctx.textAlign = 'center';
  drawContain(ctx, homeShield, leftCenter - shieldSize/2, shieldY, shieldSize, shieldSize);
  drawContain(ctx, awayShield, rightCenter - shieldSize/2, shieldY, shieldSize, shieldSize);

  // Central VS area gives the shields and team names visual breathing room.
  ctx.strokeStyle = 'rgba(231,182,61,.72)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(385, y + 18); ctx.lineTo(385, y + 250);
  ctx.moveTo(695, y + 18); ctx.lineTo(695, y + 250);
  ctx.stroke();

  ctx.fillStyle = '#e7b63d';
  ctx.font = '900 62px Impact, Arial Black, Arial';
  ctx.fillText('VS', 540, y + 145);

  ctx.fillStyle = '#f5f7f8';
  const homeSize = fit(ctx, game.home, 315, 31, 20);
  ctx.font = `800 ${homeSize}px Arial`;
  wrap(ctx, game.home.toUpperCase(), leftCenter, y + 205, 330, homeSize + 6, 2);

  const awaySize = fit(ctx, game.away, 315, 31, 20);
  ctx.font = `800 ${awaySize}px Arial`;
  wrap(ctx, game.away.toUpperCase(), rightCenter, y + 205, 330, awaySize + 6, 2);
}

function drawMatchInfo(ctx, game, y = 760) {
  const date = game.date || game.matchDate || '';
  const time = game.time || game.matchTime || '';
  const venue = game.venue || game.stadium || '';
  if (!date && !time && !venue) return false;

  drawGoldLine(ctx, 125, y, 955, 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f7f8';
  ctx.font = '700 25px Arial';

  if (date) ctx.fillText('▣  ' + date, 250, y + 52);
  if (time) ctx.fillText('◷  ' + time, 535, y + 52);
  if (venue) {
    ctx.font = '700 22px Arial';
    wrap(ctx, '◉  ' + venue, 760, y + 35, 330, 27, 2);
  }
  return true;
}

function drawOfficialCard(ctx, official, x, y, w, h) {
  // A compact, editorial card: large enough for the photo, but never so tall
  // that four officials destroy the Story composition.
  roundRect(ctx, x, y, w, h, 24, 'rgba(7,20,27,.76)', 'rgba(231,182,61,.80)', 2);

  const pad = Math.max(14, Math.min(22, h * 0.10));
  const photoSize = Math.min(h - pad*2, 205);
  const photoX = x + pad;
  const photoY = y + (h - photoSize) / 2;

  // White photographic frame.
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(photoX, photoY, photoSize, photoSize);

  const photo = state.assets.get('p:' + compact(official.name)) || null;
  if (photo) {
    drawCover(ctx, photo, photoX + 9, photoY + 9, photoSize - 18, photoSize - 18, 3);
  } else {
    ctx.fillStyle = '#52646d';
    ctx.fillRect(photoX + 9, photoY + 9, photoSize - 18, photoSize - 18);
  }

  const textX = photoX + photoSize + 42;
  const textW = x + w - textX - 28;
  const compactCard = h < 235;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#e7b63d';
  ctx.font = `800 ${compactCard ? 22 : 27}px Arial`;
  ctx.fillText(official.role.toUpperCase(), textX, y + h * 0.34);

  ctx.fillStyle = '#f5f7f8';
  const nameStart = compactCard ? 39 : 48;
  const nameSize = fit(ctx, official.name.toUpperCase(), textW, nameStart, compactCard ? 25 : 28);
  ctx.font = `900 ${nameSize}px Arial`;
  wrap(ctx, official.name.toUpperCase(), textX, y + h * 0.59, textW, nameSize + 4, 2);

  ctx.fillStyle = '#e7b63d';
  ctx.font = `800 ${compactCard ? 19 : 23}px Arial`;
  ctx.fillText('A.F. COIMBRA', textX, y + h * 0.82);
}

function render(game) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext('2d');

  const bg = state.assets.get('background');
  if (bg) {
    // The approved base is already 9:16. Never stretch a second copy of it.
    ctx.drawImage(bg, 0, 0, 1080, 1920);
  } else {
    ctx.fillStyle = '#10222b';
    ctx.fillRect(0, 0, 1080, 1920);
  }

  const homeShield = state.assets.get('s:' + compact(game.home)) || null;
  const awayShield = state.assets.get('s:' + compact(game.away)) || null;

  // The background already contains the original Núcleo logo/header.
  drawHashtag(ctx);

  const comp = displayCompetition(game.competition);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e7b63d';
  ctx.font = '800 24px Arial';
  ctx.fillText('COMPETIÇÃO', 540, 245);

  drawMixedTitle(ctx, comp.title, 540, 350, 900, 112);
  drawGoldLine(ctx, 300, 400, 780, 2);

  ctx.fillStyle = '#f5f7f8';
  const detail = comp.detail || game.competition || '';
  const detailSize = fit(ctx, detail, 900, 27, 17);
  ctx.font = `800 ${detailSize}px Arial`;
  ctx.fillText(detail.toUpperCase(), 540, 447);

  // Teams are deliberately isolated from the referee cards.
  drawTeamBlock(ctx, game, homeShield, awayShield, 485);

  const hasMatchInfo = drawMatchInfo(ctx, game, 755);

  const count = Math.max(1, Math.min(game.officials.length, 4));
  const footerTop = 1780;
  const start = hasMatchInfo ? 845 : 820;
  const gap = count >= 4 ? 12 : 16;
  const available = footerTop - start;
  const cardH = Math.floor((available - gap * (count - 1)) / count);

  game.officials.slice(0, 4).forEach((official, i) => {
    drawOfficialCard(ctx, official, 105, start + i * (cardH + gap), 870, cardH);
  });

  drawGoldLine(ctx, 130, 1820, 950, 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f7f8';
  ctx.font = '800 23px Arial';
  ctx.fillText('TRABALHO  •  COMPETÊNCIA  •  DEDICAÇÃO', 540, 1868);

  return canvas;
}

function showGames() {
  $('results').innerHTML = state.games.map(g => `
    <div class="result">
      <b>${escapeHtml(g.home)}</b>
      <span>vs</span>
      <b>${escapeHtml(g.away)}</b>
      <small>${escapeHtml(g.competition)}</small>
      <p>
        ${g.officials.map(o =>
          escapeHtml(o.name) + ' — ' + escapeHtml(o.role)
        ).join('<br>')}
      </p>
    </div>
  `).join('');
}

async function checkAssets(games) {
  await loadIdentity();

  const missing = [];
  if (!state.assets.has('logo')) missing.push({ type: 'logo', key: 'logo' });

  const people = [...new Map(
    games.flatMap(g => g.officials.map(o => [compact(o.name), o.name]))
  ).values()];

  // Photos are local. Load them all in parallel.
  const photoResults = await Promise.all(
    people.map(async name => [name, await personImage(name)])
  );
  for (const [name, img] of photoResults) {
    if (!img) missing.push({ type: 'foto', key: name });
  }

  // Shields are intentionally NOT searched here. By the time the user can
  // click Generate they have already been warmed by analyze().
  for (const g of games) {
    if (!state.assets.has('s:' + compact(g.home))) {
      missing.push({ type: 'escudo', key: g.home });
    }
    if (!state.assets.has('s:' + compact(g.away))) {
      missing.push({ type: 'escudo', key: g.away });
    }
  }

  const unique = [...new Map(
    missing.map(x => [x.type + ':' + compact(x.key), x])
  ).values()];

  // Missing shields are shown, but do not cause another network lookup.
  // Missing photos/logo still block the final publication.
  const blocking = unique.filter(x => x.type !== 'escudo');
  if (blocking.length) {
    renderMissing(blocking);
    return false;
  }

  if (unique.length) renderMissing(unique);
  else $('missingAssets').hidden = true;
  return true;
}

function renderMissing(items) {
  const unique = [
    ...new Map(
      items.map(x => [x.type + ':' + compact(x.key), x])
    ).values()
  ];

  $('missingAssets').hidden = false;

  $('missingAssets').innerHTML = `
    <div class="missingBox">
      <h3>Faltam ficheiros antes de gerar</h3>
      <p>O gerador bloqueia a criação para não sair uma publicação incompleta.</p>
      ${unique.map(x => `
        <div class="missingRow">
          <span>
            <b>${
              x.type === 'foto'
                ? 'Fotografia'
                : x.type === 'escudo'
                  ? 'Escudo'
                  : 'Logo'
            }</b>: ${escapeHtml(x.key)}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-key="${escapeHtml(x.type + '|' + x.key)}"
          >
        </div>
      `).join('')}
      <button id="useMissing" class="secondary">
        Usar ficheiros nesta sessão
      </button>
    </div>
  `;

  $('useMissing').onclick = async () => {
    for (const input of $('missingAssets').querySelectorAll('input[type=file]')) {
      if (!input.files[0]) continue;

      const [type, key] = input.dataset.key.split('|');
      const img = await fileToImage(input.files[0]);

      state.assets.set(
        type === 'foto'
          ? 'p:' + compact(key)
          : type === 'escudo'
            ? 's:' + compact(key)
            : 'logo',
        img
      );
    }

    setStatus('Ficheiros carregados. Podes gerar novamente.');
  };
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const u = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(u);
      resolve(img);
    };

    img.onerror = reject;
    img.src = u;
  });
}

async function analyze() {
  const file = $('pdfFile').files[0];
  if (!file) return setError('Escolhe primeiro o PDF da FPF.');

  const names = $('names').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!names.length) return setError('Coloca pelo menos um nome na lista.');

  state.names = new Map(names.map(n => [compact(n), n]));
  state.assets.clear();
  setStatus('A ler o PDF e a reconstruir as nomeações...');

  try {
    const data = await extractPDF(file);
    state.pages = data.pages;
    state.games = parsePages(data.pages);

    if (!state.games.length) {
      return setError(`PDF lido (${data.numPages} páginas), mas não foi encontrado nenhum jogo com os nomes indicados.`);
    }

    showGames();
    await loadIdentity();

    // Photos are local and fast. Prepare them in parallel before generation.
    const people = [...new Map(
      state.games.flatMap(g => g.officials.map(o => [compact(o.name), o.name]))
    ).values()];
    await Promise.all(people.map(name => personImage(name)));

    const warmup = prefetchShields(state.games);
    const limit = new Promise(resolve => setTimeout(() => resolve({timeout: true}), 12000));
    const result = await Promise.race([warmup, limit]);

    $('generateBtn').disabled = false;

    if (result?.timeout) {
      setStatus(`Pronto em menos de 30 s. A pesquisa de escudos demorou mais de 12 s; não vou bloquear a aplicação. Os escudos ainda podem continuar a chegar em segundo plano.`);
    } else {
      setStatus(`Pronto: ${state.games.length} jogo(s), ${result.found}/${result.total} escudos preparados em ${result.seconds.toFixed(1)} s. A geração dos JPG não faz pesquisas.`);
    }
  } catch (e) {
    console.error(e);
    setError('Erro ao ler o PDF: ' + (e?.message || e));
  }
}

async function generateAll() {
  if (!state.games.length) return;

  const started = performance.now();
  const ok = await checkAssets(state.games);
  if (!ok) return;

  setStatus('A gerar os JPG — sem pesquisas externas...');
  const zip = new JSZip();
  const batchSize = 4;

  for (let i = 0; i < state.games.length; i += batchSize) {
    const batch = state.games.slice(i, i + batchSize);
    const blobs = await Promise.all(batch.map(async (g, j) => {
      const canvas = render(g);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
      return { g, blob };
    }));

    for (const { g, blob } of blobs) {
      zip.file(
        safeFile(`${String(state.games.indexOf(g) + 1).padStart(2, '0')} - ${g.home} - ${g.away}.jpg`).slice(0, 150),
        blob,
        { compression: 'STORE' }
      );
    }

    const elapsed = (performance.now() - started) / 1000;
    setStatus(`A gerar JPG ${Math.min(i + batchSize, state.games.length)}/${state.games.length}... ${elapsed.toFixed(1)} s`);
    if (elapsed > 30) {
      setError('A geração ultrapassou 30 segundos. A causa provável é a codificação do JPEG/ZIP no navegador, não a pesquisa dos escudos.');
      return;
    }
  }

  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed > 30) {
    setError(`A geração terminou em ${elapsed.toFixed(1)} s. A demora ocorreu na criação do ZIP, porque os JPG já estavam gerados.`);
  }
  download(out, 'Nomeacoes_Marques_Bom.zip');
  setStatus(`Concluído: ${state.games.length} JPG(s) gerados em ${elapsed.toFixed(1)} s.`);
}

async function generateManual() {
  const home = $('mHome').value.trim();
  const away = $('mAway').value.trim();
  const competition = $('mCompetition').value.trim();
  if (!home || !away || !competition) return setError('Preenche competição e as duas equipas.');

  const officials = [...document.querySelectorAll('.manualOfficial')]
    .map(r => ({
      name: r.querySelector('.mName').value.trim(),
      role: r.querySelector('.mRole').value.trim() || 'Árbitro'
    }))
    .filter(x => x.name);
  if (!officials.length) return setError('Adiciona pelo menos um oficial.');

  const g = { home, away, competition, officials, date: $('mDate').value.trim() };
  await loadIdentity();
  await Promise.all(officials.map(o => personImage(o.name)));
  await Promise.race([
    prefetchShields([g]),
    new Promise(resolve => setTimeout(resolve, 12000))
  ]);

  const ok = await checkAssets([g]);
  if (!ok) return;

  const started = performance.now();
  const canvas = render(g);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .92));
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed > 30) {
    setError(`A nomeação manual demorou ${elapsed.toFixed(1)} s na codificação do JPG.`);
    return;
  }
  download(blob, safeFile(`${home} - ${away}.jpg`));
  setStatus(`Nomeação manual gerada em ${elapsed.toFixed(1)} s.`);
}

function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = u;
  a.download = name;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(u), 1500);
}

function addManualOfficial(role = 'Árbitro') {
  const row = document.createElement('div');

  row.className = 'manualOfficial';

  row.innerHTML = `
    <input class="mName" placeholder="Nome">
    <input class="mRole" value="${escapeHtml(role)}">
    <button type="button">×</button>
  `;

  row.querySelector('button').onclick = () => row.remove();

  $('manualOfficials').appendChild(row);
}

function route() {
  const manual = location.hash === '#manual';

  $('pdfSection').hidden = manual;
  $('manualSection').hidden = !manual;

  $('pdfBtn').classList.toggle('active', !manual);
  $('manualBtn').classList.toggle('active', manual);
}

async function init() {
  await loadIdentity();

  $('analyzeBtn').onclick = analyze;
  $('generateBtn').onclick = generateAll;

  $('pdfFile').onchange = e => {
    $('fileName').textContent =
      e.target.files[0]?.name || '';
  };

  $('manualBtn').onclick = () => {
    location.hash = '#manual';
  };

  $('pdfBtn').onclick = () => {
    location.hash = '#pdf';
  };

  $('addOfficial').onclick = () => addManualOfficial();

  $('manualGenerate').onclick = generateManual;

  addManualOfficial();

  window.onhashchange = route;

  route();
}

init();
