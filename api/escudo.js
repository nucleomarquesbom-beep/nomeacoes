import sharp from "sharp";

const ZEROZERO = "https://www.zerozero.pt";
const UA = "Mozilla/5.0 (compatible; NAF-Marques-Bom/5.0)";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function normalize(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª°]/g, "")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value = "") {
  return normalize(value).replace(/\s+/g, "");
}

function cleanTeam(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*(?:OAF|SAD|SDUQ)\s*$/i, "")
    .trim();
}

function slug(value = "") {
  return normalize(value)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "escudo";
}

/*
 * Regras que já existiam na app e que NÃO devem ser perdidas:
 * - nome original continua a ser usado para procurar;
 * - SAD e SDUQ são variantes válidas;
 * - pontuação pode ser ignorada;
 * - acentos, maiúsculas/minúsculas e espaços não impedem a correspondência.
 */
function teamVariants(team) {
  const base = cleanTeam(team);
  return [...new Set([
    base,
    base.replace(/\bSAD\b/gi, "").replace(/\bSDUQ\b/gi, "").replace(/\s+/g, " ").trim(),
    base.replace(/[,.]/g, "").replace(/\s+/g, " ").trim(),
    base.replace(/\s+(SAD|SDUQ)\b/gi, "").trim()
  ].filter(Boolean))];
}

function scoreName(wanted, candidate) {
  const a = normalize(wanted);
  const b = normalize(candidate);

  if (!a || !b) return -Infinity;
  if (a === b) return 10000;

  const aw = a.split(" ").filter(Boolean);
  const bw = b.split(" ").filter(Boolean);
  const bs = new Set(bw);

  const common = aw.filter(w => w.length > 1 && bs.has(w)).length;
  const coverage = common / Math.max(aw.length, 1);

  let score = common * 800 + coverage * 1000;

  if (a.includes(b) || b.includes(a)) score += 1000;
  score -= Math.abs(a.length - b.length) * 2;

  return score;
}

function absolute(base, value) {
  try {
    return new URL(
      String(value).replace(/&amp;/g, "&").replace(/\\\//g, "/"),
      base
    ).href;
  } catch {
    return null;
  }
}

function htmlText(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchZeroZero(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.7",
      ...(options.headers || {})
    }
  });
}

