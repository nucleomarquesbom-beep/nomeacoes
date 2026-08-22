import { Buffer } from 'node:buffer';
import { teamLookupName } from '../shared/team-normalize.mjs';

/**
 * Fonte única de escudos.
 *
 * Fluxo:
 *   PDF -> nome da equipa -> normalização -> diretório oficial FPF
 *       -> página do clube FPF -> imagem do escudo FPF.
 *
 * Não usa ZeroZero, biblioteca local, probing de extensões ou cache GitHub.
 */

const FPF_BASE = 'https://resultados.fpf.pt';
const ASSOCIATION_IDS = Array.from({ length: 22 }, (_, i) => 219 + i);
const UA =
  process.env.FPF_USER_AGENT ||
  'NAF-Marques-Bom-Nomeacoes/4.0 (+https://github.com/nucleomarquesbom-beep/nomeacoes)';

const memory = new Map();
const inFlight = new Map();
const negative = new Map();
const NEGATIVE_TTL = 60 * 1000;
let directoryPromise = null;

function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lookupName(value = '') {
  return clean(teamLookupName(value));
}

function normalize(value = '') {
  return lookupName(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/["'.,/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(url, base = FPF_BASE) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlText(value = '') {
  return decodeHtml(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`FPF_HTTP_${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function scoreName(wanted, candidate) {
  const a = normalize(wanted);
  const b = normalize(candidate);

  if (!a || !b) return -Infinity;
  if (a === b) return 10000;

  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  const common = [...at].filter(token => bt.has(token)).length;
  const containment = a.includes(b) || b.includes(a) ? 2500 : 0;

  return containment + common * 500 - Math.abs(a.length - b.length);
}

function extractClubLinks(html, associationId) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']*\/Club\/Details\?clubId=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(html))) {
    const url = absolute(match[1]);
    const name = htmlText(match[2]);
    if (!url || !name) continue;
    links.push({ name, url, associationId });
  }

  return [...new Map(links.map(item => [item.url, item])).values()];
}

async function loadAssociation(associationId) {
  const url = `${FPF_BASE}/Club/Club?associationId=${associationId}`;

  try {
    const html = await fetchText(url);
    return extractClubLinks(html, associationId);
  } catch (error) {
    console.warn(
      '[FPF] associação indisponível',
      associationId,
      error?.message || error
    );
    return [];
  }
}

async function getDirectory() {
  if (directoryPromise) return directoryPromise;

  directoryPromise = Promise.all(ASSOCIATION_IDS.map(loadAssociation))
    .then(groups => {
      const unique = new Map();

      for (const club of groups.flat()) {
        const key = normalize(club.name) || club.url;
        if (!unique.has(key)) unique.set(key, club);
      }

      return [...unique.values()];
    })
    .catch(error => {
      directoryPromise = null;
      throw error;
    });

  return directoryPromise;
}

async function findFpfClub(team) {
  const wanted = lookupName(team);
  if (!wanted) return null;

  const directory = await getDirectory();

  const candidates = directory
    .map(club => ({
      ...club,
      score: scoreName(wanted, club.name)
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];

  if (!best || best.score < 2000) {
    return null;
  }

  return best;
}

function extractAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)\s*=\s*["']([^"']*)["']/gi;
  let match;

  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
  }

  return attrs;
}

function extractImages(html, pageUrl) {
  const images = [];
  const re = /<img\b[^>]*>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = extractAttributes(match[0]);

    const raw =
      attrs.src ||
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'];

    const src = absolute(raw, pageUrl);

    if (!src) continue;

    images.push({
      src,
      alt: clean(attrs.alt || ''),
      title: clean(attrs.title || ''),
      className: clean(attrs.class || '')
    });
  }

  return images;
}

function pickClubImage(html, pageUrl, clubName) {
  const images = extractImages(html, pageUrl);

  if (!images.length) {
    return null;
  }

  const wanted = normalize(clubName);

  const scored = images
    .map(image => {
      const identity = [image.alt, image.title]
        .filter(Boolean)
        .join(' ');

      const identityScore = scoreName(
        wanted,
        identity
      );

      const shieldHint =
        /escudo|clube|club|logo|badge|team|equipa/i.test(
          `${image.alt} ${image.title} ${image.className} ${image.src}`
        )
          ? 500
          : 0;

      const footerPenalty =
        /google|apple|play-store|app-store|facebook|instagram/i.test(
          `${image.alt} ${image.title} ${image.src}`
        )
          ? -5000
          : 0;

      return {
        ...image,
        score: identityScore + shieldHint + footerPenalty
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0) {
    return null;
  }

  return best.src;
}

async function getFpfShield(fpfClub) {
  const html = await fetchText(fpfClub.url);

  const imageUrl = pickClubImage(
    html,
    fpfClub.url,
    fpfClub.name
  );

  if (!imageUrl) {
    throw new Error(
      'FPF_SHIELD_IMAGE_NOT_FOUND'
    );
  }

  return {
    imageUrl,
    pageUrl: fpfClub.url
  };
}

async function downloadImage(imageUrl, pageUrl) {
  const response = await fetch(imageUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Referer: pageUrl,
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(
      `FPF_IMAGE_HTTP_${response.status}`
    );
  }

  const mime =
    (
      response.headers.get('content-type') || ''
    )
      .split(';')[0]
      .toLowerCase();

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (!buffer.length) {
    throw new Error('FPF_IMAGE_EMPTY');
  }

  if (!mime.startsWith('image/')) {
    throw new Error(
      'FPF_IMAGE_INVALID_TYPE'
    );
  }

  return {
    mime,
    buffer
  };
}

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function resolveShieldNow(team) {
  const requested = clean(team);

  if (!requested) {
    throw new Error('TEAM_REQUIRED');
  }

  const key = normalize(requested);

  const badUntil = negative.get(key);

  if (
    badUntil &&
    badUntil > Date.now()
  ) {
    return {
      ok: false,
      team: requested,
      error: 'SHIELD_NOT_FOUND_CACHED'
    };
  }

  negative.delete(key);

  const fpf = await findFpfClub(requested);

  if (!fpf) {
    throw new Error(
      'FPF_CLUB_NOT_FOUND'
    );
  }

  const shield = await getFpfShield(fpf);

  const image = await downloadImage(
    shield.imageUrl,
    shield.pageUrl
  );

  const result = {
    ok: true,
    team: requested,
    fpfName: fpf.name,
    fpfPage: fpf.url,
    fpfAssociationId:
      fpf.associationId,
    fpfImageUrl:
      shield.imageUrl,
    imageDataUrl:
      dataUrl(
        image.mime,
        image.buffer
      ),
    mime: image.mime,
    source: 'FPF',
    cached: false
  };

  memory.set(key, result);

  return result;
}

export async function resolveShield(team) {
  const key = normalize(team);

  if (!key) {
    throw new Error('TEAM_REQUIRED');
  }

  if (memory.has(key)) {
    return memory.get(key);
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const job = resolveShieldNow(team)
    .catch(error => {
      negative.set(
        key,
        Date.now() + NEGATIVE_TTL
      );

      throw error;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, job);

  return job;
}

export async function resolveShields(
  teams = []
) {
  const unique = [
    ...new Map(
      teams
        .map(clean)
        .filter(Boolean)
        .map(team => [
          normalize(team),
          team
        ])
    ).values()
  ];

  const results = await Promise.all(
    unique.map(async team => {
      try {
        return await resolveShield(team);
      } catch (error) {
        return {
          ok: false,
          team,
          error:
            error?.message ||
            'SHIELD_NOT_FOUND'
        };
      }
    })
  );

  return {
    ok: true,
    results,
    summary: {
      total: results.length,
      found: results.filter(
        result => result.ok
      ).length,
      missing: results.filter(
        result => !result.ok
      ).length
    }
  };
}
