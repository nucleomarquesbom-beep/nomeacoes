import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AUTOMATION_NAMES, AUTOMATION_EMAIL } from './names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const stateFile = path.join(__dirname, 'last-processed.json');
const tmp = path.join(root, '.automation-tmp');

const FPF_URL = 'https://www.fpf.pt/Institucional/Arbitragem/Nomea%C3%A7%C3%B5es-n%C3%A3o-profissionais';
const GET_DOCUMENTS_URL = 'https://www.fpf.pt/DesktopModules/MVC/DocumentList/Default/GetDocuments';

const APP_URL = process.env.APP_URL;
const EMAIL_TO = process.env.EMAIL_TO || AUTOMATION_EMAIL;
const EMAIL_FROM = process.env.EMAIL_FROM;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!APP_URL) throw new Error('Secret APP_URL não configurado.');
if (!EMAIL_FROM) throw new Error('Secret EMAIL_FROM não configurado.');
if (!RESEND_API_KEY) throw new Error('Secret RESEND_API_KEY não configurado.');
if (!AUTOMATION_NAMES.length) throw new Error('automation/names.js não tem nomes.');

const now = new Date();
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Lisbon',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const LISBON_DATE = dateFormatter.format(now);
const [YYYY, MM, DD] = LISBON_DATE.split('-');
const DISPLAY_DATE = `${DD}/${MM}/${YYYY}`;

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });

function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-PT');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPdfUrl(value) {
  return typeof value === 'string' && /\.pdf(?:[?#].*)?$/i.test(value);
}

function absoluteUrl(value) {
  try { return new URL(value, 'https://www.fpf.pt').href; }
  catch { return null; }
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collectStrings(v, out));
  return out;
}

function pdfUrlsFromJson(payload) {
  const urls = new Set();
  for (const s of collectStrings(payload)) {
    if (isPdfUrl(s)) {
      const u = absoluteUrl(s);
      if (u) urls.add(u);
    }
  }
  return [...urls];
}

function looksLikeNi(url, text = '') {
  const haystack = normalizeText(`${url} ${text}`);
  return /\bni\b/.test(haystack) || /(^|[/_\-. ])ni[/_\-. ]/i.test(haystack);
}

function looksLikeDate(text) {
  const n = normalizeText(text);
  return n.includes(normalizeText(LISBON_DATE)) ||
         n.includes(`${DD}/${MM}/${YYYY}`) ||
         n.includes(`${DD}-${MM}-${YYYY}`) ||
         n.includes(`${YYYY}/${MM}/${DD}`) ||
         n.includes(`${YYYY}-${MM}-${DD}`);
}

