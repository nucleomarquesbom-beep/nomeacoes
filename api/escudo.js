import sharp from "sharp";

const ZEROZERO = "https://www.zerozero.pt";
const UA = "Mozilla/5.0 (compatible; NAF-Marques-Bom/4.0)";
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

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

function scoreName(a, b) {
  const x = normalize(a);
  const y = normalize(b);

  if (!x || !y) return -1;
  if (x === y) return 1000;

  const ax = x.split(" ");
  const by = new Set(y.split(" "));
  const common = ax.filter(word => word.length > 1 && by.has(word)).length;

  let score = common * 100;
  if (x.includes(y) || y.includes(x)) score += 300;

  score -= Math.abs(x.length - y.length);
  return score;
}

function gh() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main"
  };
}

async function http(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      ...(options.headers || {})
    }
  });
}

async function github(url, options = {}) {
  const { token } = gh();

  if (!token) throw new Error("GITHUB_TOKEN não configurado.");
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

function absolute(base, value) {
  try {
    return new URL(String(value).replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
}

function textOnly(html) {
  return String(html)
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

function teamLinks(html, baseUrl, wanted) {
  const found = [];
  const seen = new Set();

  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html))) {
    const url = absolute(baseUrl, m[1]);
    if (!url) continue;

    let parsed;
    try { parsed = new URL(url); } catch { continue; }

    if (parsed.hostname !== "www.zerozero.pt") continue;
    if (!/^\/equipa\//i.test(parsed.pathname)) continue;

    const name = textOnly(m[2]);
    if (!name || name.length > 120) continue;

    const cleanUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);

    found.push({
      name,
      url: cleanUrl,
      score: scoreName(wanted, name)
    });
  }

  return found.sort((a, b) => b.score - a.score);
}

function logoCandidates(html, pageUrl) {
  const result = [];
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
    result.push(url);
  };

  // The ZeroZero team logo path.
  for (const m of html.matchAll(
    /https?:\/\/[^"'<> \t\r\n]+\/img\/logos\/equipas\/[^"'<> \t\r\n]+/gi
  )) add(m[0]);

  // Common lazy-loading attributes.
  for (const m of html.matchAll(
    /(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi
  )) {
    if (
      /\/img\/logos\/equipas\//i.test(m[1]) ||
      /(logo|badge|emblem|escudo|crest)/i.test(m[1])
    ) add(m[1]);
  }

  // OpenGraph fallback, but only if it is hosted by ZeroZero.
  for (const m of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) add(m[1]);

  return result;
}

async function findZeroZero(team) {
  const query = cleanTeam(team);

  const urls = [
    `${ZEROZERO}/pesquisa?search_txt=${encodeURIComponent(query)}`,
    `${ZEROZERO}/search.php?search_string=${encodeURIComponent(query)}`
  ];

  let candidates = [];

  for (const searchUrl of urls) {
    try {
      const r = await http(searchUrl, {
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      if (!r.ok) continue;

      const html = await r.text();
      candidates = teamLinks(html, searchUrl, query);

      if (candidates.length) break;
    } catch {}
  }

  if (!candidates.length) {
    throw new Error(`ZeroZero não encontrou "${query}".`);
  }

  const best = candidates[0];

  if (best.score < 500) {
    throw new Error(
      `ZeroZero encontrou resultados, mas nenhum é suficientemente seguro para "${query}".`
    );
  }

  const page = await http(best.url, {
    headers: { Accept: "text/html,application/xhtml+xml" }
  });

  if (!page.ok) {
    throw new Error(`Página ZeroZero respondeu ${page.status}.`);
  }

  const html = await page.text();
  const logos = logoCandidates(html, best.url);

  if (!logos.length) {
    throw new Error(`Escudo não encontrado na página ZeroZero de "${best.name}".`);
  }

  return {
    requested: query,
    matched: best.name,
    page: best.url,
    score: best.score,
    logoUrl: logos[0]
  };
}

async function download(url) {
  const r = await http(url, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
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

async function pngDataUrl(buffer) {
  const png = await sharp(buffer, { failOn: "none" })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString("base64")}`;
}

async function githubExisting(team) {
  const { repo, branch } = gh();
  if (!repo) return null;

  const url =
    `https://api.github.com/repos/${repo}/contents/public/escudos` +
    `?ref=${encodeURIComponent(branch)}`;

  try {
    const r = await github(url);
    if (!r.ok) return null;

    const files = await r.json();
    const wanted = slug(team);

    const file = files.find(f =>
      f.type === "file" &&
      slug(f.name.replace(/\.(png|jpe?g|webp|svg)$/i, "")) === wanted
    );

    if (!file?.download_url) return null;

    const image = await download(file.download_url);
    if (!image) return null;

    return {
      imageDataUrl: await pngDataUrl(image),
      source: "GitHub",
      cached: true,
      path: file.path
    };
  } catch {
    return null;
  }
}

async function saveToGithub(team, dataUrl) {
  const { repo, branch } = gh();

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
      error: "Imagem inválida."
    };
  }

  const path = `public/escudos/${slug(team)}.png`;
  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    path.split("/").map(encodeURIComponent).join("/");

  // Never overwrite an existing crest automatically.
  const current = await github(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`
  );

  if (current.ok) {
    return {
      saved: true,
      alreadyExists: true,
      path
    };
  }

  if (current.status !== 404) {
    return {
      saved: false,
      error: `GitHub não conseguiu verificar ${path} (${current.status}).`
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

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

async function one(team) {
  const name = cleanTeam(team);

  if (!name) {
    return { team, ok: false, error: "Nome vazio." };
  }

  const cached = await githubExisting(name);
  if (cached) {
    return {
      team: name,
      ok: true,
      ...cached
    };
  }

  const found = await findZeroZero(name);
  const image = await download(found.logoUrl);

  if (!image) {
    return {
      team: name,
      ok: false,
      source: "ZeroZero",
      error: "Não foi possível descarregar o escudo."
    };
  }

  const imageDataUrl = await pngDataUrl(image);
  const saved = await saveToGithub(name, imageDataUrl);

  return {
    team: name,
    matchedTeam: found.matched,
    zeroZeroPage: found.page,
    zeroZeroImage: found.logoUrl,
    score: found.score,
    source: "ZeroZero",
    ok: true,
    imageDataUrl,
    ...saved
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const data = body(req);

      // Batch mode: the app can send all missing teams in one request.
      if (Array.isArray(data.teams)) {
        const unique = [...new Set(
          data.teams.map(cleanTeam).filter(Boolean)
        )];

        const results = [];

        // Small concurrency avoids hammering ZeroZero/GitHub.
        const concurrency = 3;
        for (let i = 0; i < unique.length; i += concurrency) {
          const batch = unique.slice(i, i + concurrency);
          const part = await Promise.all(
            batch.map(team =>
              one(team).catch(error => ({
                team,
                ok: false,
                error: error?.message || "Erro desconhecido."
              }))
            )
          );
          results.push(...part);
        }

        return res.status(200).json({
          ok: true,
          total: unique.length,
          results
        });
      }

      if (!data.team) {
        return res.status(400).json({ error: "team obrigatório." });
      }

      return res.status(200).json(await one(data.team));
    }

    if (req.method === "GET") {
      const team = cleanTeam(req.query?.team || "");

      if (!team) {
        return res.status(400).json({ error: "team obrigatório." });
      }

      return res.status(200).json(await one(team));
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("[escudo]", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "Erro ao obter escudo."
    });
  }
}
