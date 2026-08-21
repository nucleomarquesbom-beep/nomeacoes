import {
  resolveShield,
  resolveShields
} from './shield-service.mjs';

function parseBody(req) {
  if (
    req.body &&
    typeof req.body === 'object'
  ) {
    return req.body;
  }

  try {
    return JSON.parse(
      req.body || '{}'
    );
  } catch {
    return {};
  }
}

export default async function handler(
  req,
  res
) {
  if (req.method === 'GET') {
    const team =
      String(
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
        error?.message ||
        'SHIELD_NOT_FOUND';

      console.error(
        '[ESCUDO]',
        { team, code }
      );

      return res.status(502).json({
        ok: false,
        team,
        error: code
      });
    }
  }

  if (req.method === 'POST') {
    const body =
      parseBody(req);

    const teams =
      Array.isArray(body.teams)
        ? body.teams
        : body.team
          ? [body.team]
          : [];

    if (!teams.length) {
      return res.status(400).json({
        ok: false,
        error: 'TEAMS_REQUIRED'
      });
    }

    const result =
      await resolveShields(
        teams
      );

    return res.status(200).json(
      result
    );
  }

  res.setHeader(
    'Allow',
    'GET, POST'
  );

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED'
  });
}
