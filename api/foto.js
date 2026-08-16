const UA = 'GeradorNomeacoesMarquesBom/4.0';

function cleanName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Método não permitido.' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'nucleomarquesbom-beep/nomeacoes';
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token) {
    return json(res, 500, {
      ok: false,
      error: 'GITHUB_TOKEN não está configurado no Vercel.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const name = cleanName(body.name);
    const dataUrl = String(body.dataUrl || '');
    const mime = String(body.mime || '').toLowerCase();

    if (!name) return json(res, 400, { ok: false, error: 'Nome do árbitro em falta.' });
    if (!/^image\/(png|jpe?g|webp)$/.test(mime)) {
      return json(res, 400, { ok: false, error: 'Formato inválido. Usa PNG, JPG ou WEBP.' });
    }
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      return json(res, 400, { ok: false, error: 'Fotografia inválida.' });
    }

    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const path = `public/fotografias/${name}.${ext}`;
    const content = dataUrl.split(',')[1];
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      'Content-Type': 'application/json'
    };

    // If the exact filename already exists, obtain its SHA so GitHub updates it.
    let sha;
    const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (existing.ok) {
      const info = await existing.json();
      sha = info.sha;
    } else if (existing.status !== 404) {
      const text = await existing.text();
      return json(res, 502, { ok: false, error: `GitHub: ${text.slice(0, 300)}` });
    }

    const payload = {
      message: `Adicionar fotografia de ${name}`,
      content,
      branch,
      ...(sha ? { sha } : {})
    };

    const put = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    if (!put.ok) {
      const text = await put.text();
      return json(res, 502, { ok: false, error: `GitHub: ${text.slice(0, 500)}` });
    }

    const publicUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    return json(res, 200, { ok: true, path, publicUrl });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e?.message || 'Erro interno.' });
  }
}
