/**
 * Regras de função dos oficiais por modalidade/competição.
 *
 * Mantém a lógica de negócio fora do controlador da interface.
 */

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLiga3BPI(competition = '') {
  const n = normalize(competition);
  return n.includes('liga 3') || n.includes('liga bpi');
}

export function roleForPosition(index, competition = '', modality = 'FUTEBOL') {
  if (modality === 'FUTSAL') {
    if (index === 0) return 'Árbitro';
    if (index === 1) return '2.º Árbitro';
    if (index === 2) return '3.º Árbitro';
    if (index === 3) return 'Cronometrista';
    return 'Oficial';
  }

  if (isLiga3BPI(competition)) {
    if (index === 0) return 'Árbitro';
    if (index === 1) return '4.º Árbitro';
    if (index === 2) return 'Assistente 1';
    if (index === 3) return 'Assistente 2';
    return 'Oficial';
  }

  if (index === 0) return 'Árbitro';
  if (index === 1) return 'Assistente 1';
  if (index === 2) return 'Assistente 2';
  return 'Oficial';
}
