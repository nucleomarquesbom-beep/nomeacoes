import {
  resolveShield
} from './shield-service.mjs';

function stripExtension(
  value = ''
) {
  return String(value)
    .replace(
      /\.(?:png|jpe?g|webp|svg)$/i,
      ''
    )
    .trim();
}

function parseDataUrl(
  dataUrl
) {
  const match =
    String(dataUrl || '')
      .match(
        /^data:(image\/[^;]+);base64,([\s\S]+)$/
      );

  if (!match) return null;

  return {
    mime:
      match[1].toLowerCase(),
    buffer:
      Buffer.from(
        match[2],
        'base64'
      )
  };
}

export default async function handler(
  req,
  res
) {
  if (req.method !== 'GET') {
    res.setHeader(
      'Allow',
      'GET'
    );

    return res
      .status(405)
      .end(
        'Method Not Allowed'
      );
  }

  const team =
    stripExtension(
      req.query?.team || ''
    );

  if (!team) {
    return res.status(400).json({
      ok: false,
      error: 'TEAM_REQUIRED'
    });
  }

  try {
    const result =
      await resolveShield(team);

    const image =
      parseDataUrl(
        result.imageDataUrl
      );

    if (!image) {
      return res.status(502).json({
        ok: false,
        team,
        error:
          'IMAGE_DATA_INVALID'
      });
    }

    res.setHeader(
      'Content-Type',
      image.mime
    );

    res.setHeader(
      'Content-Length',
      String(
        image.buffer.length
      )
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
    );

    res.setHeader(
      'X-Shield-Source',
      result.source ||
        'FPF->ZeroZero'
    );

    return res
      .status(200)
      .send(image.buffer);
  } catch (error) {
    const code =
      error?.message ||
      'SHIELD_NOT_FOUND';

    console.error(
      '[ESCUDO-IMAGE]',
      {
        team,
        code
      }
    );

    res.setHeader(
      'X-Shield-Error',
      code
    );

    return res.status(
      code ===
        'FPF_NUMBER_NOT_FOUND' ||
      code ===
        'FPF_DIRECTORY_EMPTY' ||
      code ===
        'ZEROZERO_TEAM_NOT_FOUND' ||
      code ===
        'ZEROZERO_NUM_FPF_NOT_CONFIRMED'
        ? 404
        : 502
    ).json({
      ok: false,
      team,
      error: code
    });
  }
}
