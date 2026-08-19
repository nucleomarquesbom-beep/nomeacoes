import sharp from "sharp";

const ZEROZERO = "https://www.zerozero.pt";
const UA = "Mozilla/5.0 (compatible; NAF-Marques-Bom/2.0)";
const IMAGE_RE = /\/img\/logos\/equipas\//i;

function normalize(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª°]/g, "")
    .replace(/["'.,/()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTeamName(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*(?:OAF\s+SDUQ|SAD|SDUQ|OAF)\s*$/i, "")
    .trim();
}

function safeFilename(value = "") {
  return cleanTeamName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "escudo";
}

function similarityScore(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return -1;
  if (x === y) return 1000;
  if (x.includes(y) || y.includes(x)) {
    return 700 - Math.abs(x.length - y.length);
  }

  const ax = new Set(x.split(" "));
  const by = new Set(y.split(" "));
  const common = [...ax].filter((word) => by.has(word)).length;
  return common * 60 - Math.abs(x.length - y.length);
}

function githubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main"
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`ZeroZero respondeu ${response.status}`);
  }

  return response.text();
}

async function fetchImage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) return null;

  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("image/")) return null;

  return Buffer.from(await response.arrayBuffer());
}

function absoluteUrl(base, value) {
  try {
    return new URL(String(value).replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
}

function stripHtml(value = "") {
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

function extractTeamLinks(html) {
  const result = [];
  const seen = new Set();

  const re =
    /<a\b[^>]*href=["']([^"']*\/equipa\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = re.exec(html))) {
    const href = absoluteUrl(ZEROZERO, match[1]);
    const label = stripHtml(match[2]);

    if (!href || !label || seen.has(href)) continue;
    if (label.length > 120) continue;

    seen.add(href);
    result.push({ url: href, name: label });
  }

  return result;
}

function extractLogoCandidates(html, pageUrl) {
  const candidates = [];
  const add = (value) => {
    const url = absoluteUrl(pageUrl, value);
    if (!url || !IMAGE_RE.test(url)) return;
    if (!candidates.includes(url)) candidates.push(url);
  };

  // Direct image URLs.
  const direct =
    /https?:\/\/[^"'<>\\s]+\/img\/logos\/equipas\/[^"'<>\\s]+/gi;

  for (const match of html.matchAll(direct)) {
    add(match[0]);
  }

  // src/data-src/data-original.
  const attributes =
    /(?:src|data-src|data-original|content)=["']([^"']*\/img\/logos\/equipas\/[^"']+)["']/gi;

  for (const match of html.matchAll(attributes)) {
    add(match[1]);
  }

  // srcset.
  const srcset = /srcset=["']([^"']+)["']/gi;
  for (const match of html.matchAll(srcset)) {
    for (const item of match[1].split(",")) {
      add(item.trim().split(/\s+/)[0]);
    }
  }

  return candidates;
}

async function findZeroZeroTeam(teamName) {
  const query = cleanTeamName(teamName);

  const searchUrls = [
    `${ZEROZERO}/search.php?search_string=${encodeURIComponent(query)}`,
    `${ZEROZERO}/pesquisa?query=${encodeURIComponent(query)}`
  ];

  const candidates = [];

  for (const searchUrl of searchUrls) {
    try {
      const html = await fetchText(searchUrl);
      candidates.push(...extractTeamLinks(html));
      if (candidates.length) break;
    } catch {
      // Try the next known ZeroZero search format.
    }
  }

  if (!candidates.length) {
    throw new Error(`Equipa "${query}" não encontrada no ZeroZero.`);
  }

  const ranked = candidates
    .map((item) => ({
      ...item,
      score: similarityScore(query, item.name)
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  // Never accept a weak match. This prevents "Sporting" from becoming
  // an unrelated Sporting team just because it appeared first.
  if (best.score < 500) {
    throw new Error(
      `O resultado do ZeroZero não foi suficientemente seguro para "${query}".`
    );
  }

  const pageHtml = await fetchText(best.url);
  const logos = extractLogoCandidates(pageHtml, best.url);

  if (!logos.length) {
    throw new Error(
      `A página do ZeroZero para "${best.name}" não contém o escudo esperado.`
    );
  }

  return {
    requestedName: query,
    zeroZeroName: best.name,
    zeroZeroPage: best.url,
    zeroZeroScore: best.score,
    logoUrl: logos[0]
  };
}

async function imageDataUrl(buffer) {
  const png = await sharp(buffer, { failOn: "none" })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString("base64")}`;
}

async function githubRequest(url, options = {}) {
  const { token } = githubConfig();

  if (!token) {
    throw new Error("GITHUB_TOKEN não está configurado na Vercel.");
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

async function findCachedShield(teamName) {
  const { repo, branch } = githubConfig();
  if (!repo) return null;

  const url =
    `https://api.github.com/repos/${repo}/contents/public/escudos` +
    `?ref=${encodeURIComponent(branch)}`;

  try {
    const response = await githubRequest(url);
    if (!response.ok) return null;

    const files = await response.json();
    const wanted = safeFilename(teamName);

    const file = files.find((item) => {
      if (item.type !== "file") return false;

      const filename = item.name
        .replace(/\.(png|jpe?g|webp|svg)$/i, "");

      return safeFilename(filename) === wanted;
    });

    if (!file?.download_url) return null;

    const image = await fetchImage(file.download_url);
    if (!image) return null;

    return {
      team: teamName,
      imageDataUrl: await imageDataUrl(image),
      url: file.download_url,
      source: "GitHub",
      cached: true,
      verified: true
    };
  } catch {
    return null;
  }
}

async function saveShield(teamName, imageData) {
  const { repo, branch } = githubConfig();

  if (!repo) {
    return {
      ok: false,
      error: "GITHUB_REPO não está configurado na Vercel."
    };
  }

  const match = String(imageData).match(
    /^data:image\/png;base64,(.+)$/i
  );

  if (!match) {
    return {
      ok: false,
      error: "A imagem a guardar não está no formato PNG esperado."
    };
  }

  const filename = `${safeFilename(teamName)}.png`;
  const path = `public/escudos/${filename}`;

  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    path.split("/").map(encodeURIComponent).join("/");

  const encoded = match[1];

  // Check whether the file already exists. If it does, never overwrite it
  // automatically: a previously saved shield is considered authoritative.
  const existing = await githubRequest(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`
  );

  if (existing.ok) {
    const data = await existing.json();
    return {
      ok: true,
      alreadyExists: true,
      path,
      sha: data.sha
    };
  }

  if (existing.status !== 404) {
    return {
      ok: false,
      error: `GitHub não conseguiu verificar o escudo (${existing.status}).`
    };
  }

  const response = await githubRequest(apiUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Adicionar escudo: ${cleanTeamName(teamName)}`,
      content: encoded,
      branch
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      error: result?.message || `GitHub respondeu ${response.status}.`
    };
  }

  return {
    ok: true,
    alreadyExists: false,
    path
  };
}

function requestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  try {
    // POST is kept for compatibility with the existing manual-save flow.
    if (req.method === "POST") {
      const { team, dataUrl } = requestBody(req);

      if (!team || !dataUrl) {
        return res.status(400).json({
          error: "team e dataUrl são obrigatórios."
        });
      }

      const saved = await saveShield(team, dataUrl);

      return res.status(saved.ok ? 200 : 500).json(saved);
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        error: "Method not allowed"
      });
    }

    const team = cleanTeamName(req.query?.team || "");

    if (!team) {
      return res.status(400).json({
        error: "Indica o nome da equipa."
      });
    }

    // 1. Existing shield wins. No unnecessary network request.
    const cached = await findCachedShield(team);
    if (cached) {
      return res.status(200).json(cached);
    }

    // 2. ZeroZero is the single source used to find and download the crest.
    const found = await findZeroZeroTeam(team);

    const originalImage = await fetchImage(found.logoUrl);

    if (!originalImage) {
      return res.status(404).json({
        error: "O escudo encontrado no ZeroZero não pôde ser descarregado.",
        zeroZeroName: found.zeroZeroName,
        zeroZeroPage: found.zeroZeroPage
      });
    }

    const image = await imageDataUrl(originalImage);

    // 3. Save the exact ZeroZero crest as a normalized PNG.
    const saved = await saveShield(team, image);

    return res.status(saved.ok ? 200 : 502).json({
      team,
      matchedTeam: found.zeroZeroName,
      zeroZeroPage: found.zeroZeroPage,
      zeroZeroImage: found.logoUrl,
      zeroZeroScore: found.zeroZeroScore,
      imageDataUrl: image,
      source: "ZeroZero",
      verified: true,
      saved: saved.ok,
      savedPath: saved.path || null,
      alreadyExists: saved.alreadyExists || false,
      saveError: saved.ok ? null : saved.error
    });
  } catch (error) {
    console.error("[escudo]", error);

    return res.status(500).json({
      error: error?.message || "Erro ao obter o escudo.",
      source: "ZeroZero"
    });
  }
}
