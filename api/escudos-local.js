/**
 * Compatibilidade com a aplicação atual.
 *
 * A procura local de escudos fica deliberadamente desativada.
 * Todos os escudos são agora resolvidos online através da FPF
 * pelo /api/escudo.
 *
 * Mantemos o endpoint para não obrigar o frontend atual a ter
 * uma segunda arquitetura. O inventário é sempre vazio.
 */

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  return res.status(200).json({
    shields: {},
    count: 0,
    source: 'FPF'
  });
}
