function safeName(name = '') {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl).match(
    /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i
  );

  if (!match) {
    return null;
  }

  const rawExt = match[1].toLowerCase();

  return {
    extension:
      rawExt === 'jpeg'
        ? 'jpg'
        : rawExt,
    base64: match[2]
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res
      .status(405)
      .json({
        error: 'Method not allowed'
      });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch =
    process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return res
      .status(500)
      .json({
        error:
          'GITHUB_TOKEN ou GITHUB_REPO não configurado no Vercel.'
      });
  }

  const {
    name,
    dataUrl
  } = parseBody(req);

  if (!name || !dataUrl) {
    return res
      .status(400)
      .json({
        error:
          'name e dataUrl são obrigatórios.'
      });
  }

  const image =
    parseImageDataUrl(dataUrl);

  if (!image) {
    return res
      .status(400)
      .json({
        error:
          'Imagem inválida. São aceites JPEG, PNG ou WEBP.'
      });
  }

  /*
   * As fotografias dos árbitros ficam na biblioteca
   * principal. Não existe pasta "recortadas" porque
   * não fazemos remoção de fundo nesta versão.
   */
  const filename =
    safeName(name) +
    '.' +
    image.extension;

  const path =
    `public/fotografias/${filename}`;

  const apiBase =
    `https://api.github.com/repos/${repo}/contents/` +
    `${encodeURIComponent(path).replace(/%2F/g, '/')}`;

  const headers = {
    Accept:
      'application/vnd.github+json',
    Authorization:
      `Bearer ${token}`,
    'X-GitHub-Api-Version':
      '2022-11-28',
    'Content-Type':
      'application/json'
  };

  try {
    let sha;

    /*
     * Se a fotografia já existir, fazemos UPDATE.
     * Assim não criamos ficheiros duplicados.
     */
    const current =
      await fetch(
        `${apiBase}?ref=${encodeURIComponent(branch)}`,
        { headers }
      );

    if (current.ok) {
      const existing =
        await current.json();

      sha = existing.sha;
    } else if (
      current.status !== 404
    ) {
      const detail =
        await current.text();

      return res
        .status(current.status)
        .json({
          error:
            `GitHub GET falhou: ` +
            detail.slice(0, 500)
        });
    }

    const payload = {
      message:
        `Guardar fotografia: ${filename}`,
      content:
        image.base64,
      branch,
      ...(sha ? { sha } : {})
    };

    const put =
      await fetch(
        apiBase,
        {
          method: 'PUT',
          headers,
          body:
            JSON.stringify(payload)
        }
      );

    const result =
      await put
        .json()
        .catch(() => ({}));

    if (!put.ok) {
      return res
        .status(put.status)
        .json({
          error:
            result?.message ||
            `GitHub PUT falhou (${put.status})`
        });
    }

    return res
      .status(200)
      .json({
        ok: true,
        path,
        url: `/${path}`,
        commit:
          result?.commit?.sha ||
          null
      });

  } catch (error) {
    return res
      .status(500)
      .json({
        error:
          error?.message ||
          'Erro ao guardar fotografia no GitHub.'
      });
  }
}
