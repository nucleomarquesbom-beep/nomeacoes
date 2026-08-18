import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = id => document.getElementById(id);

const state = {
  pages: [],
  games: [],
  names: new Map(),
  assets: new Map()
};

/* =========================================================
   TEXTO / NORMALIZAÇÃO
   ========================================================= */

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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
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


/* =========================================================
   PESQUISA DE NOMES
   ========================================================= */

function findListedName(text) {
  const normalized = normalizeText(text);
  const compactText = compact(text);

  const entries = [...state.names.entries()]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [key, original] of entries) {
    if (
      normalized.includes(normalizeText(original)) ||
      compactText.includes(key)
    ) {
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


/* =========================================================
   IDENTIFICAÇÃO DAS LINHAS DO PDF
   ========================================================= */

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

  if (!n || isHeader(t) || isObserver(t) || isVAR(t) || isMeta(t)) {
    return false;
  }

  return /\b(liga|campeonato|taca|supertaca|sub-\d+|futsal|futebol de praia)\b/i.test(n)
    && !/\bA\.?\s*F\.?\b/i.test(t);
}

function detectModality(c = '') {
  const n = normalizeText(c);

  if (
    n.includes('futsal') ||
    n.includes('liga placard') ||
    n.includes('liga feminina placard')
  ) {
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


/* =========================================================
   FUNÇÃO DOS OFICIAIS
   ========================================================= */

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
    .map(o => ({
      name: o.name,
      role: roleForPosition(
        o.position,
        current.competition,
        modality
      )
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


/* =========================================================
   CABEÇALHOS / COLUNAS DO PDF
   ========================================================= */

function headerAnchors(items) {
  const a = {
    game: null,
    official: null,
    assoc: null
  };

  for (const it of items) {
    const n = normalizeText(it.text);

    if (n === 'jogo') {
      a.game = it.x;
    } else if (n === 'arbitro') {
      a.official = it.x;
    } else if (n === 'associacao') {
      a.assoc = it.x;
    }
  }

  return a;
}

function columnText(line, anchors) {
  const out = {
    game: [],
    official: [],
    assoc: []
  };

  if (
    anchors.game == null ||
    anchors.official == null ||
    anchors.assoc == null
  ) {
    return out;
  }

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


/* =========================================================
   PARSER DO PDF
   ========================================================= */

function parsePage(page) {
  const games = [];

  let competition = '';
  let current = null;
  let table = false;
  let anchors = null;

  function pushCurrent() {
    const game = finalizeGame(current);

    if (game) {
      games.push(game);
    }

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
      if (isCompetition(text)) {
        competition = text;
      }

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
        const observerText = text
          .replace(/^OBSV\s*:/i, '')
          .trim();

        const listed = findListedName(observerText);

        if (listed) {
          current.observer = listed;
        }
      }

      continue;
    }

    if (isVAR(text)) continue;
    if (!hasAssociation(text)) continue;

    const cols = columnText(line, anchors);

    const assoc = cols.assoc || '';
    const official = cols.official || '';
    const gameText = cols.game || '';

    /*
     * PRIMEIRA LINHA DO JOGO
     */
    if (
      gameText.includes(' - ') &&
      official &&
      /^A\.?\s*F\.?/i.test(assoc)
    ) {
      pushCurrent();

      const dash = gameText.lastIndexOf(' - ');

      const home = gameText
        .slice(0, dash)
        .trim();

      const away = gameText
        .slice(dash + 3)
        .trim();

      const listed = findListedName(official);

      current = {
        competition,
        home,
        away,
        officials: [
          {
            name: listed || null,
            position: 0
          }
        ],
        observer: null,
        page: page.page
      };

      continue;
    }

    /*
     * LINHAS SEGUINTES DO MESMO JOGO
     */
    if (
      official &&
      /^A\.?\s*F\.?/i.test(assoc) &&
      current
    ) {
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


/* =========================================================
   EXTRAÇÃO DO PDF
   ========================================================= */

async function extractPDF(file) {
  const data = await file.arrayBuffer();

  const pdf = await pdfjsLib
    .getDocument({ data })
    .promise;

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

    items.sort(
      (a, b) => b.y - a.y || a.x - b.x
    );

    const groups = [];
    const tol = 3.5;

    for (const it of items) {
      let g = groups.find(
        x => Math.abs(x.y - it.y) <= tol
      );

      if (!g) {
        g = {
          y: it.y,
          items: []
        };

        groups.push(g);
      }

      g.items.push(it);
    }

    const lines = groups
      .sort((a, b) => b.y - a.y)
      .map(g => {
        g.items.sort((a, b) => a.x - b.x);

        return {
          text: g.items
            .map(i => i.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),

          items: g.items
        };
      })
      .filter(x => x.text);

    pages.push({
      page: p,
      lines
    });
  }

  return {
    numPages: pdf.numPages,
    pages
  };
}


/* =========================================================
   IMAGENS
   ========================================================= */

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


/* =========================================================
   FOTOGRAFIAS DOS ÁRBITROS
   ========================================================= */

function personUrls(name) {
  const base = safeFile(name);

  const variants = [...new Set([
    base,
    base.toLowerCase(),
    base.toUpperCase(),
    base.replace(
      /\b\w/g,
      c => c.toUpperCase()
    )
  ])];

  const urls = [];

  /*
   * A versão recortada tem prioridade absoluta.
   * Se já existir, nunca voltamos a usar a fotografia
   * original durante a composição.
   */
  for (const f of variants) {
    for (const ext of [
      'webp',
      'png',
      'jpg',
      'jpeg'
    ]) {
      urls.push(
        `/fotografias/recortadas/${encodeURIComponent(f)}.${ext}`
      );
    }
  }

  /*
   * Compatibilidade com a biblioteca antiga.
   */
  for (const f of variants) {
    for (const ext of [
      'jpg',
      'jpeg',
      'png',
      'webp'
    ]) {
      urls.push(
        `/fotografias/${encodeURIComponent(f)}.${ext}`
      );
    }
  }

  return urls;
}

async function personImage(name) {
  const key = 'p:' + compact(name);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  return loadFirst(
    key,
    personUrls(name)
  );
}

/*
 * Guarda uma fotografia já processada na biblioteca persistente.
 *
 * A API usa o token GitHub no servidor, nunca no browser.
 * Se o GitHub/Vercel estiver temporariamente indisponível,
 * a imagem continua disponível nesta sessão.
 */
async function saveProcessedPhoto(name, dataUrl) {
  if (!dataUrl) return false;

  try {
    const response = await fetch(
      '/api/foto',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          name,
          dataUrl
        })
      }
    );

    if (!response.ok) {
      const detail =
        await response.text().catch(() => '');

      console.warn(
        'Não foi possível guardar a fotografia:',
        name,
        detail
      );

      return false;
    }

    return true;

  } catch (error) {
    console.warn(
      'Erro ao guardar fotografia:',
      name,
      error
    );

    return false;
  }
}

async function processAndStorePhoto(
  name,
  file
) {
  if (!file) return null;

  try {
    const {
      removeBackground
    } = await import(
      './photo-processing.js'
    );

    const result =
      await removeBackground(file);

    if (!result?.dataUrl) {
      throw new Error(
        'A remoção do fundo não devolveu uma imagem válida.'
      );
    }

    const img =
      await tryImage(result.dataUrl);

    if (!img) {
      throw new Error(
        'A fotografia processada não pôde ser carregada.'
      );
    }

    state.assets.set(
      'p:' + compact(name),
      img
    );

    /*
     * Persistência. Não bloqueia a utilização da
     * fotografia se a gravação remota falhar.
     */
    const saved =
      await saveProcessedPhoto(
        name,
        result.dataUrl
      );

    return {
      img,
      saved
    };

  } catch (error) {
    console.error(
      'Falha no processamento da fotografia:',
      name,
      error
    );

    /*
     * Fallback seguro: se a remoção automática falhar,
     * ainda utilizamos a fotografia original nesta sessão.
     */
    try {
      const img =
        await fileToImage(file);

      state.assets.set(
        'p:' + compact(name),
        img
      );

      return {
        img,
        saved: false,
        fallback: true
      };

    } catch {
      return null;
    }
  }
}


/* =========================================================
   ESCUDOS
   ========================================================= */

function teamVariants(team) {
  const a = new Set([
    team.trim(),

    team
      .replace(/\s*\/\s*OAF\b/ig, '')
      .replace(/\bSAD\b/ig, '')
      .replace(/\bSDUQ\b/ig, '')
      .trim(),

    team
      .replace(/[,.]/g, '')
      .trim()
  ]);

  return [...a].filter(Boolean);
}


/*
 * PESQUISA ONLINE
 *
 * Esta função só é chamada depois de terminar
 * a pesquisa LOCAL de todos os clubes.
 */
async function searchRemoteShield(
  team,
  timeoutMs = 4500
) {
  const key = 'remoteShield:' + compact(team);

  const cached = state.assets.get(key);

  if (cached) {
    return cached;
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const r = await fetch(
      `/api/escudo?team=${encodeURIComponent(team)}`,
      {
        headers: {
          'Accept': 'application/json'
        },
        signal: controller.signal
      }
    );

    if (!r.ok) {
      return null;
    }

    const data = await r.json();

    const imageSrc = data?.imageDataUrl;

    if (!imageSrc) {
      return null;
    }

    const img = await tryImage(imageSrc);

    if (!img) {
      return null;
    }

    /*
     * O escudo foi encontrado online e passou a ser usado.
     * Agora guardamo-lo na biblioteca persistente do GitHub.
     *
     * IMPORTANTE:
     * - se o POST falhar, o escudo continua a ser usado normalmente;
     * - não fazemos a gravação duas vezes na mesma sessão;
     * - a API /api/escudo já trata de criar ou atualizar
     *   public/escudos/<nome>.<ext>.
     */
    const saveKey = 'remoteShieldSaved:' + compact(team);

    if (!state.assets.has(saveKey)) {
      try {
        const saveController = new AbortController();
        const saveTimer = setTimeout(
          () => saveController.abort(),
          8000
        );

        try {
          const saveResponse = await fetch('/api/escudo', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              team,
              dataUrl: imageSrc
            }),
            signal: saveController.signal
          });

          const saveData = await saveResponse.json().catch(() => ({}));

          if (saveResponse.ok && saveData?.ok) {
            state.assets.set(saveKey, true);
            console.info(
              'Escudo guardado na biblioteca:',
              team,
              saveData.path || ''
            );
          } else {
            console.warn(
              'Escudo encontrado mas não foi possível guardá-lo:',
              team,
              saveData?.error || saveResponse.status
            );
          }
        } finally {
          clearTimeout(saveTimer);
        }
      } catch (saveError) {
        console.warn(
          'Escudo encontrado mas a gravação na biblioteca falhou:',
          team,
          saveError
        );
      }
    }

    state.assets.set(key, img);

    state.assets.set(
      's:' + compact(team),
      img
    );

    state.assets.set(
      'source:' + compact(team),
      data.source || ''
    );

    return img;

  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.warn(
        'Pesquisa automática de escudo falhou:',
        team,
        e
      );
    }

    return null;

  } finally {
    clearTimeout(timer);
  }
}


