function safeName(name = '') {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return res.status(500).json({
      error: 'GITHUB_TOKEN ou GITHUB_REPO não configurado no Vercel.'
    });
  }

  const { name, dataUrl } = parseBody(req);

  if (!name || !dataUrl) {
    return res.status(400).json({ error: 'name e dataUrl são obrigatórios.' });
  }

  const match = String(dataUrl).match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: 'Imagem inválida.' });
  }

  const base64 = match[1];
  const filename = safeName(name) + '.jpg';
  const path = `public/fotografias/${filename}`;

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };

  const apiBase = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

  try {
    // If the photo already exists, obtain its SHA so GitHub accepts the update.
    let sha;
    const current = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
      headers
    });

    if (current.ok) {
      const existing = await current.json();
      sha = existing.sha;
    } else if (current.status !== 404) {
      const detail = await current.text();
      return res.status(current.status).json({
        error: `GitHub GET falhou: ${detail.slice(0, 500)}`
      });
    }

    const payload = {
      message: `Adicionar fotografia: ${filename}`,
      content: base64,
      branch,
      ...(sha ? { sha } : {})
    };

    const put = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    const result = await put.json().catch(() => ({}));

    if (!put.ok) {
      return res.status(put.status).json({
        error:
          result?.message ||
          `GitHub PUT falhou (${put.status})`
      });
    }

    return res.status(200).json({
      ok: true,
      path,
      url: `/${path}`,
      commit: result?.commit?.sha || null
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || 'Erro ao guardar fotografia no GitHub.'
    });
  }
}
