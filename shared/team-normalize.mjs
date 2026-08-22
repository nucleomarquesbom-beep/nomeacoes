// Normalização central dos nomes das equipas para pesquisa de escudos.
//
// O PDF pode trazer a designação jurídica/administrativa da sociedade.
// Para procurar o escudo, SAD / SDUQ / OAF / SDQ / B são tratados da mesma
// forma e removidos apenas quando aparecem no final da designação.

const SUFFIX_REGEX = /(?:[,;:\-]?\s*(?:SAD|SDUQ|OAF|SDQ|B)\s*["“”']?)+\s*$/i;

function removeAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cleanSeparators(value) {
  return String(value ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normaliza uma equipa sem destruir o nome original.
 *
 * Ex.:
 *   FC FAMALICÃO, SAD B      -> FC FAMALICAO
 *   VITÓRIA SC SAD B         -> VITORIA SC
 *   SL BENFICA, SAD "B"      -> SL BENFICA
 *   ACADÉMICA COIMBRA/OAF    -> ACADÉMICA COIMBRA/OAF (OAF não é final aqui)
 *   ACADÉMICA COIMBRA, OAF   -> ACADÉMICA COIMBRA
 */
export function normalizeTeamName(name) {
  if (typeof name !== 'string') {
    return {
      original: '',
      cleaned: '',
      displayName: '',
      searchName: '',
      normalizedKey: ''
    };
  }

  const original = cleanSeparators(name);
  let cleaned = original;

  // Remove repetidamente os sufixos do fim. Isto trata também: SAD B,
  // SAD "B", SDUQ B, OAF B, etc.
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned
      .replace(/[\"'“”]+$/g, '')
      .replace(SUFFIX_REGEX, '')
      .replace(/[,;:|\-]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } while (cleaned !== previous);

  const searchName = removeAccents(cleaned)
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedKey = removeAccents(cleaned)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    original,
    cleaned,
    // A apresentação continua a poder usar o nome original do PDF.
    displayName: original,
    searchName,
    normalizedKey
  };
}

export function getTeamDisplayName(name) {
  return normalizeTeamName(name).displayName;
}

export function getTeamSearchName(name) {
  return normalizeTeamName(name).searchName;
}

export function getTeamKey(name) {
  return normalizeTeamName(name).normalizedKey;
}