/*
 * PESQUISA LOCAL
 *
 * IMPORTANTE:
 * Esta função é executada para TODOS os clubes
 * antes de qualquer pesquisa online.
 */
async function shieldLocalImage(team) {
  const key = 's:' + compact(team);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  for (const v of teamVariants(team)) {
    const f = safeFile(v);

    /*
     * PNG primeiro porque é o formato habitual.
     */
    for (const ext of [
      'png',
      'jpg',
      'jpeg',
      'webp'
    ]) {
      const img = await tryImage(
        `/escudos/${f}.${ext}?v=5`
      );

      if (img) {
        state.assets.set(key, img);

        state.assets.set(
          'source:' + compact(team),
          'Biblioteca local do Núcleo'
        );

        return img;
      }
    }
  }

  return null;
}


/*
 * FASE 1:
 * Apenas pesquisa local.
 */
async function prepareOneShieldLocal(team) {
  return !!(await shieldLocalImage(team));
}


/*
 * PREFETCH DOS ESCUDOS
 *
 * ORDEM OBRIGATÓRIA:
 *
 * 1. Procurar TODOS localmente.
 * 2. Identificar os que faltam.
 * 3. Só depois pesquisar online os que faltam.
 */
async function prefetchShields(games) {
  const teams = new Map();

  for (const g of games) {
    teams.set(
      compact(g.home),
      g.home
    );

    teams.set(
      compact(g.away),
      g.away
    );
  }

  const uniqueTeams = [...teams.values()];
  const started = performance.now();

  /*
   * ======================================================
   * FASE 1 — TODOS OS ESCUDOS LOCAIS
   * ======================================================
   */

  await Promise.all(
    uniqueTeams.map(team =>
      prepareOneShieldLocal(team)
    )
  );

  /*
   * ======================================================
   * FASE 2 — CLUBES QUE NÃO EXISTEM LOCALMENTE
   * ======================================================
   */

  const missingTeams = uniqueTeams.filter(
    team =>
      !state.assets.has(
        's:' + compact(team)
      )
  );

  /*
   * ======================================================
   * FASE 3 — PESQUISA ONLINE
   * ======================================================
   *
   * Só os que não foram encontrados localmente.
   */

  await Promise.all(
    missingTeams.map(team =>
      searchRemoteShield(team)
    )
  );

  const found = uniqueTeams.filter(
    team =>
      state.assets.has(
        's:' + compact(team)
      )
  ).length;

  const localFound =
    uniqueTeams.length -
    missingTeams.length;

  const onlineFound =
    found - localFound;

  return {
    total: uniqueTeams.length,
    found,
    local: localFound,
    online: onlineFound,
    seconds:
      (performance.now() - started) / 1000
  };
}


