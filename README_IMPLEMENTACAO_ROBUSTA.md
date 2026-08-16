# Gerador de Nomeações — versão consolidada

Esta versão foi consolidada para evitar regressões entre as versões anteriores.

## O que fica preservado

- Leitura do PDF FPF com PDF.js.
- Separação semântica das colunas `Jogo | Árbitro | Associação` usando os cabeçalhos reais do PDF.
- Fallback de procura do árbitro na linha, sem usar o nome do árbitro para cortar o nome das equipas quando as colunas estão disponíveis.
- Lista de nomes fornecida pelo utilizador: a coluna/lista é apenas lida.
- Liga 3 / Liga BPI: posição 0 = Árbitro; posição 1 = 4.º Árbitro.
- Futsal: posição 0 = Árbitro; posição 1 = 2.º; posição 2 = 3.º; posição 3 = Cronometrista.
- Fotografias dos árbitros: procura local rápida e carregamento manual quando faltam.
- Fotografias carregadas manualmente são guardadas no GitHub através de `/api/foto`.
- Escudos: pesquisa automática em paralelo através de `/api/escudo`.
- Escudo não encontrado: permite carregamento manual e guarda-o no GitHub.
- `SAD`, `SDUQ` e `OAF` só são removidos no FINAL do nome para pesquisa do escudo.
- A geração dos JPG nunca faz pesquisas externas.
- Pesquisa dos escudos tem limite de tempo para não tornar a geração lenta.
- Fundo e logo são carregados dos ficheiros existentes no projeto, com fallback.

## Variáveis Vercel

```text
GITHUB_TOKEN
GITHUB_REPO=nucleomarquesbom-beep/nomeacoes
GITHUB_BRANCH=main
```

`GITHUB_TOKEN` precisa de `Contents: Read and write` no repositório.

## Ficheiros importantes

```text
src/app.js       aplicação, PDF, parsing, assets e geração
api/escudo.js    pesquisa + gravação de escudos
api/foto.js      gravação de fotografias no GitHub
public/escudos/  biblioteca persistente de escudos
public/fotografias/ biblioteca persistente de fotografias
public/modelos-ppt/ modelos mantidos no projeto
```

## Fluxo de escudos

1. Tenta biblioteca local.
2. Se não existir, pesquisa online em paralelo.
3. Se encontrar, usa imediatamente e guarda em cache da sessão.
4. Se não encontrar, mostra upload manual.
5. O upload manual é usado imediatamente e enviado ao GitHub.
6. Nas próximas execuções, o ficheiro passa a estar na biblioteca local.

## Fluxo de fotografias

1. Procura por nome na biblioteca local.
2. Se faltar, mostra upload manual.
3. A fotografia é usada imediatamente.
4. Tenta guardá-la no GitHub.
5. Mesmo que o GitHub esteja temporariamente indisponível, a imagem continua válida para a geração daquela sessão.

## Importante

Não substituir `api/escudo.js` ou `api/foto.js` por versões antigas depois de instalar este pacote.

Após carregar o pacote no GitHub, aguardar o deployment do Vercel ou fazer Redeploy.