async function acceptCookies(page) {
  for (const text of ['Aceitar todos', 'Aceitar', 'Concordo']) {
    const b = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(text)}$`, 'i') }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      break;
    }
  }
}

async function findDateInput(page) {
  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.count()) return dateInputs.first();

  const candidates = page.locator('input');
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const meta = normalizeText([
      await el.getAttribute('name'),
      await el.getAttribute('id'),
      await el.getAttribute('placeholder'),
      await el.getAttribute('aria-label')
    ].filter(Boolean).join(' '));
    if (meta.includes('data') || meta.includes('date')) return el;
  }
  return null;
}

async function setDateIfPresent(page) {
  const input = await findDateInput(page);
  if (!input) {
    console.log('Não foi encontrado input de data; a página será pesquisada sem preencher data.');
    return false;
  }

  const type = await input.getAttribute('type');
  if (type === 'date') {
    await input.fill(LISBON_DATE);
  } else {
    await input.fill(`${DD}/${MM}/${YYYY}`).catch(async () => {
      await input.fill(LISBON_DATE);
    });
  }

  await input.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });

  return true;
}

async function clickSearch(page) {
  const button = page.getByRole('button', { name: /Procurar/i }).first();
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
}

async function getPdfFromVisibleResults(page) {
  const links = page.locator('a[href]');
  const count = await links.count();
  const candidates = [];

  for (let i = 0; i < count; i++) {
    const a = links.nth(i);
    const href = await a.getAttribute('href');
    const text = await a.innerText().catch(() => '');
    const title = await a.getAttribute('title');
    const aria = await a.getAttribute('aria-label');
    const label = `${text} ${title || ''} ${aria || ''}`.trim();
    const url = absoluteUrl(href);
    if (!url) continue;

    if (isPdfUrl(url) && looksLikeNi(url, label)) {
      candidates.push({ url, label, score: (looksLikeDate(label) ? 100 : 0) + 50 });
    }
  }

  if (!candidates.length) {
    // Alguns resultados podem usar botões ou elementos com data-href.
    const all = page.locator('[href], [data-href], [data-url]');
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      const href = await el.getAttribute('href');
      const dataHref = await el.getAttribute('data-href');
      const dataUrl = await el.getAttribute('data-url');
      const text = await el.innerText().catch(() => '');
      for (const raw of [href, dataHref, dataUrl]) {
        const url = absoluteUrl(raw);
        if (url && isPdfUrl(url) && looksLikeNi(url, text)) {
          candidates.push({ url, label: text, score: looksLikeDate(text) ? 100 : 50 });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || null;
}

async function getNiPdfUrl(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const responses = [];

  page.on('response', async response => {
    if (!response.url().includes('/GetDocuments')) return;
    try {
      const data = await response.json();
      responses.push(data);
    } catch {}
  });

  await page.goto(FPF_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(page);

  const dateWasSet = await setDateIfPresent(page);

  // A pesquisa por "NI" é usada apenas como filtro adicional. A data continua a ser
  // preenchida quando a página disponibiliza esse campo.
  const inputs = page.locator('input');
  const count = await inputs.count();
  let contentInput = null;
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    const meta = normalizeText([
      await el.getAttribute('name'),
      await el.getAttribute('id'),
      await el.getAttribute('placeholder'),
      await el.getAttribute('aria-label')
    ].filter(Boolean).join(' '));
    const type = await el.getAttribute('type');
    if (type !== 'date' && (meta.includes('content') || meta.includes('pesquisa') || meta.includes('search'))) {
      contentInput = el;
      break;
    }
  }
  if (contentInput) await contentInput.fill('NI');

  await clickSearch(page);

  // Esperar o carregamento dos resultados.
  await page.waitForTimeout(2500);

  const visiblePdf = await getPdfFromVisibleResults(page);
  if (visiblePdf) {
    console.log(`PDF NI encontrado nos resultados visíveis${dateWasSet ? ` para ${DISPLAY_DATE}` : ''}: ${visiblePdf}`);
    await page.close();
    return visiblePdf;
  }

  for (const payload of responses) {
    const urls = pdfUrlsFromJson(payload).filter(u => looksLikeNi(u));
    if (urls.length) {
      // Preferir URLs cujo payload contenha a data.
      const dateText = normalizeText(JSON.stringify(payload));
      urls.sort((a, b) => Number(dateText.includes(normalizeText(LISBON_DATE))) - Number(dateText.includes(normalizeText(LISBON_DATE))));
      const selected = urls[urls.length - 1];
      console.log(`PDF NI encontrado na resposta GetDocuments: ${selected}`);
      await page.close();
      return selected;
    }
  }

  await page.screenshot({ path: path.join(tmp, 'fpf-sem-ni.png'), fullPage: true }).catch(() => {});
  await page.close();
  return null;
}

async function downloadPdf(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': FPF_URL,
      'Accept': 'application/pdf,*/*'
    }
  });
  if (!r.ok) throw new Error(`PDF devolveu HTTP ${r.status}.`);
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length < 1000 || buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('O URL encontrado não devolveu um PDF válido.');
  }
  const file = path.join(tmp, `NI-${LISBON_DATE}.pdf`);
  await fs.writeFile(file, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { file, sha256 };
}

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch { return {}; }
}

async function writeState(state) {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function sendEmail(zipPath, foundNames) {
  const attachment = (await fs.readFile(zipPath)).toString('base64');
  const subject = `Nomeações FPF — ${DISPLAY_DATE}`;
  const html = `
    <p>Foram geradas automaticamente as nomeações da FPF para <strong>${DISPLAY_DATE}</strong>.</p>
    <p><strong>Árbitros encontrados:</strong></p>
    <ul>${foundNames.map(n => `<li>${n}</li>`).join('')}</ul>
    <p>O ZIP com as imagens segue em anexo.</p>
  `;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject,
      html,
      attachments: [{ filename: `Nomeacoes_FPF_${LISBON_DATE}.zip`, content: attachment }]
    })
  });

  if (!r.ok) throw new Error(`Resend devolveu ${r.status}: ${await r.text()}`);
}

async function generateWithCurrentApp(browser, pdfFile) {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });

  await page.locator('#names').fill(AUTOMATION_NAMES.join('\n'));
  await page.locator('#pdfFile').setInputFiles(pdfFile);
  await page.locator('#analyzeBtn').click();

  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent || '';
    const error = document.querySelector('#error')?.textContent || '';
    const button = document.querySelector('#generateBtn');
    return !!error || !!button?.disabled === false || /Pronto:|PDF lido|jogo\(s\)/i.test(status);
  }, null, { timeout: 120000 });

  const errorText = (await page.locator('#error').textContent().catch(() => ''))?.trim();
  if (errorText) throw new Error(`A aplicação rejeitou o NI: ${errorText}`);

  const resultsText = await page.locator('#results').innerText().catch(() => '');
  const normalizedResults = normalizeText(resultsText);
  const foundNames = AUTOMATION_NAMES.filter(name => normalizedResults.includes(normalizeText(name)));

  if (!foundNames.length) {
    await page.close();
    return { foundNames: [], zipPath: null };
  }

  const button = page.locator('#generateBtn');
  await button.waitFor({ state: 'visible', timeout: 30000 });
  const disabled = await button.isDisabled();
  if (disabled) throw new Error('A aplicação terminou a leitura mas o botão Gerar todos os JPG continua desativado.');

  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await button.click();
  const download = await downloadPromise;
  const zipPath = path.join(tmp, 'nomeacoes-geradas.zip');
  await download.saveAs(zipPath);
  await page.close();

  return { foundNames, zipPath };
}

const browser = await chromium.launch({ headless: true });
try {
  const niUrl = await getNiPdfUrl(browser);

  if (!niUrl) {
    console.log(`Nenhum NI encontrado para ${DISPLAY_DATE}. Não será enviado email.`);
    process.exit(0);
  }

  const pdf = await downloadPdf(niUrl);
  const state = await readState();

  if (state?.url === niUrl && state?.sha256 === pdf.sha256) {
    console.log('Este NI já foi processado. Não será enviado outro email.');
    process.exit(0);
  }

  const result = await generateWithCurrentApp(browser, pdf.file);

  if (!result.foundNames.length || !result.zipPath) {
    console.log(`O NI existe, mas nenhum dos ${AUTOMATION_NAMES.length} nomes configurados foi encontrado. Não será enviado email.`);
    process.exit(0);
  }

  await sendEmail(result.zipPath, result.foundNames);
  await writeState({
    url: niUrl,
    sha256: pdf.sha256,
    date: LISBON_DATE,
    names: result.foundNames
  });

  console.log(`Concluído. Email enviado para ${EMAIL_TO}.`);
} finally {
  await browser.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