function extractTeamLinks(html, baseUrl, wanted) {
  const candidates = [];
  const seen = new Set();

  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html))) {
    const url = absolute(baseUrl, m[1]);
    if (!url) continue;

    let u;
    try { u = new URL(url); } catch { continue; }

    if (u.hostname !== "www.zerozero.pt") continue;
    if (!/^\/equipa\//i.test(u.pathname)) continue;

    const name = htmlText(m[2]);
    if (!name || name.length > 160) continue;

    const key = `${u.pathname}${u.search}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      name,
      url: `${u.origin}${u.pathname}${u.search}`,
      score: scoreName(wanted, name)
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function extractTeamLinksFromData(html, wanted) {
  const candidates = [];
  const seen = new Set();

  /*
   * Alguns templates colocam URLs em JSON/atributos em vez de anchors.
   */
  const re = /["']((?:https?:\/\/www\.zerozero\.pt)?\/equipa\/[^"'\\\s]+)["']/gi;
  let m;

  while ((m = re.exec(html))) {
    const url = absolute(ZEROZERO, m[1]);
    if (!url || seen.has(url)) continue;

    seen.add(url);

    const slugPart = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean)[1] || ""
    );

    candidates.push({
      name: slugPart.replace(/-/g, " "),
      url,
      score: scoreName(wanted, slugPart.replace(/-/g, " "))
    });
  }

  return candidates;
}

function extractLogoCandidates(html, pageUrl) {
  const out = [];
  const seen = new Set();

  const add = raw => {
    const url = absolute(pageUrl, raw);
    if (!url || seen.has(url)) return;

    try {
      const u = new URL(url);
      if (
        u.hostname !== "www.zerozero.pt" &&
        !u.hostname.endsWith(".zerozero.pt")
      ) return;
    } catch {
      return;
    }

    seen.add(url);
    out.push(url);
  };

  for (const m of html.matchAll(
    /https?:\/\/[^"'<> \t\r\n]+\/img\/logos\/equipas\/[^"'<> \t\r\n]+/gi
  )) add(m[0]);

  for (const m of html.matchAll(
    /(?:src|data-src|data-original|data-lazy-src|data-image)=["']([^"']+)["']/gi
  )) {
    if (
      /\/img\/logos\/equipas\//i.test(m[1]) ||
      /(logo|badge|emblem|escudo|crest)/i.test(m[1])
    ) add(m[1]);
  }

  for (const m of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) add(m[1]);

  /*
   * JSON-LD / schema.org image.
   */
  for (const m of html.matchAll(
    /"(?:logo|image)"\s*:\s*"([^"]+)"/gi
  )) add(m[1]);

  return out;
}

async function openTeamPage(candidate, wanted) {
  const r = await fetchZeroZero(candidate.url, {
    headers: { Accept: "text/html,application/xhtml+xml" }
  });

  if (!r.ok) return null;

  const html = await r.text();

  const title =
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

  const h1 =
    (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");

  const pageName = htmlText(h1 || title);

  /*
   * A direct URL is accepted only when the page itself still resembles
   * the requested team. This prevents a generic ZeroZero page redirect
   * from becoming a false crest.
   */
  const pageScore = Math.max(
    scoreName(wanted, pageName),
    scoreName(wanted, candidate.name)
  );

  if (pageScore < 700) return null;

  const logos = extractLogoCandidates(html, candidate.url);
  if (!logos.length) return null;

  return {
    name: pageName || candidate.name,
    url: candidate.url,
    logoUrl: logos[0],
    score: pageScore
  };
}

async function searchZeroZero(team) {
  const wanted = cleanTeam(team);
  const variants = teamVariants(wanted);
  const candidates = [];

  const searchPaths = [
    q => `/pesquisa?search_txt=${encodeURIComponent(q)}`,
    q => `/pesquisa?query=${encodeURIComponent(q)}`,
    q => `/pesquisa?search=${encodeURIComponent(q)}`,
    q => `/search.php?search_string=${encodeURIComponent(q)}`
  ];

  /*
   * 1. Pesquisa interna do ZeroZero.
   * Fazemos várias variantes do nome, mas paramos assim que obtivermos
   * candidatos fortes.
   */
  for (const variant of variants) {
    for (const makePath of searchPaths) {
      try {
        const searchUrl = ZEROZERO + makePath(variant);
        const r = await fetchZeroZero(searchUrl, {
          headers: { Accept: "text/html,application/xhtml+xml" }
        });

        if (!r.ok) continue;

        const html = await r.text();

        candidates.push(
          ...extractTeamLinks(html, searchUrl, wanted),
          ...extractTeamLinksFromData(html, wanted)
        );

        if (candidates.some(x => x.score >= 1800)) break;
      } catch {
        // tenta a próxima forma de pesquisa
      }
    }

    if (candidates.some(x => x.score >= 1800)) break;
  }

  /*
   * 2. Deduplicar e abrir apenas os candidatos fortes.
   */
  const unique = [];
  const seen = new Set();

  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    unique.push(c);
  }

  for (const candidate of unique.slice(0, 8)) {
    const page = await openTeamPage(candidate, wanted);
    if (page) return {
      ...page,
      requested: wanted,
      source: "ZeroZero"
    };
  }

  /*
   * 3. Último recurso: URL amigável.
   * Muitas equipas do ZeroZero têm /equipa/{slug}/{id}; algumas versões
   * aceitam o slug e redireccionam. Nunca aceitamos o resultado sem
   * validar o conteúdo da página.
   */
  for (const variant of variants) {
    const guessed = `${ZEROZERO}/equipa/${slug(variant)}`;

    try {
      const page = await openTeamPage(
        { name: variant, url: guessed },
        wanted
      );

      if (page) {
        return {
          ...page,
          requested: wanted,
          source: "ZeroZero"
        };
      }
    } catch {}
  }

  throw new Error(
    `Não foi possível identificar com segurança "${wanted}" no ZeroZero.`
  );
}

function githubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main"
  };
}

async function github(url, options = {}) {
  const { token } = githubConfig();

  if (!token) {
    throw new Error("GITHUB_TOKEN não configurado na Vercel.");
  }

  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
}

async function downloadImage(url) {
  const r = await fetchZeroZero(url, {
    headers: {
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });

  if (!r.ok) return null;

  const type = (r.headers.get("content-type") || "").toLowerCase();
  const length = Number(r.headers.get("content-length") || 0);

  if (!type.startsWith("image/")) return null;
  if (length > MAX_IMAGE_BYTES) return null;

  const buffer = Buffer.from(await r.arrayBuffer());

  if (buffer.length > MAX_IMAGE_BYTES) return null;

  return buffer;
}

async function toPngDataUrl(buffer) {
  const png = await sharp(buffer, { failOn: "none" })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString("base64")}`;
}

async function getCachedShield(team) {
  const { repo, branch } = githubConfig();
  if (!repo) return null;

  /*
   * Mantém a regra antiga: tentar o nome exacto e as variantes SAD/SDUQ
   * antes de ir à Internet.
   */
  const paths = [];

  for (const variant of teamVariants(team)) {
    const base = slug(variant);

    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      paths.push(`public/escudos/${base}.${ext}`);
    }
  }

  for (const path of [...new Set(paths)]) {
    const apiUrl =
      `https://api.github.com/repos/${repo}/contents/` +
      path.split("/").map(encodeURIComponent).join("/") +
      `?ref=${encodeURIComponent(branch)}`;

    try {
      const r = await github(apiUrl);

      if (!r.ok) continue;

      const data = await r.json();
      if (!data.download_url) continue;

      const image = await downloadImage(data.download_url);
      if (!image) continue;

      return {
        imageDataUrl: await toPngDataUrl(image),
        source: "GitHub",
        cached: true,
        path
      };
    } catch {}
  }

  return null;
}

