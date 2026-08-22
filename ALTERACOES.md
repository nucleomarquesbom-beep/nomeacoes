# Revisão coesa — Nomeações

## Objetivo

Esta versão preserva a filosofia da aplicação:

PDF FPF → identificação das nomeações → pessoas → equipas → escudos → composição 1080×1920 → JPG/ZIP.

Não foi alterado o contrato do `index.html` nem os IDs usados pela interface.

## Alterações

### 1. Regra única para equipas

Foi criado `shared/team-normalize.mjs`.

A mesma regra trata:

- `SAD`
- `SDUQ`
- `OAF`

como **sufixos jurídicos**, apenas quando aparecem no fim do nome.

Exemplos:

- `FC Porto, SAD` → `FC Porto`
- `Académica OAF` → `Académica`
- `Clube X / OAF` → `Clube X`
- `SAD Clube` mantém-se `SAD Clube`

O nome original continua intacto na nomeação. A versão normalizada é usada para procurar/casar escudos.

### 2. Escudos

O frontend passou a usar uma chave de equipa normalizada para:

- biblioteca local;
- pesquisa online;
- cache de sessão;
- renderização.

A ordem mantém-se:

1. biblioteca local;
2. identificar faltantes;
3. pesquisa `/api/escudo`;
4. backend FPF → ZeroZero;
5. cache no GitHub.

A pesquisa não é repetida se já houver um escudo para a mesma identidade normalizada.

O `shield-service.mjs` passou a utilizar a mesma regra de `SAD/SDUQ/OAF`, evitando que frontend e backend tenham regras diferentes.

### 3. Pesquisa assíncrona de escudos

A geração aguarda a pesquisa de escudos que já esteja em curso. Isto evita o cenário em que o utilizador clica em "Gerar" enquanto a pesquisa online ainda está a decorrer.

Não é iniciada uma segunda pesquisa.

### 4. Escudos manuais

Os campos de escudo da nomeação manual passaram a funcionar.

Se o utilizador escolher um ficheiro manualmente, esse ficheiro tem prioridade para essa sessão e não é substituído pela pesquisa automática.

### 5. Regras de funções

`roleForPosition()` foi retirado do controlador principal e colocado em `src/core/roles.js`.

A lógica existente de futebol/futsal/Liga 3/Liga BPI foi preservada.

### 6. Normalização

`normalizeText()` e `compact()` passaram a existir num único módulo partilhado, em vez de uma implementação própria no `app.js`.

### 7. Código morto removido

Foram removidas funções que estavam apenas definidas e não eram utilizadas:

- `findListedInText`
- `removeAssociation`
- `looksLikeGameLine`
- `looksLikeOfficialLine`
- `splitGamePrefix`

### 8. Lista de automação

`automation/names.js` foi limpa:

- 59 entradas → 57;
- removido o duplicado `Diogo Neves`;
- removido o duplicado `Ricardo Silva`;
- corrigido o espaço duplicado em `Diogo  Neves`.

### 9. Dependências

`sharp` foi removido de `package.json`.

A pesquisa no código confirmou que não existe utilização de `sharp`.

### 10. Ficheiros comprovadamente inúteis

Removidos:

- `public/fotografias/Diogo Neves_2.jpg` — cópia exacta;
- `public/fotografias/Ricardo Silva_2.jpg` — cópia exacta;
- `public/modelos-ppt/01_Futebol_So_Arbitro.ppt` — ficheiro de 1 byte;
- `public/escudos/.gikeep` — ficheiro sem função;
- `.gitkeep` redundantes em pastas que já contêm ficheiros.

## Ficheiros mantidos deliberadamente

Não foram apagados:

- `public/clubes.json` — é gerado/utilizado pelo processo de atualização da base de clubes;
- `scripts/build-club-database.mjs` — usado pelo workflow da base de clubes;
- `api/escudo-image.js` — referenciado pelo `vercel.json`;
- `automation/last-processed.json` — usado pela automação;
- `api/shield-service.mjs` — núcleo da resolução FPF → ZeroZero.

## Verificações realizadas

- `node --check src/app.js` — OK
- `node --check api/shield-service.mjs` — OK
- teste directo da normalização SAD/SDUQ/OAF — OK
- verificação de duplicados em `automation/names.js` — OK
- verificação dos IDs HTML usados pelo `app.js` — OK
- confirmação das referências aos ficheiros considerados suspeitos — realizada

## Build

O `npm install` foi iniciado para validação do build, mas o ambiente de execução atingiu o limite de tempo antes de concluir a instalação. Por isso, não é afirmado que `npm run build` foi executado com sucesso neste ambiente.

O código foi, contudo, validado sintacticamente com Node.

## Nota

Esta revisão é deliberadamente conservadora: não reescreve o parser PDF nem a automação Playwright de raiz. Essas áreas podem ser refatoradas numa segunda fase depois de existir uma bateria de PDFs reais para regressão.