/* =========================================================
   DESENHO
   ========================================================= */

function drawContain(
  ctx,
  img,
  x,
  y,
  w,
  h
) {
  if (!img) return;

  const iw =
    img.naturalWidth ||
    img.width;

  const ih =
    img.naturalHeight ||
    img.height;

  const s = Math.min(
    w / iw,
    h / ih
  );

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

function drawCover(
  ctx,
  img,
  x,
  y,
  w,
  h,
  r = 0
) {
  if (!img) return;

  const iw =
    img.naturalWidth ||
    img.width;

  const ih =
    img.naturalHeight ||
    img.height;

  const s = Math.max(
    w / iw,
    h / ih
  );

  const dw = iw * s;
  const dh = ih * s;

  ctx.save();

  if (r) {
    ctx.beginPath();
    ctx.roundRect(
      x,
      y,
      w,
      h,
      r
    );
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


/* =========================================================
   TEXTO
   ========================================================= */

function wrap(
  ctx,
  text,
  x,
  y,
  maxWidth,
  lineHeight,
  maxLines = 2
) {
  const words = text.split(/\s+/);

  const lines = [];

  let line = '';

  for (const w of words) {
    const t =
      line
        ? line + ' ' + w
        : w;

    if (
      ctx.measureText(t).width <=
      maxWidth
    ) {
      line = t;
    } else {
      if (line) {
        lines.push(line);
      }

      line = w;
    }
  }

  if (line) {
    lines.push(line);
  }

  const visible =
    lines.slice(0, maxLines);

  visible.forEach((l, i) => {
    ctx.fillText(
      l,
      x,
      y + i * lineHeight
    );
  });

  return visible;
}

function wrapLines(
  ctx,
  text,
  maxWidth,
  maxLines = 2
) {
  const words = text.split(/\s+/);

  const lines = [];

  let line = '';

  for (const word of words) {
    const candidate =
      line
        ? `${line} ${word}`
        : word;

    if (
      ctx.measureText(candidate).width <=
      maxWidth
    ) {
      line = candidate;
    } else {
      if (line) {
        lines.push(line);
      }

      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.slice(0, maxLines);
}

function fit(
  ctx,
  text,
  max,
  start,
  min = 24
) {
  let s = start;

  while (s > min) {
    ctx.font = `700 ${s}px Arial`;

    if (
      ctx.measureText(text).width <=
      max
    ) {
      return s;
    }

    s -= 2;
  }

  return s;
}

function fitItalic(
  ctx,
  text,
  max,
  start,
  min = 24
) {
  let s = start;

  while (s > min) {
    ctx.font =
      `900 italic ${s}px Arial`;

    if (
      ctx.measureText(text).width <=
      max
    ) {
      return s;
    }

    s -= 2;
  }

  return s;
}


/* =========================================================
   ELEMENTOS GRÁFICOS
   ========================================================= */

function roundRect(
  ctx,
  x,
  y,
  w,
  h,
  r,
  fill,
  stroke = null,
  lineWidth = 1
) {
  ctx.beginPath();

  ctx.roundRect(
    x,
    y,
    w,
    h,
    r
  );

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

function drawGoldLine(
  ctx,
  x1,
  y,
  x2
) {
  ctx.strokeStyle =
    '#e7b63d';

  ctx.lineWidth = 2;

  ctx.beginPath();

  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);

  ctx.stroke();

  ctx.fillStyle =
    '#e7b63d';

  ctx.fillRect(
    (x1 + x2) / 2 - 24,
    y - 4,
    48,
    8
  );
}


/* =========================================================
   EQUIPAS
   ========================================================= */

function drawTeamBlock(
  ctx,
  game,
  homeShield,
  awayShield
) {
  const y = 505;

  const leftCenter = 245;
  const rightCenter = 835;

  ctx.textAlign = 'center';

  ctx.fillStyle =
    '#e7b63d';

  ctx.font =
    '900 68px Arial';

  ctx.fillText(
    'VS',
    540,
    y + 145
  );

  /*
   * Separadores verticais.
   */
  ctx.strokeStyle =
    'rgba(231,182,61,.82)';

  ctx.lineWidth = 2;

  ctx.beginPath();

  ctx.moveTo(
    385,
    y + 25
  );

  ctx.lineTo(
    385,
    y + 265
  );

  ctx.moveTo(
    695,
    y + 25
  );

  ctx.lineTo(
    695,
    y + 265
  );

  ctx.stroke();

  /*
   * Escudos.
   */
  drawContain(
    ctx,
    homeShield,
    120,
    y,
    250,
    175
  );

  drawContain(
    ctx,
    awayShield,
    710,
    y,
    250,
    175
  );

  /*
   * Nome equipa casa.
   */
  ctx.fillStyle =
    '#f5f7f8';

  const homeSize = fit(
    ctx,
    game.home,
    275,
    31,
    20
  );

  ctx.font =
    `700 ${homeSize}px Arial`;

  wrap(
    ctx,
    game.home,
    leftCenter,
    y + 205,
    275,
    homeSize + 7,
    2
  );

  /*
   * Nome equipa visitante.
   */
  const awaySize = fit(
    ctx,
    game.away,
    275,
    31,
    20
  );

  ctx.font =
    `700 ${awaySize}px Arial`;

  wrap(
    ctx,
    game.away,
    rightCenter,
    y + 205,
    275,
    awaySize + 7,
    2
  );
}


/* =========================================================
   DATA / HORA / ESTÁDIO
   ========================================================= */

function drawMatchInfo(
  ctx,
  game
) {
  const date =
    game.date ||
    game.matchDate ||
    '';

  const time =
    game.time ||
    game.matchTime ||
    '';

  const venue =
    game.venue ||
    game.stadium ||
    '';

  if (!date && !time && !venue) {
    return;
  }

  drawGoldLine(
    ctx,
    115,
    800,
    965
  );

  ctx.textAlign =
    'left';

  ctx.fillStyle =
    '#f5f7f8';

  ctx.font =
    '700 25px Arial';

  if (date) {
    ctx.fillText(
      '▣  ' + date,
      130,
      850
    );
  }

  if (time) {
    ctx.fillText(
      '◷  ' + time,
      430,
      850
    );
  }

  if (venue) {
    ctx.font =
      '700 22px Arial';

    wrap(
      ctx,
      '◉  ' + venue,
      650,
      840,
      300,
      28,
      2
    );
  }
}


/* =========================================================
   CARTÃO DO ÁRBITRO
   ========================================================= */

function drawOfficialCard(
  ctx,
  official,
  x,
  y,
  w,
  h
) {
  const photo =
    state.assets.get(
      'p:' + compact(official.name)
    ) || null;

  /*
   * O cartão é deliberadamente vertical.
   * A fotografia domina a composição e o texto fica
   * numa zona própria, para nunca competir com a pessoa.
   */
  const compactCard =
    w < 500 || h < 500;

  const textH =
    compactCard
      ? Math.min(105, Math.max(88, h * 0.28))
      : Math.min(155, Math.max(125, h * 0.21));

  const frameX =
    x + (compactCard ? 18 : 34);

  const frameW =
    w - (compactCard ? 36 : 68);

  const frameY =
    y + (compactCard ? 10 : 18);

  const frameH =
    Math.max(
      110,
      h - textH - (compactCard ? 22 : 38)
    );

  /*
   * Sombra/moldura.
   */
  ctx.save();

  ctx.shadowColor =
    'rgba(0,0,0,.28)';

  ctx.shadowBlur =
    compactCard ? 10 : 18;

  ctx.shadowOffsetY =
    compactCard ? 4 : 8;

  ctx.fillStyle =
    '#f4f1e9';

  ctx.fillRect(
    frameX,
    frameY,
    frameW,
    frameH
  );

  ctx.restore();

  /*
   * Área interior. Não fazemos clip à pessoa:
   * a transparência permite que a cabeça/ombros
   * ultrapassem ligeiramente a moldura.
   */
  const innerX =
    frameX + (compactCard ? 8 : 12);

  const innerY =
    frameY + (compactCard ? 8 : 12);

  const innerW =
    frameW - (compactCard ? 16 : 24);

  const innerH =
    frameH - (compactCard ? 16 : 24);

  if (photo) {
    const iw =
      photo.naturalWidth ||
      photo.width ||
      1;

    const ih =
      photo.naturalHeight ||
      photo.height ||
      1;

    /*
     * A pessoa é dimensionada pela altura e pela largura,
     * mas nunca fica pequena dentro do cartão.
     */
    const maxW =
      innerW * (
        compactCard
          ? 0.94
          : 0.88
      );

    const maxH =
      innerH * (
        compactCard
          ? 1.10
          : 1.12
      );

    const scale =
      Math.min(
        maxW / iw,
        maxH / ih
      );

    const dw =
      iw * scale;

    const dh =
      ih * scale;

    /*
     * Anchor inferior: os pés/corpo ficam naturalmente
     * assentes no fundo da fotografia.
     */
    const dx =
      frameX +
      (frameW - dw) / 2;

    const dy =
      frameY +
      frameH -
      dh +
      (
        compactCard
          ? 18
          : 28
      );

    ctx.save();

    ctx.globalAlpha = 1;

    ctx.drawImage(
      photo,
      dx,
      dy,
      dw,
      dh
    );

    ctx.restore();

  } else {
    ctx.fillStyle =
      '#596b73';

    ctx.fillRect(
      innerX,
      innerY,
      innerW,
      innerH
    );
  }

  /*
   * Zona textual.
   *
   * Cores exatamente alinhadas com o resto da publicação:
   * dourado #e7b63d + branco #f5f7f8.
   */
  const textY =
    y + h - textH;

  ctx.fillStyle =
    'rgba(16,34,43,.97)';

  ctx.fillRect(
    x,
    textY,
    w,
    textH
  );

  ctx.fillStyle =
    '#e7b63d';

  ctx.fillRect(
    x,
    textY,
    w,
    4
  );

  const centerX =
    x + w / 2;

  const role =
    String(
      official.role || 'Árbitro'
    )
      .toUpperCase();

  const name =
    String(
      official.name || ''
    )
      .toUpperCase();

  /*
   * Lettering: hierarquia visual consistente.
   */
  const roleSize =
    fit(
      ctx,
      role,
      w - 30,
      compactCard ? 18 : 25,
      14
    );

  const nameSize =
    fit(
      ctx,
      name,
      w - 30,
      compactCard ? 28 : 44,
      compactCard ? 19 : 25
    );

  const afSize =
    fit(
      ctx,
      'A.F. COIMBRA',
      w - 30,
      compactCard ? 15 : 21,
      12
    );

  ctx.textAlign =
    'center';

  const roleLine =
    roleSize + 4;

  const nameLines =
    wrapLines(
      ctx,
      name,
      w - 30,
      compactCard ? 2 : 2
    );

  const nameLineHeight =
    nameSize + 2;

  const totalTextH =
    roleLine +
    7 +
    nameLines.length *
      nameLineHeight +
    6 +
    afSize;

  let cursorY =
    textY +
    Math.max(
      14,
      (textH - totalTextH) / 2
    );

  ctx.fillStyle =
    '#e7b63d';

  ctx.font =
    `800 ${roleSize}px Arial`;

  ctx.fillText(
    role,
    centerX,
    cursorY + roleSize
  );

  cursorY +=
    roleLine + 7;

  ctx.fillStyle =
    '#f5f7f8';

  ctx.font =
    `900 ${nameSize}px Arial`;

  for (const line of nameLines) {
    ctx.fillText(
      line,
      centerX,
      cursorY + nameSize
    );

    cursorY +=
      nameLineHeight;
  }

  cursorY += 6;

  ctx.fillStyle =
    '#e7b63d';

  ctx.font =
    `700 ${afSize}px Arial`;

  ctx.fillText(
    'A.F. COIMBRA',
    centerX,
    cursorY + afSize
  );
}


/* =========================================================
   NOME DA COMPETIÇÃO
   ========================================================= */

function displayCompetition(
  competition = ''
) {
  const n =
    normalizeText(competition);

  let title =
    competition.trim();

  let detail = '';

  if (n.includes('liga 3')) {
    title = 'LIGA 3';

    detail =
      competition
        .replace(
          /.*?liga\s*3\s*/i,
          ''
        )
        .replace(
          /^[-–—•|]+\s*/,
          ''
        )
        .trim();

  } else if (n.includes('liga placard')) {
    title =
      'LIGA PLACARD';

    detail =
      competition
        .replace(
          /.*?liga\s*placard\s*/i,
          ''
        )
        .replace(
          /^[-–—•|]+\s*/,
          ''
        )
        .trim();

  } else if (n.includes('liga bpi')) {
    title =
      'LIGA BPI';

    detail =
      competition
        .replace(
          /.*?liga\s*bpi\s*/i,
          ''
        )
        .replace(
          /^[-–—•|]+\s*/,
          ''
        )
        .trim();

  } else if (n.includes('supertaca')) {
    title =
      'SUPERTAÇA';

    detail =
      competition
        .replace(
          /.*?supertaca\s*/i,
          ''
        )
        .replace(
          /^[-–—•|]+\s*/,
          ''
        )
        .trim();

  } else {
    const parts =
      competition.split(/\s+-\s+/);

    if (parts.length > 1) {
      title =
        parts.shift().trim();

      detail =
        parts
          .join(' • ')
          .trim();
    }
  }

  return {
    title,
    detail
  };
}


/* =========================================================
   TÍTULO DA COMPETIÇÃO
   ========================================================= */

function drawCompetitionTitle(
  ctx,
  comp
) {
  const centerX = 540;

  /*
   * Pequeno título "COMPETIÇÃO".
   */
  ctx.textAlign =
    'center';

  ctx.fillStyle =
    '#e7b63d';

  ctx.font =
    '700 23px Arial';

  ctx.fillText(
    'COMPETIÇÃO',
    centerX,
    225
  );

  /*
   * Título principal.
   */
  const titleY = 315;

  const match =
    comp.title.match(
      /^(.*?)(\d+)$/
    );

  if (match) {
    const left =
      match[1].trimEnd();

    const num =
      match[2];

    const titleSize = 112;

    ctx.font =
      `900 ${titleSize}px Arial`;

    const gap = 10;

    const leftW =
      ctx.measureText(left).width;

    const numW =
      ctx.measureText(num).width;

    const totalW =
      leftW +
      gap +
      numW;

    let x =
      centerX -
      totalW / 2;

    /*
     * Parte textual.
     */
    ctx.textAlign =
      'left';

    ctx.fillStyle =
      '#f5f7f8';

    ctx.fillText(
      left,
      x,
      titleY
    );

    /*
     * Número.
     */
    x +=
      leftW +
      gap;

    ctx.fillStyle =
      '#e7b63d';

    ctx.fillText(
      num,
      x,
      titleY
    );

  } else {
    const titleSize =
      fit(
        ctx,
        comp.title,
        860,
        108,
        54
      );

    ctx.textAlign =
      'center';

    ctx.font =
      `900 ${titleSize}px Arial`;

    ctx.fillStyle =
      '#f5f7f8';

    ctx.fillText(
      comp.title,
      centerX,
      titleY
    );
  }

  /*
   * Linha dourada.
   */
  drawGoldLine(
    ctx,
    300,
    365,
    780
  );

  /*
   * ======================================================
   * SUBTÍTULO / SEGUNDA FRASE
   * ======================================================
   *
   * É medido e centrado pelo tamanho real.
   */
  if (comp.detail) {
    const detailSize =
      fit(
        ctx,
        comp.detail,
        850,
        25,
        15
      );

    ctx.font =
      `700 ${detailSize}px Arial`;

    ctx.textAlign =
      'center';

    ctx.fillStyle =
      '#f5f7f8';

    ctx.fillText(
      comp.detail,
      centerX,
      415
    );
  }
}


/* =========================================================
   RENDER FINAL
   ========================================================= */

function render(game) {
  const canvas =
    document.createElement('canvas');

  canvas.width = 1080;
  canvas.height = 1920;

  const ctx =
    canvas.getContext('2d');

  /*
   * ======================================================
   * BACKGROUND
   * ======================================================
   */

  const bg =
    state.assets.get(
      'background'
    );

  if (bg) {
    ctx.drawImage(
      bg,
      0,
      0,
      1080,
      1920
    );
  } else {
    ctx.fillStyle =
      '#10222b';

    ctx.fillRect(
      0,
      0,
      1080,
      1920
    );
  }


  /*
   * ======================================================
   * HASHTAG
   * ======================================================
   *
   * IMPORTANTE:
   *
   * O logótipo "NÚCLEO DE ÁRBITROS..."
   * está no canto superior direito do background.
   *
   * Por isso o hashtag NÃO usa o centro absoluto
   * de 540px.
   *
   * A área disponível termina antes do logótipo.
   *
   * O texto é calculado pela largura real para nunca
   * sobrepor nem sair da área.
   */

  const hashtag =
    '#TambemEstamos';

  const hashtag2 =
    'EmJogo';

  /*
   * Área segura do hashtag.
   *
   * Mantemos o lado direito afastado do logótipo.
   */
  const hashtagAreaLeft = 130;
  const hashtagAreaRight = 850;

  const hashtagAreaWidth =
    hashtagAreaRight -
    hashtagAreaLeft;

  const hashtagGap = 14;

  const hashtagFontSize =
    fitItalic(
      ctx,
      hashtag + hashtag2,
      hashtagAreaWidth - 20,
      52,
      34
    );

  ctx.font =
    `900 italic ${hashtagFontSize}px Arial`;

  const hashtagW =
    ctx.measureText(
      hashtag
    ).width;

  const hashtag2W =
    ctx.measureText(
      hashtag2
    ).width;

  const totalHashtagWidth =
    hashtagW +
    hashtagGap +
    hashtag2W;

  /*
   * Centro da área segura, e não o centro
   * do canvas inteiro.
   */
  let hashtagX =
    hashtagAreaLeft +
    (
      hashtagAreaWidth -
      totalHashtagWidth
    ) / 2;

  ctx.textAlign =
    'left';

  /*
   * Primeira parte.
   */
  ctx.fillStyle =
    '#f5f7f8';

  ctx.fillText(
    hashtag,
    hashtagX,
    155
  );

  /*
   * Segunda parte.
   */
  hashtagX +=
    hashtagW +
    hashtagGap;

  ctx.fillStyle =
    '#e7b63d';

  ctx.fillText(
    hashtag2,
    hashtagX,
    155
  );


  /*
   * ======================================================
   * COMPETIÇÃO
   * ======================================================
   */

  const comp =
    displayCompetition(
      game.competition
    );

  drawCompetitionTitle(
    ctx,
    comp
  );


  /*
   * ======================================================
   * EQUIPAS
   * ======================================================
   */

  const homeShield =
    state.assets.get(
      's:' + compact(game.home)
    ) || null;

  const awayShield =
    state.assets.get(
      's:' + compact(game.away)
    ) || null;

  drawTeamBlock(
    ctx,
    game,
    homeShield,
    awayShield
  );


  /*
   * ======================================================
   * DATA / LOCAL
   * ======================================================
   */

  drawMatchInfo(
    ctx,
    game
  );


  /*
   * ======================================================
   * OFICIAIS
   * ======================================================
   */

  const officials =
    game.officials.slice(0, 4);

  const count =
    Math.max(
      1,
      officials.length
    );

  const top =
    (
      game.date ||
      game.matchDate ||
      game.time ||
      game.matchTime ||
      game.venue ||
      game.stadium
    )
      ? 865
      : 815;

  const bottom =
    1765;

  const areaH =
    bottom - top;

  /*
   * Layouts dedicados.
   *
   * Não dividimos simplesmente a altura pelo número
   * de árbitros: cada quantidade recebe uma composição
   * própria para Instagram 1080x1920.
   */
  if (count === 1) {
    const w = 760;
    const h = Math.min(820, areaH - 35);

    drawOfficialCard(
      ctx,
      officials[0],
      (1080 - w) / 2,
      top + (areaH - h) / 2,
      w,
      h
    );

  } else if (count === 2) {
    const gap = 28;
    const w = Math.floor(
      (900 - gap) / 2
    );

    const h =
      Math.min(
        820,
        areaH - 30
      );

    const x1 =
      (1080 - (w * 2 + gap)) / 2;

    drawOfficialCard(
      ctx,
      officials[0],
      x1,
      top + (areaH - h) / 2,
      w,
      h
    );

    drawOfficialCard(
      ctx,
      officials[1],
      x1 + w + gap,
      top + (areaH - h) / 2,
      w,
      h
    );

  } else if (count === 3) {
    const gap = 18;
    const w = Math.floor(
      (940 - gap * 2) / 3
    );

    const h =
      Math.min(
        820,
        areaH - 28
      );

    const totalW =
      w * 3 + gap * 2;

    const x0 =
      (1080 - totalW) / 2;

    officials.forEach(
      (official, i) => {
        drawOfficialCard(
          ctx,
          official,
          x0 + i * (w + gap),
          top + (areaH - h) / 2,
          w,
          h
        );
      }
    );

  } else {
    /*
     * Quatro oficiais: grelha 2x2.
     * Assim cada fotografia continua a ter presença
     * visual e o espaço não fica comprimido em quatro
     * faixas horizontais.
     */
    const gapX = 24;
    const gapY = 24;

    const w = 440;
    const h = Math.min(
      405,
      Math.floor(
        (areaH - gapY) / 2
      )
    );

    const totalW =
      w * 2 + gapX;

    const x0 =
      (1080 - totalW) / 2;

    const totalH =
      h * 2 + gapY;

    const y0 =
      top +
      Math.max(
        0,
        (areaH - totalH) / 2
      );

    officials.forEach(
      (official, i) => {
        const col =
          i % 2;

        const row =
          Math.floor(i / 2);

        drawOfficialCard(
          ctx,
          official,
          x0 + col * (w + gapX),
          y0 + row * (h + gapY),
          w,
          h
        );
      }
    );
  }


  /*
   * ======================================================
   * RODAPÉ
   * ======================================================
   */

  drawGoldLine(
    ctx,
    130,
    1810,
    950
  );

  ctx.textAlign =
    'center';

  ctx.fillStyle =
    '#f5f7f8';

  ctx.font =
    '700 23px Arial';

  ctx.fillText(
    'TRABALHO  •  COMPETÊNCIA  •  DEDICAÇÃO',
    540,
    1860
  );

  return canvas;
}


/* =========================================================
   RESULTADOS
   ========================================================= */

function showGames() {
  $('results').innerHTML =
    state.games
      .map(g => `
        <div class="result">
          <b>${escapeHtml(g.home)}</b>
          <span>vs</span>
          <b>${escapeHtml(g.away)}</b>

          <small>
            ${escapeHtml(g.competition)}
          </small>

          <p>
            ${g.officials
              .map(o =>
                escapeHtml(o.name) +
                ' — ' +
                escapeHtml(o.role)
              )
              .join('<br>')}
          </p>
        </div>
      `)
      .join('');
}


/* =========================================================
   VERIFICAÇÃO DOS ASSETS
   ========================================================= */

async function checkAssets(games) {
  await loadIdentity();

  const missing = [];

  /*
   * Logo.
   */
  if (!state.assets.has('logo')) {
    missing.push({
      type: 'logo',
      key: 'logo'
    });
  }

  /*
   * Fotografias.
   */
  const people =
    [
      ...new Map(
        games.flatMap(
          g =>
            g.officials.map(
              o => [
                compact(o.name),
                o.name
              ]
            )
        )
      ).values()
    ];

  const photoResults =
    await Promise.all(
      people.map(
        async name => [
          name,
          await personImage(name)
        ]
      )
    );

  for (const [name, img] of photoResults) {
    if (!img) {
      missing.push({
        type: 'foto',
        key: name
      });
    }
  }

  /*
   * Escudos.
   *
   * NÃO fazemos pesquisa online aqui.
   *
   * O prefetchShields() já tratou:
   *
   * local → online
   *
   * antes de chegarmos à geração.
   */
  for (const g of games) {
    if (
      !state.assets.has(
        's:' + compact(g.home)
      )
    ) {
      missing.push({
        type: 'escudo',
        key: g.home
      });
    }

    if (
      !state.assets.has(
        's:' + compact(g.away)
      )
    ) {
      missing.push({
        type: 'escudo',
        key: g.away
      });
    }
  }

  const unique =
    [
      ...new Map(
        missing.map(
          x => [
            x.type +
              ':' +
              compact(x.key),
            x
          ]
        )
      ).values()
    ];

  /*
   * Escudos não bloqueiam a geração.
   * Fotografias/logo bloqueiam.
   */
  const blocking =
    unique.filter(
      x => x.type !== 'escudo'
    );

  if (blocking.length) {
    renderMissing(blocking);
    return false;
  }

  if (unique.length) {
    renderMissing(unique);
  } else {
    $('missingAssets').hidden =
      true;
  }

  return true;
}


/* =========================================================
   FICHEIROS EM FALTA
   ========================================================= */

function renderMissing(items) {
  const unique =
    [
      ...new Map(
        items.map(
          x => [
            x.type +
              ':' +
              compact(x.key),
            x
          ]
        )
      ).values()
    ];

  $('missingAssets').hidden =
    false;

  $('missingAssets').innerHTML = `
    <div class="missingBox">
      <h3>Faltam ficheiros antes de gerar</h3>

      <p>
        O gerador bloqueia a criação para não sair
        uma publicação incompleta.
      </p>

      ${unique
        .map(
          x => `
            <div class="missingRow">
              <span>
                <b>
                  ${
                    x.type === 'foto'
                      ? 'Fotografia'
                      : x.type === 'escudo'
                        ? 'Escudo'
                        : 'Logo'
                  }
                </b>:
                ${escapeHtml(x.key)}
              </span>

              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-key="${escapeHtml(
                  x.type + '|' + x.key
                )}"
              >
            </div>
          `
        )
        .join('')}

      <button
        id="useMissing"
        class="secondary"
      >
        Usar ficheiros nesta sessão
      </button>
    </div>
  `;

  $('useMissing').onclick =
    async () => {
      for (
        const input of
        $('missingAssets')
          .querySelectorAll(
            'input[type=file]'
          )
      ) {
        if (!input.files[0]) {
          continue;
        }

        const [
          type,
          key
        ] =
          input.dataset.key
            .split('|');

        if (type === 'foto') {
          setStatus(
            `A preparar a fotografia de ${key}...`
          );

          const result =
            await processAndStorePhoto(
              key,
              input.files[0]
            );

          if (!result?.img) {
            setError(
              `Não foi possível processar a fotografia de ${key}.`
            );
            continue;
          }

          setStatus(
            result.saved
              ? `Fotografia de ${key} processada e guardada na biblioteca.`
              : `Fotografia de ${key} processada para esta sessão.`
          );

          continue;
        }

        const img =
          await fileToImage(
            input.files[0]
          );

        state.assets.set(
          type === 'escudo'
            ? 's:' + compact(key)
            : 'logo',
          img
        );
      }

      setStatus(
        'Ficheiros carregados. Podes gerar novamente.'
      );
    };
}


/* =========================================================
   FICHEIRO → IMAGEM
   ========================================================= */

function fileToImage(file) {
  return new Promise(
    (resolve, reject) => {
      const u =
        URL.createObjectURL(file);

      const img =
        new Image();

      img.onload = () => {
        URL.revokeObjectURL(u);
        resolve(img);
      };

      img.onerror =
        reject;

      img.src = u;
    }
  );
}


/* =========================================================
   ANALISAR PDF
   ========================================================= */

async function analyze() {
  const file =
    $('pdfFile').files[0];

  if (!file) {
    return setError(
      'Escolhe primeiro o PDF da FPF.'
    );
  }

  const names =
    $('names')
      .value
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

  if (!names.length) {
    return setError(
      'Coloca pelo menos um nome na lista.'
    );
  }

  state.names =
    new Map(
      names.map(
        n => [
          compact(n),
          n
        ]
      )
    );

  state.assets.clear();

  setStatus(
    'A ler o PDF e a reconstruir as nomeações...'
  );

  try {
    /*
     * PDF.
     */
    const data =
      await extractPDF(file);

    state.pages =
      data.pages;

    state.games =
      parsePages(data.pages);

    if (!state.games.length) {
      return setError(
        `PDF lido (${data.numPages} páginas), ` +
        `mas não foi encontrado nenhum jogo ` +
        `com os nomes indicados.`
      );
    }

    showGames();

    /*
     * Identidade / background.
     */
    await loadIdentity();

    /*
     * Fotografias locais em paralelo.
     */
    const people =
      [
        ...new Map(
          state.games.flatMap(
            g =>
              g.officials.map(
                o => [
                  compact(o.name),
                  o.name
                ]
              )
          )
        ).values()
      ];

    await Promise.all(
      people.map(
        name =>
          personImage(name)
      )
    );

    /*
     * ======================================================
     * ESCUDOS
     * ======================================================
     *
     * A ordem é:
     *
     * TODOS locais
     *       ↓
     * identificar faltantes
     *       ↓
     * online apenas para faltantes
     */

    const warmup =
      prefetchShields(
        state.games
      );

    /*
     * Não bloqueamos a aplicação por mais de 12 segundos.
     * Se chegar ao limite, o processo de pesquisa continua
     * em background.
     */
    const limit =
      new Promise(
        resolve =>
          setTimeout(
            () =>
              resolve({
                timeout: true
              }),
            12000
          )
      );

    const result =
      await Promise.race([
        warmup,
        limit
      ]);

    $('generateBtn').disabled =
      false;

    if (result?.timeout) {
      setStatus(
        'Pronto. A pesquisa dos escudos ' +
        'demorou mais de 12 s; a aplicação não ' +
        'fica bloqueada. Os escudos continuam a ' +
        'ser preparados em segundo plano.'
      );
    } else {
      setStatus(
        `Pronto: ${state.games.length} jogo(s), ` +
        `${result.found}/${result.total} escudos preparados. ` +
        `Local: ${result.local}. ` +
        `Online: ${result.online}. ` +
        `Tempo: ${result.seconds.toFixed(1)} s.`
      );
    }

  } catch (e) {
    console.error(e);

    setError(
      'Erro ao ler o PDF: ' +
      (e?.message || e)
    );
  }
}


/* =========================================================
   GERAR TODOS
   ========================================================= */

async function generateAll() {
  if (!state.games.length) {
    return;
  }

  const started =
    performance.now();

  /*
   * NÃO há pesquisa de escudos aqui.
   */
  const ok =
    await checkAssets(
      state.games
    );

  if (!ok) {
    return;
  }

  setStatus(
    'A gerar os JPG — sem pesquisas externas...'
  );

  const zip =
    new JSZip();

  const batchSize = 4;

  for (
    let i = 0;
    i < state.games.length;
    i += batchSize
  ) {
    const batch =
      state.games.slice(
        i,
        i + batchSize
      );

    const blobs =
      await Promise.all(
        batch.map(
          async g => {
            const canvas =
              render(g);

            const blob =
              await new Promise(
                resolve =>
                  canvas.toBlob(
                    resolve,
                    'image/jpeg',
                    .92
                  )
              );

            return {
              g,
              blob
            };
          }
        )
      );

    for (const {
      g,
      blob
    } of blobs) {
      zip.file(
        safeFile(
          `${String(
            state.games.indexOf(g) + 1
          ).padStart(2, '0')} - ` +
          `${g.home} - ${g.away}.jpg`
        ).slice(0, 150),
        blob,
        {
          compression: 'STORE'
        }
      );
    }

    const elapsed =
      (performance.now() - started) /
      1000;

    setStatus(
      `A gerar JPG ` +
      `${Math.min(
        i + batchSize,
        state.games.length
      )}/${state.games.length}... ` +
      `${elapsed.toFixed(1)} s`
    );

    if (elapsed > 30) {
      setError(
        'A geração ultrapassou 30 segundos. ' +
        'A causa provável é a codificação do JPEG/ZIP ' +
        'no navegador, não a pesquisa dos escudos.'
      );

      return;
    }
  }

  const out =
    await zip.generateAsync({
      type: 'blob',
      compression: 'STORE'
    });

  const elapsed =
    (performance.now() - started) /
    1000;

  if (elapsed > 30) {
    setError(
      `A geração terminou em ${elapsed.toFixed(1)} s. ` +
      'A demora ocorreu na criação do ZIP, ' +
      'porque os JPG já estavam gerados.'
    );
  }

  download(
    out,
    'Nomeacoes_Marques_Bom.zip'
  );

  setStatus(
    `Concluído: ${state.games.length} JPG(s) ` +
    `gerados em ${elapsed.toFixed(1)} s.`
  );
}


/* =========================================================
   GERAÇÃO MANUAL
   ========================================================= */

async function generateManual() {
  const home =
    $('mHome').value.trim();

  const away =
    $('mAway').value.trim();

  const competition =
    $('mCompetition').value.trim();

  if (
    !home ||
    !away ||
    !competition
  ) {
    return setError(
      'Preenche competição e as duas equipas.'
    );
  }

  const officials =
    [
      ...document.querySelectorAll(
        '.manualOfficial'
      )
    ]
      .map(r => ({
        name:
          r.querySelector(
            '.mName'
          ).value.trim(),

        role:
          r.querySelector(
            '.mRole'
          ).value.trim() ||
          'Árbitro'
      }))
      .filter(x => x.name);

  if (!officials.length) {
    return setError(
      'Adiciona pelo menos um oficial.'
    );
  }

  const g = {
    home,
    away,
    competition,
    officials,
    date:
      $('mDate').value.trim()
  };

  await loadIdentity();

  /*
   * Fotografias.
   */
  await Promise.all(
    officials.map(
      o =>
        personImage(o.name)
    )
  );

  /*
   * Escudos:
   *
   * local primeiro
   * online depois
   */
  await Promise.race([
    prefetchShields([g]),

    new Promise(
      resolve =>
        setTimeout(
          resolve,
          12000
        )
    )
  ]);

  const ok =
    await checkAssets([g]);

  if (!ok) {
    return;
  }

  const started =
    performance.now();

  const canvas =
    render(g);

  const blob =
    await new Promise(
      r =>
        canvas.toBlob(
          r,
          'image/jpeg',
          .92
        )
    );

  const elapsed =
    (performance.now() - started) /
    1000;

  if (elapsed > 30) {
    setError(
      `A nomeação manual demorou ` +
      `${elapsed.toFixed(1)} s na codificação do JPG.`
    );

    return;
  }

  download(
    blob,
    safeFile(
      `${home} - ${away}.jpg`
    )
  );

  setStatus(
    `Nomeação manual gerada em ` +
    `${elapsed.toFixed(1)} s.`
  );
}


/* =========================================================
   DOWNLOAD
   ========================================================= */

function download(
  blob,
  name
) {
  const u =
    URL.createObjectURL(blob);

  const a =
    document.createElement('a');

  a.href = u;
  a.download = name;

  document.body.appendChild(a);

  a.click();

  a.remove();

  setTimeout(
    () =>
      URL.revokeObjectURL(u),
    1500
  );
}


/* =========================================================
   OFICIAIS MANUAIS
   ========================================================= */

function addManualOfficial(
  role = 'Árbitro'
) {
  const row =
    document.createElement('div');

  row.className =
    'manualOfficial';

  row.innerHTML = `
    <input
      class="mName"
      placeholder="Nome"
    >

    <input
      class="mRole"
      value="${escapeHtml(role)}"
    >

    <button type="button">
      ×
    </button>
  `;

  row.querySelector(
    'button'
  ).onclick =
    () => row.remove();

  $('manualOfficials')
    .appendChild(row);
}


/* =========================================================
   ROUTER
   ========================================================= */

function route() {
  const manual =
    location.hash === '#manual';

  $('pdfSection').hidden =
    manual;

  $('manualSection').hidden =
    !manual;

  $('pdfBtn').classList.toggle(
    'active',
    !manual
  );

  $('manualBtn').classList.toggle(
    'active',
    manual
  );
}


/* =========================================================
   INIT
   ========================================================= */

async function init() {
  await loadIdentity();

  $('analyzeBtn').onclick =
    analyze;

  $('generateBtn').onclick =
    generateAll;

  $('pdfFile').onchange =
    e => {
      $('fileName').textContent =
        e.target.files[0]?.name ||
        '';
    };

  $('manualBtn').onclick =
    () => {
      location.hash =
        '#manual';
    };

  $('pdfBtn').onclick =
    () => {
      location.hash =
        '#pdf';
    };

  $('addOfficial').onclick =
    () =>
      addManualOfficial();

  $('manualGenerate').onclick =
    generateManual;

  addManualOfficial();

  window.onhashchange =
    route;

  route();
}

init();
