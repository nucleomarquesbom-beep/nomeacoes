import { resolveShield, resolveShields } from './shield-service.mjs';

function jsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function sendError(res, status, team, error, extra = {}) {
  console.error('[ESCUDO]', { team, error, ...extra });
  return res.status(status).json({ ok: false, team, error, ...extra });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const team = String(req.query?.team || '').trim();
    if (!team) return sendError(res, 400, '', 'TEAM_REQUIRED');

    try {
      const result = await resolveShield(team);
      return res.status(result.ok ? 200 : 404).json(result);
    } catch (error) {
      return sendError(res, 200, team, error?.message || 'SHIELD_NOT_FOUND', {
        retriable: true
      });
    }
  }

  if (req.method === 'POST') {
    const body = jsonBody(req);
    const teams = Array.isArray(body.teams)
      ? body.teams
      : body.team ? [body.team] : [];

    if (!teams.length) return sendError(res, 400, '', 'TEAMS_REQUIRED');
    if (teams.length > 100) return sendError(res, 413, '', 'TOO_MANY_TEAMS');

    try {
      const result = await resolveShields(teams);
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, 200, '', error?.message || 'SHIELD_BATCH_FAILED', {
        retriable: true
      });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return sendError(res, 405, '', 'METHOD_NOT_ALLOWED');
}
