/**
 * Regras únicas de normalização de nomes de equipas.
 *
 * SAD / SDUQ / OAF são tratados como sufixos jurídicos.
 * A normalização é usada para pesquisa/correspondência;
 * nunca substitui o nome original apresentado na nomeação.
 */

export function cleanText(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(value = '') {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ºª°]/g, '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compact(value = '') {
  return normalizeText(value).replace(/\s+/g, '');
}

/**
 * Remove apenas o sufixo jurídico quando aparece no fim.
 *
 * Exemplos:
 *   "FC Porto, SAD"     -> "FC Porto"
 *   "Académica OAF"     -> "Académica"
 *   "Clube X / OAF"     -> "Clube X"
 *   "SAD Clube"         -> "SAD Clube"  (não é sufixo)
 */
export function teamLookupName(value = '') {
  let result = cleanText(value);

  for (let i = 0; i < 3; i++) {
    const next = result
      .replace(/\s*\/\s*OAF\s*$/i, '')
      .replace(/\s*(?:,|[-–—|])?\s*(?:SAD|SDUQ|OAF)\s*$/i, '')
      .trim();

    if (next === result) break;
    result = next;
  }

  return result;
}

export function teamKey(value = '') {
  return compact(teamLookupName(value));
}

export function teamVariants(value = '') {
  const original = cleanText(value);
  const lookup = teamLookupName(original);

  const variants = new Set([
    original,
    lookup,
    lookup.replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim()
  ]);

  return [...variants].filter(Boolean);
}
