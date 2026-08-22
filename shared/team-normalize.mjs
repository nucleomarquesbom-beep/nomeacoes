// Normalização central dos nomes das equipas.
//
// Regra da aplicação:
// SAD / SDUQ / OAF / SDQ / B são tratados como sufixos jurídicos/
// administrativos para efeitos de identificação do clube e procura do escudo.
//
// Exemplos:
//   FC FAMALICÃO, SAD B      -> FC FAMALICÃO
//   VITÓRIA SC SAD B         -> VITÓRIA SC
//   ASSOCIAÇÃO NAVAL 1893 SDQ -> ASSOCIAÇÃO NAVAL 1893
//   ACADÉMICA COIMBRA, OAF   -> ACADÉMICA COIMBRA
//
// O nome original nunca é destruído: é mantido em `original`/`displayName`.

const SUFFIX_REGEX =
  /(?:[,;:|\-]?\s*(?:SAD|SDUQ|OAF|SDQ|B)\s*["“”']?\s*)+$/i;

function removeAccents(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanSeparators(value) {
  return String(value ?? "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTeamName(name) {
  if (typeof name !== "string") {
    return {
      original: "",
      cleaned: "",
      displayName: "",
      searchName: "",
      normalizedKey: ""
    };
  }

  const original = cleanSeparators(name);
  let cleaned = original;

  // Remove repetidamente os sufixos do fim.
  // Assim são tratados B, SAD B, SDUQ B, OAF B, SDQ B, etc.
  let previous;

  do {
    previous = cleaned;

    cleaned = cleaned
      .replace(/["'“”]+$/g, "")
      .replace(SUFFIX_REGEX, "")
      .replace(/[,;:|\-]+\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  } while (cleaned !== previous);

  const searchName = removeAccents(cleaned)
    .replace(/\s+/g, " ")
    .trim();

  const normalizedKey = removeAccents(cleaned)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    original,
    cleaned,
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

// Compatibilidade com o shield-service.mjs existente.
// Este export é obrigatório porque o serviço usa teamLookupName().
export function teamLookupName(name) {
  return normalizeTeamName(name).cleaned;
}
