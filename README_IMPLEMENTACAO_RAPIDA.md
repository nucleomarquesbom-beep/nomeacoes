# Implementação final — geração rápida

## Ficheiros principais
- `src/app.js` — leitor do PDF + preparação de assets + geração rápida.
- `api/escudo.js` — pesquisa automática dos escudos via Wikimedia Commons, com cache e timeout.
- `vercel.json` — mantém `/api/escudo` fora do fallback da SPA.

## Alterações importantes
1. A geração dos JPG **não faz qualquer pesquisa externa**.
2. Os escudos são procurados uma vez, em paralelo, depois de o PDF ser lido.
3. Cada pesquisa externa tem timeout de 4 segundos.
4. A preparação global não bloqueia a aplicação por mais de 12 segundos.
5. As fotografias são carregadas em paralelo.
6. O ZIP usa `STORE`, porque JPG já está comprimido; isto reduz bastante o tempo de criação do ZIP.
7. Os JPG são codificados em lotes de 4 para evitar picos de memória.
8. Se a geração ultrapassar 30 segundos, a aplicação mostra explicitamente se a demora está na codificação dos JPG/ZIP.
9. A pesquisa do PDF e a regra Liga 3/Liga BPI ficam preservadas.

## GitHub / Vercel
Substitui o projeto pelo conteúdo deste ZIP. Depois faz commit e espera pelo deploy do Vercel.
