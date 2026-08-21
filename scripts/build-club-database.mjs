#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'public', 'clubes.json');
const FPF = 'https://resultados.fpf.pt';
const ZEROZERO = 'https://www.zerozero.pt';
const UA = 'NAF-Marques-Bom/2.0 (+FPF->ZeroZero)';
const ASSOCIATION_IDS = Array.from({ length: 22 }, (_, i) => 219 + i);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
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

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function links(html, base, predicate) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = absolute(match[1], base);
    if (!href || (predicate && !predicate(href))) continue;
    out.push({ href: href.split('#')[0], text: clean(match[2]) });
  }
  const unique = new Map();
  for (const item of out) unique.set(item.href, item);
  return [...unique.values()];
}

function extractFpfNumber(html) {
  const text = clean(html);
  const patterns = [
    /\bN(?:[ºo°]|úmero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[ºo°]|úmero)?\s*[:\-]?\s*(\d{1,6})\s+F\.?\s*P\.?\s*F\.?\b/i,
    /\bF\.?\s*P\.?\s*F\.?\s*(?:N(?:[ºo°]|úmero)?|Num\.?)?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:fpfNumber|numeroFpf|numFpf|fpfNo)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractTitle(html, fallback = '') {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return clean(h1[1]);
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return clean(og[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? clean(title[1]) : fallback;
}

async function getFpfClubs() {
  const clubs = new Map();

  for (const associationId of ASSOCIATION_IDS) {
    try {
      const url = `${FPF}/Club/Club?associationId=${associationId}`;
      const html = await fetchText(url, 12000);
      const detailLinks = links(html, FPF, href => /\/Club\/Details\?clubId=\d+/i.test(href));

      for (const link of detailLinks) {
        const key = normalize(link.text);
        if (!key || clubs.has(link.href)) continue;
        clubs.set(link.href, {
          nomePesquisa: link.text,
          fpfPage: link.href,
          associationId
        });
      }

      console.log(`FPF associação ${associationId}: ${detailLinks.length} clubes`);
    } catch (error) {
      console.warn(`FPF associação ${associationId} falhou: ${error.message}`);
    }
  }

  return [...clubs.values()];
}

async function enrichFpf(club) {
  const html = await fetchText(club.fpfPage, 12000);
  const fpfNumber = extractFpfNumber(html);
  if (!fpfNumber) return null;

  return {
    ...club,
    nomeFPF: extractTitle(html, club.nomePesquisa),
    fpfNumber: String(fpfNumber)
  };
}

function extractZeroZeroFpfNumber(html) {
  const text = clean(html);
  const patterns = [
    /\bNum\.?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /\bN(?:[úu]mero)?\s*F\.?\s*P\.?\s*F\.?\s*[:\-]?\s*(\d{1,6})\b/i,
    /(?:numFpf|fpfNumber)\s*["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractZeroZeroLogo(html, base) {
  const urls = [];
  const patterns = [
    /(?:src|data-src|data-lazy-src|content)=["']([^"']*\/img\/logos\/equipas\/[^"']+)["']/gi,
    /(https?:\/\/[^"'<>\s]+\/img\/logos\/equipas\/[^"'<>\s]+)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) urls.push(match[1]);
  }
  return [...new Set(urls.map(url => absolute(url, base)).filter(Boolean))][0] || null;
}

async function resolveZeroZero(club) {
  const searchUrl = `${ZEROZERO}/pesquisa?search_txt=${encodeURIComponent(club.fpfNumber)}`;
  const searchHtml = await fetchText(searchUrl, 15000);
  const candidates = links(
    searchHtml,
    ZEROZERO,
    href => /\/equipa\//i.test(new URL(href).pathname)
  )
    .map(item => ({ ...item, score: scoreName(club.nomeFPF, item.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  for (const candidate of candidates) {
    try {
      const page = await fetchText(candidate.href, 12000);
      const numFpf = extractZeroZeroFpfNumber(page);
      if (String(numFpf || '') !== String(club.fpfNumber)) continue;

      return {
        zerozeroNome: extractTitle(page, candidate.text),
        zerozero: candidate.href,
        zerozeroNumFpf: String(numFpf),
        zerozeroLogo: extractZeroZeroLogo(page, candidate.href)
      };
    } catch {
      // Try the next result.
    }
  }

  return null;
}

async function main() {
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  const fpfClubs = await getFpfClubs();
  console.log(`FPF: ${fpfClubs.length} clubes candidatos.`);

  const verified = [];
  let processed = 0;

  for (const raw of fpfClubs) {
    processed++;
    try {
      const club = await enrichFpf(raw);
      if (!club) continue;

      const zz = await resolveZeroZero(club);
      if (!zz) continue;

      verified.push({
        nome: club.nomeFPF,
        alias: club.nomePesquisa,
        fpfNumber: club.fpfNumber,
        fpfPage: club.fpfPage,
        zerozeroNome: zz.zerozeroNome,
        zerozero: zz.zerozero,
        zerozeroNumFpf: zz.zerozeroNumFpf,
        zerozeroLogo: zz.zerozeroLogo,
        verificado: true
      });

      if (processed % 25 === 0) console.log(`Verificados ${processed}/${fpfClubs.length}`);
      await sleep(120);
    } catch (error) {
      console.warn(`Clube ignorado (${raw.nomePesquisa}): ${error.message}`);
    }
  }

  verified.sort((a, b) => normalize(a.nome).localeCompare(normalize(b.nome), 'pt'));

  await fs.writeFile(
    OUT,
    JSON.stringify({
      versao: 2,
      geradoEm: new Date().toISOString(),
      fonteIdentificacao: 'FPF',
      fonteEscudo: 'ZeroZero',
      total: verified.length,
      clubes: verified
    }, null, 2) + '\n'
  );

  console.log(`Base gravada: ${verified.length} clubes validados.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
