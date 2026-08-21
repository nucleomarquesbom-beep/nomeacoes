import { resolveShield } from './shield-service.mjs';

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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const team = String(
      req.query?.team || ''
    ).trim();

    if (!team) {
      return res.status(400).json({
        ok: false,
        error: 'TEAM_REQUIRED'
      });
    }

    try {
      return res.status(200).json(
        await resolveShield(team)
      );
    } catch (error) {
      const code =
        error?.message || 'SHIELD_NOT_FOUND';

      console.error('[ESCUDO]', {
        team,
        code
      });

      return res.status(502).json({
        ok: false,
        team,
        error: code
      });
    }
  }

  if (req.method === 'POST') {
    const body = parseBody(req);

    const teams = Array.isArray(body.teams)
      ? body.teams
      : body.team
        ? [body.team]
        : [];

    const unique = [
      ...new Set(
        teams
          .map(v =>
            String(v || '')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(Boolean)
      )
    ];

    if (!unique.length) {
      return res.status(400).json({
        ok: false,
        error: 'TEAMS_REQUIRED'
      });
    }

    const results = [];

    // Sequencial de propósito: evita bombardear FPF/ZeroZero.
    for (const team of unique) {
      try {
        results.push(
          await resolveShield(team)
        );
      } catch (error) {
        results.push({
          ok: false,
          team,
          error:
            error?.message ||
            'SHIELD_NOT_FOUND'
        });
      }
    }

    return res.status(200).json({
      ok: true,
      results,
      summary: {
        total: results.length,
        found: results.filter(x => x.ok).length,
        failed: results.filter(x => !x.ok).length
      }
    });
  }

  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED'
  });
}