async function saveShield(team, dataUrl) {
  const { repo, branch } = githubConfig();

  if (!repo) {
    return {
      saved: false,
      error: "GITHUB_REPO não configurado."
    };
  }

  const match = String(dataUrl).match(
    /^data:image\/png;base64,(.+)$/i
  );

  if (!match) {
    return {
      saved: false,
      error: "Imagem PNG inválida."
    };
  }

  const path = `public/escudos/${slug(team)}.png`;

  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    path.split("/").map(encodeURIComponent).join("/");

  const existing = await github(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`
  );

  /*
   * Nunca substituir automaticamente um escudo já aprovado.
   */
  if (existing.ok) {
    return {
      saved: true,
      alreadyExists: true,
      path
    };
  }

  if (existing.status !== 404) {
    return {
      saved: false,
      error: `GitHub respondeu ${existing.status} ao verificar o escudo.`
    };
  }

  const write = await github(apiUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Adicionar escudo: ${cleanTeam(team)}`,
      content: match[1],
      branch
    })
  });

  const result = await write.json().catch(() => ({}));

  if (!write.ok) {
    return {
      saved: false,
      error: result?.message || `GitHub respondeu ${write.status}.`
    };
  }

  return {
    saved: true,
    alreadyExists: false,
    path
  };
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

async function one(team) {
  const requested = cleanTeam(team);

  if (!requested) {
    return {
      ok: false,
      team,
      error: "Nome da equipa vazio."
    };
  }

  const cached = await getCachedShield(requested);

  if (cached) {
    return {
      ok: true,
      team: requested,
      ...cached
    };
  }

  const found = await searchZeroZero(requested);
  const image = await downloadImage(found.logoUrl);

  if (!image) {
    return {
      ok: false,
      team: requested,
      source: "ZeroZero",
      error: "A imagem do escudo não pôde ser descarregada.",
      zeroZeroPage: found.url
    };
  }

  const imageDataUrl = await toPngDataUrl(image);
  const saved = await saveShield(requested, imageDataUrl);

  return {
    ok: true,
    team: requested,
    matchedTeam: found.name,
    zeroZeroPage: found.url,
    zeroZeroImage: found.logoUrl,
    score: found.score,
    source: "ZeroZero",
    imageDataUrl,
    ...saved
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const team = req.query?.team || "";

      return res.status(200).json(
        await one(team)
      );
    }

    if (req.method === "POST") {
      const data = parseBody(req);

      if (Array.isArray(data.teams)) {
        const teams = [...new Set(
          data.teams.map(cleanTeam).filter(Boolean)
        )];

        const results = [];

        /*
         * 3 em paralelo: suficiente para uma geração semanal sem
         * bombardear o ZeroZero.
         */
        for (let i = 0; i < teams.length; i += 3) {
          const batch = teams.slice(i, i + 3);

          const part = await Promise.all(
            batch.map(team =>
              one(team).catch(error => ({
                ok: false,
                team,
                error: error?.message || "Erro desconhecido."
              }))
            )
          );

          results.push(...part);
        }

        return res.status(200).json({
          ok: true,
          total: teams.length,
          results
        });
      }

      if (!data.team) {
        return res.status(400).json({
          ok: false,
          error: "team obrigatório."
        });
      }

      return res.status(200).json(
        await one(data.team)
      );
    }

    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  } catch (error) {
    console.error("[escudo]", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "Erro ao obter o escudo."
    });
  }
}
