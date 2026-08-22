# Correção — escudos e filtro SAD/SDUQ/OAF/SDQ/B

Substituir/adicionar estes ficheiros no projeto:

- `src/app.js` — substituir
- `shared/team-normalize.mjs` — substituir
- `api/escudos-local.js` — adicionar

## O que foi corrigido

- O browser deixa de tentar `/escudos/nome.png`, `.jpg`, `.jpeg`, `.webp` para descobrir se existem.
- O frontend carrega o inventário real através de `/api/escudos-local`.
- Só é usado um URL de um ficheiro que realmente existe em `public/escudos`.
- Se o escudo não existir localmente, a aplicação passa ao `/api/escudo` com o nome normalizado.
- Nunca é feita uma chamada `/api/escudo?team=` vazia.
- `SAD`, `SDUQ`, `OAF`, `SDQ` e `B` são removidos como sufixos finais, incluindo combinações como `SAD B` e `SAD "B"`.
- O nome original do PDF é preservado para apresentação; a versão limpa é usada para pesquisa/inventário.

## Exemplos

`FC FAMALICÃO, SAD B` -> `FC FAMALICAO`

`VITÓRIA SC SAD B` -> `VITORIA SC`

`SL BENFICA, SAD "B"` -> `SL BENFICA`

`ASSOCIAÇÃO NAVAL 1893 SDQ` -> `ASSOCIACAO NAVAL 1893`

`ACADÉMICA COIMBRA, OAF` -> `ACADEMICA COIMBRA`
