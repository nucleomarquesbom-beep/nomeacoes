import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = id => document.getElementById(id);
const state = { pages: [], games: [], names: new Map(), assets: new Map() };

// Colunas reais do PDF FPF: Jogo | Árbitro | Associação.
const PDF_GAME_MAX_X = 280;
const PDF_OFFICIAL_MAX_X = 469;

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
function parsePage(page) {
  const games = [];
  let competition = '';
  let current = null;
  let table = false;

  function pushCurrent() {
    const game = finalizeGame(current);
    if (game) games.push(game);
    current = null;
  }

  for (let i = 0; i < page.lines.length; i++) {
    const text = page.lines[i].text.trim();
    if (!text) continue;

    if (isHeader(text)) {
      pushCurrent();
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
      continue;
    }

    if (isCompetition(text) && !hasAssociation(text)) {
      pushCurrent();
      competition = text;
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

    const withoutAssociation = removeAssociation(text);
    const listed = findListedInText(withoutAssociation);

    /*
     * CASO 1 — jogo + primeiro oficial.
     * As coordenadas separam as colunas; a procura do árbitro é feita
     * primeiro na coluna Árbitro e depois, como fallback, na linha.
     */
    if (looksLikeGameLine(text)) {
      const items = page.lines[i].items || [];

      const gameItems = items
        .filter(it => it.x < PDF_GAME_MAX_X)
        .sort((a, b) => a.x - b.x);

      const officialItems = items
        .filter(it => it.x >= PDF_GAME_MAX_X && it.x < PDF_OFFICIAL_MAX_X)
        .sort((a, b) => a.x - b.x);

      const gameText = gameItems.map(it => it.text).join(' ')
        .replace(/\s+/g, ' ').trim();

      const officialText = officialItems.map(it => it.text).join(' ')
        .replace(/\s+/g, ' ').trim();

      const parts = splitGamePrefix(gameText);

      if (parts) {
        pushCurrent();

        // Primeiro: apenas a coluna do árbitro.
        let listedFirst = findListedName(officialText);

        // Fallback: linha completa, mas sem associação.
        if (!listedFirst) {
          listedFirst = findListedName(removeAssociation(text));
        }

        current = {
          competition,
          home: parts.home,
          away: parts.away,
          officials: [{
            name: listedFirst || null,
            position: 0
          }],
          observer: null,
          page: page.page
        };

        continue;
      }

      // Fallback para PDFs com coordenadas diferentes.
      const fallbackListed = findListedInText(removeAssociation(text));

      if (fallbackListed) {
        const line = normalizeText(removeAssociation(text));
        const name = normalizeText(fallbackListed.name);
        const p = line.indexOf(name);

        if (p >= 0) {
          const before = removeAssociation(text).slice(0, p);
          const fallbackParts = splitGamePrefix(before);

          if (fallbackParts) {
            pushCurrent();

            current = {
              competition,
              home: fallbackParts.home,
              away: fallbackParts.away,
              officials: [{
                name: fallbackListed.name,
                position: 0
              }],
              observer: null,
              page: page.page
            };

            continue;
          }
        }
      }
    }

    /*
     * Caso 2:
     * Linha apenas com um oficial:
     *
     * NUNO GUERRA A.F. COIMBRA
     */
    if (looksLikeOfficialLine(text) && current) {
      const items = page.lines[i].items || [];

      const officialItems = items
        .filter(it => it.x >= PDF_GAME_MAX_X && it.x < PDF_OFFICIAL_MAX_X)
        .sort((a, b) => a.x - b.x);

      const officialText = officialItems.map(it => it.text).join(' ')
        .replace(/\s+/g, ' ').trim();

      let listed = findListedName(officialText);

      if (!listed) {
        listed = findListedName(withoutAssociation);
      }

      const position = current.officials.length;

      current.officials.push({
        name: listed || null,
        position
      });

      continue;
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
    '/assets/fundo_marques_bom.jpg',
    '/assets/fundo_nomeacao.png'
  ]);
}

function personUrls(name) {
  const f = safeFile(name);

  return [
    `/fotografias/${f}.jpg`,
    `/fotografias/${f}.jpeg`,
    `/fotografias/${f}.png`,
    `/fotografias/${f}.webp`
  ];
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

async function shieldImage(team) {
  const key = 's:' + compact(team);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  for (const v of teamVariants(team)) {
    const f = safeFile(v);

    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const img = await tryImage(`/escudos/${f}.${ext}?v=2`);

      if (img) {
        state.assets.set(key, img);
        return img;
      }
    }
  }

  return null;
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

async function render(game) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;

  const ctx = canvas.getContext('2d');

  const bg = state.assets.get('background');

  if (bg) {
    ctx.drawImage(bg, 0, 0, 1080, 1920);
  } else {
    ctx.fillStyle = '#1d2b32';
    ctx.fillRect(0, 0, 1080, 1920);
  }

  const logo = state.assets.get('logo');

  if (logo) {
    drawContain(ctx, logo, 55, 35, 165, 165);
  }

  ctx.fillStyle = '#f5f7f8';
  ctx.textAlign = 'left';
  ctx.font = '700 20px Arial';
  ctx.fillText(
    'NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA',
    245,
    65
  );

  ctx.font = '700 62px Arial';
  ctx.fillText('NOMEAÇÃO', 245, 145);

  ctx.fillStyle = '#e7b63d';
  ctx.font = '700 28px Arial';
  wrap(ctx, game.competition, 60, 260, 960, 38, 3);

  ctx.fillStyle = '#f5f7f8';
  ctx.font = '700 30px Arial';

  wrap(ctx, game.home, 70, 420, 400, 38, 2);
  wrap(ctx, game.away, 610, 420, 400, 38, 2);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e7b63d';
  ctx.font = '700 38px Arial';
  ctx.fillText('VS', 540, 450);
  ctx.textAlign = 'left';

  const [homeShield, awayShield] = await Promise.all([
    shieldImage(game.home),
    shieldImage(game.away)
  ]);

  drawContain(ctx, homeShield, 130, 485, 270, 230);
  drawContain(ctx, awayShield, 680, 485, 270, 230);

  const count = game.officials.length;
  const h =
    count <= 1 ? 340 :
    count === 2 ? 285 :
    count === 3 ? 235 :
    count === 4 ? 205 : 175;

  const start = 775;

  for (let i = 0; i < count; i++) {
    const o = game.officials[i];
    const y = start + i * (h + 18);

    ctx.fillStyle = 'rgba(13,24,30,.86)';
    ctx.beginPath();
    ctx.roundRect(45, y, 990, h, 26);
    ctx.fill();

    ctx.strokeStyle = 'rgba(231,182,61,.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const photo = await personImage(o.name);

    if (photo) {
      drawCover(ctx, photo, 75, y + 25, 220, h - 50, 18);
    } else {
      ctx.fillStyle = '#60727b';
      ctx.fillRect(75, y + 25, 220, h - 50);
    }

    ctx.fillStyle = '#e7b63d';
    ctx.font = `700 ${count <= 2 ? 25 : 19}px Arial`;
    ctx.fillText(o.role.toUpperCase(), 330, y + 70);

    ctx.fillStyle = '#f5f7f8';

    const sz = fit(
      ctx,
      o.name,
      640,
      count <= 2 ? 50 : 40
    );

    ctx.font = `700 ${sz}px Arial`;
    wrap(ctx, o.name, 330, y + 145, 640, sz + 8, 2);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f7f8';
  ctx.font = '700 21px Arial';
  ctx.fillText(
    'TRABALHO, COMPETÊNCIA E DEDICAÇÃO',
    540,
    1840
  );

  ctx.fillStyle = '#e7b63d';
  ctx.font = '700 15px Arial';
  ctx.fillText(
    '#MARQUESBOM  #ARBITRAGEM  #NOMEAÇÕES',
    540,
    1875
  );

  ctx.textAlign = 'left';

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

  if (!state.assets.has('logo')) {
    missing.push({ type: 'logo', key: 'logo' });
  }

  for (const g of games) {
    if (!await shieldImage(g.home)) {
      missing.push({ type: 'escudo', key: g.home });
    }

    if (!await shieldImage(g.away)) {
      missing.push({ type: 'escudo', key: g.away });
    }

    for (const o of g.officials) {
      if (!await personImage(o.name)) {
        missing.push({ type: 'foto', key: o.name });
      }
    }
  }

  if (missing.length) {
    renderMissing(missing);
    return false;
  }

  $('missingAssets').hidden = true;
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

  if (!file) {
    return setError('Escolhe primeiro o PDF da FPF.');
  }

  const names = $('names').value
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!names.length) {
    return setError('Coloca pelo menos um nome na lista.');
  }

  state.names = new Map(
    names.map(n => [compact(n), n])
  );

  setStatus('A ler o PDF e a reconstruir as nomeações...');

  try {
    const data = await extractPDF(file);

    state.pages = data.pages;
    state.games = parsePages(data.pages);

    if (!state.games.length) {
      return setError(
        `PDF lido (${data.numPages} páginas), mas não foi encontrado nenhum jogo com os nomes indicados.`
      );
    }

    showGames();

    $('generateBtn').disabled = false;

    setStatus(
      `PDF lido: ${data.numPages} página(s). Encontrados ${state.games.length} jogo(s).`
    );
  } catch (e) {
    console.error(e);
    setError(
      'Erro ao ler o PDF: ' + (e?.message || e)
    );
  }
}

async function generateAll() {
  if (!state.games.length) return;

  const ok = await checkAssets(state.games);
  if (!ok) return;

  setStatus('A gerar os JPG...');

  const zip = new JSZip();

  for (const g of state.games) {
    const canvas = await render(g);

    const blob = await new Promise(
      r => canvas.toBlob(r, 'image/jpeg', .96)
    );

    zip.file(
      safeFile(`${g.home} - ${g.away}.jpg`).slice(0, 150),
      blob
    );
  }

  const blob = await zip.generateAsync({ type: 'blob' });

  download(
    blob,
    'Nomeacoes_Marques_Bom.zip'
  );

  setStatus(
    `Concluído: ${state.games.length} JPG(s) gerados.`
  );
}

async function generateManual() {
  const home = $('mHome').value.trim();
  const away = $('mAway').value.trim();
  const competition = $('mCompetition').value.trim();

  if (!home || !away || !competition) {
    return setError(
      'Preenche competição e as duas equipas.'
    );
  }

  const officials = [
    ...document.querySelectorAll('.manualOfficial')
  ]
    .map(r => ({
      name: r.querySelector('.mName').value.trim(),
      role: r.querySelector('.mRole').value.trim() || 'Árbitro'
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
    officials
  };

  if ($('mDate').value.trim()) {
    g.date = $('mDate').value.trim();
  }

  const ok = await checkAssets([g]);
  if (!ok) return;

  const canvas = await render(g);

  const blob = await new Promise(
    r => canvas.toBlob(r, 'image/jpeg', .96)
  );

  download(
    blob,
    safeFile(`${home} - ${away}.jpg`)
  );

  setStatus('Nomeação manual gerada.');
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
