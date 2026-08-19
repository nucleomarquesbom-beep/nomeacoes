import sharp from "sharp";

const ZEROZERO = "https://www.zerozero.pt";
const UA = "Mozilla/5.0 (compatible; NAF-Marques-Bom/3.0)";

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

function scoreName(a, b) {
  const x = normalize(a);
  const y = normalize(b);

  if (!x || !y) return -1;
  if (x === y) return 1000;

  if (x.includes(y) || y.includes(x)) {
    return 700 - Math.abs(x.length - y.length);
  }

  const A = new Set(x.split(" "));
  const B = new Set(y.split(" "));
  const common = [...A].filter(word => B.has(word)).length;

  return common * 60 - Math.abs(x.length - y.length);
}

function githubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main"
  };
}

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "User-Agent": UA,
      ...(options.headers || {})
    },
    redirect: "follow"
  });
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

function absoluteUrl(base, value) {
  try {
    return new URL(
      String(value).replace(/&amp;/g, "&").replace(/\\\//g, "/"),
      base
    ).href;
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

/*
 * O ZeroZero actual usa /pesquisa?search_txt=...
 * O endpoint antigo /search.php?search_string=... fica como fallback.
 */
async function searchZeroZero(query) {
  const urls = [
    `${ZEROZERO}/pesquisa?search_txt=${encodeURIComponent(query)}`,
    `${ZEROZERO}/search.php?search_string=${encodeURIComponent(query)}`
  ];

  const candidates = [];
  const seen = new Set();

  for (const url of urls) {
    try {
      const response = await request(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml"
        }
      });

      if (!response.ok) continue;

      const html = await response.text();

      /*
       * Aceitamos /equipa/ e também URLs de equipa que o ZeroZero
       * possa introduzir no futuro. Nunca aceitamos links externos.
       */
      const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;

      while ((match = re.exec(html))) {
        const href = absoluteUrl(url, match[1]);
        if (!href) continue;

        let parsed;
        try {
          parsed = new URL(href);
        } catch {
          continue;
        }

        if (parsed.hostname !== "www.zerozero.pt") continue;
        if (!/\/equipa\//i.test(parsed.pathname)) continue;

        const label = stripHtml(match[2]);
        if (!label || label.length > 140) continue;

        const cleanUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;

        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        candidates.push({
          name: label,
          url: cleanUrl,
          score: scoreName(query, label)
        });
      }

      /*
       * O endpoint correcto respondeu: não é necessário fazer uma
       * segunda pesquisa que possa duplicar resultados.
       */
      if (candidates.length) break;
    } catch {
      // Tenta o endpoint seguinte.
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function extractLogoCandidates(html, pageUrl) {
  const out = [];
  const seen = new Set();

  function add(raw, reason = "") {
    const url = absoluteUrl(pageUrl, raw);
    if (!url) return;

    try {
      const parsed = new URL(url);

      /*
       * A imagem tem de vir do ZeroZero ou de um domínio/CDN usado
       * pelo próprio ZeroZero. Não aceitamos imagens de terceiros.
       */
      const ownDomain =
        parsed.hostname === "www.zerozero.pt" ||
        parsed.hostname.endsWith(".zerozero.pt");

      if (!ownDomain) return;

      if (seen.has(url)) return;
      seen.add(url);

      out.push({ url, reason });
    } catch {}
  }

  /*
   * 1. Caminho clássico dos escudos do ZeroZero.
   */
  for (const m of html.matchAll(
    /https?:\/\/[^"'<>\\s]+\/img\/logos\/equipas\/[^"'<>\\s]+/gi
  )) {
    add(m[0], "logo-equipa");
  }

  /*
   * 2. Meta og:image/twitter:image.
   */
  for (const m of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) {
    add(m[1], "meta-image");
  }

  /*
   * 3. src/data-src/data-original.
   */
  for (const m of html.matchAll(
    /(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi
  )) {
    const raw = m[1];

    if (
      /\/img\/logos\/equipas\//i.test(raw) ||
      /(logo|badge|emblem|escudo|crest)/i.test(raw)
    ) {
      add(raw, "img-logo");
    }
  }

  /*
   * 4. srcset.
   */
  for (const m of html.matchAll(
    /srcset=["']([^"']+)["']/gi
  )) {
    for (const part of m[1].split(",")) {
      const raw = part.trim().split(/\s+/)[0];

      if (
        /\/img\/logos\/equipas\//i.test(raw) ||
        /(logo|badge|emblem|escudo|crest)/i.test(raw)
      ) {
        add(raw, "srcset-logo");
      }
    }
  }

  return out;
}

async function findZeroZeroTeam(teamName) {
  const query = cleanTeamName(teamName);
  const candidates = await searchZeroZero(query);

  if (!candidates.length) {
    throw new Error(
      `A pesquisa do ZeroZero não devolveu equipas para "${query}".`
    );
  }

  /*
   * O primeiro resultado tem de ser uma correspondência forte.
   * Isto evita escolher, por exemplo, outra equipa com o mesmo nome
   * mas de uma cidade/modalidade diferente.
   */
  const best = candidates[0];

  if (best.score < 500) {
    throw new Error(
      `O ZeroZero devolveu resultados, mas nenhum corresponde com segurança a "${query}".`
    );
  }

  const pageResponse = await request(best.url, {
    headers: {
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!pageResponse.ok) {
    throw new Error(
      `A página da equipa no ZeroZero respondeu ${pageResponse.status}.`
    );
  }

  const pageHtml = await pageResponse.text();
  const logos = extractLogoCandidates(pageHtml, best.url);

  if (!logos.length) {
    throw new Error(
      `A página "${best.name}" foi encontrada no ZeroZero, mas o escudo não foi localizado.`
    );
  }

  return {
    requestedName: query,
    zeroZeroName: best.name,
    zeroZeroPage: best.url,
    zeroZeroScore: best.score,
    logoUrl: logos[0].url
  };
}

async function downloadImage(url) {
  try {
    const response = await request(url, {
      headers: {
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) return null;

    const type =
      (response.headers.get("content-type") || "").toLowerCase();

    if (!type.startsWith("image/")) return null;

    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function toPngDataUrl(buffer) {
  const png = await sharp(buffer, {
    failOn: "none"
  })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString("base64")}`;
}

async function findCachedShield(teamName) {
  const { repo, branch } = githubConfig();

  if (!repo) return null;

  try {
    const response = await githubRequest(
      `https://api.github.com/repos/${repo}/contents/public/escudos?ref=${encodeURIComponent(branch)}`
    );

    if (!response.ok) return null;

    const files = await response.json();
    const wanted = safeFilename(teamName);

    /*
     * Mantemos compatibilidade com os nomes que já tens no GitHub.
     * Não obrigamos a que o nome pedido seja exactamente igual ao
     * nome do ficheiro.
     */
    const variants = new Set([
      wanted,
      safeFilename(
        teamName.replace(/\s*\/\s*(?:OAF|SAD|SDUQ)\s*$/i, "")
      ),
      safeFilename(teamName.replace(/[,.]/g, ""))
    ]);

    const file = files.find(item => {
      if (item.type !== "file") return false;

      const base = item.name.replace(
        /\.(png|jpe?g|webp|svg)$/i,
        ""
      );

      return variants.has(safeFilename(base));
    });

    if (!file?.download_url) return null;

    const buffer = await downloadImage(file.download_url);
    if (!buffer) return null;

    return {
      team: teamName,
      imageDataUrl: await toPngDataUrl(buffer),
      url: file.download_url,
      source: "GitHub",
      cached: true,
      verified: true
    };
  } catch {
    return null;
  }
}

async function saveShield(teamName, dataUrl) {
  const { repo, branch } = githubConfig();

  if (!repo) {
    return {
      ok: false,
      error: "GITHUB_REPO não está configurado na Vercel."
    };
  }

  const match = String(dataUrl).match(
    /^data:image\/png;base64,(.+)$/i
  );

  if (!match) {
    return {
      ok: false,
      error: "A imagem não está no formato PNG esperado."
    };
  }

  const filename = `${safeFilename(teamName)}.png`;
  const filePath = `public/escudos/${filename}`;

  const apiUrl =
    `https://api.github.com/repos/${repo}/contents/` +
    filePath.split("/").map(encodeURIComponent).join("/");

  const existing = await githubRequest(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`
  );

  if (existing.ok) {
    const current = await existing.json();

    return {
      ok: true,
      alreadyExists: true,
      path: filePath,
      sha: current.sha
    };
  }

  if (existing.status !== 404) {
    return {
      ok: false,
      error: `Não foi possível verificar o ficheiro no GitHub (${existing.status}).`
    };
  }

  const response = await githubRequest(apiUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Adicionar escudo: ${cleanTeamName(teamName)}`,
      content: match[1],
      branch
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      error:
        result?.message ||
        `GitHub respondeu ${response.status}.`
    };
  }

  return {
    ok: true,
    alreadyExists: false,
    path: filePath
  };
}

function requestBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  try {
    /*
     * Mantém a gravação manual existente.
     */
    if (req.method === "POST") {
      const { team, dataUrl } = requestBody(req);

      if (!team || !dataUrl) {
        return res.status(400).json({
          error: "team e dataUrl são obrigatórios."
        });
      }

      const saved = await saveShield(team, dataUrl);

      return res
        .status(saved.ok ? 200 : 500)
        .json(saved);
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        error: "Method not allowed"
      });
    }

    const team = cleanTeamName(
      req.query?.team || ""
    );

    if (!team) {
      return res.status(400).json({
        error: "Indica o nome da equipa."
      });
    }

    /*
     * =====================================================
     * 1. CACHE LOCAL / GITHUB
     * =====================================================
     *
     * Se já temos o escudo, não consultamos o ZeroZero.
     */
    const cached = await findCachedShield(team);

    if (cached) {
      return res.status(200).json(cached);
    }

    /*
     * =====================================================
     * 2. ZEROZERO
     * =====================================================
     *
     * O ZeroZero é a única fonte de descoberta e download.
     */
    const found = await findZeroZeroTeam(team);

    const buffer = await downloadImage(found.logoUrl);

    if (!buffer) {
      return res.status(404).json({
        error:
          "A equipa foi encontrada no ZeroZero, mas o escudo não pôde ser descarregado.",
        zeroZeroName: found.zeroZeroName,
        zeroZeroPage: found.zeroZeroPage
      });
    }

    /*
     * Guardamos exactamente o escudo que veio do ZeroZero,
     * apenas normalizado para PNG.
     */
    const imageDataUrl = await toPngDataUrl(buffer);

    const saved = await saveShield(
      team,
      imageDataUrl
    );

    return res
      .status(saved.ok ? 200 : 502)
      .json({
        team,
        matchedTeam: found.zeroZeroName,
        zeroZeroPage: found.zeroZeroPage,
        zeroZeroImage: found.logoUrl,
        zeroZeroScore: found.zeroZeroScore,
        imageDataUrl,
        source: "ZeroZero",
        verified: true,
        saved: saved.ok,
        savedPath: saved.path || null,
        alreadyExists: saved.alreadyExists || false,
        saveError: saved.ok
          ? null
          : saved.error
      });
  } catch (error) {
    console.error("[escudo]", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Erro ao procurar o escudo no ZeroZero.",
      source: "ZeroZero"
    });
  }
}
