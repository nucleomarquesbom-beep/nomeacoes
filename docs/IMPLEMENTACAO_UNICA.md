# Implementação única

## 1. GitHub

Substitui o conteúdo do repositório pelo conteúdo deste pacote.

## 2. Logo original

O pacote já inclui a imagem original recebida como `logo_original.jpeg` e uma
versão PNG transparente em `public/fotografias/logo.png`.

O programa usa **apenas `public/fotografias/logo.png`**. Não existe código que
redesenhe o escudo.

Se preferires colocar outra versão oficial, substitui esse ficheiro mantendo
o nome `logo.png`.

## 3. Fotografias

Colocar em `public/fotografias`:

- `Nuno Guerra.jpg`
- `Gonçalo Rosa.jpg`
- `Fernando Lopes.jpg`
- etc.

A correspondência é feita pelo nome, ignorando maiúsculas/minúsculas e acentos.

## 4. Escudos

Colocar em `public/escudos` os escudos corretos.

A aplicação **não escolhe automaticamente uma imagem da Internet**. Isto é
intencional: evita publicar o escudo errado.

Se faltar um escudo ou fotografia, o botão de geração fica bloqueado e a
aplicação permite carregar o ficheiro correto nessa sessão.

Desta forma, nenhuma publicação é gerada sem os dois escudos.

## 5. Fundo

`public/assets/fundo_nomeacao.png` é a imagem-base da identidade visual.

O código coloca os dados por cima desta imagem.

## 6. PDF FPF

O leitor usa as coordenadas dos itens de texto do PDF para reconstruir as
três colunas da FPF:

- Jogo
- Árbitro
- Associação

Regras implementadas:

- Liga 3 Placard = futebol.
- Liga BPI = futebol.
- Liga 3/BPI:
  - linha 1 = Árbitro
  - linha 2 = 4.º Árbitro
- Restante futebol:
  - primeiro = Árbitro
  - seguintes = Assistente 1 / Assistente 2 quando existirem
- Futsal:
  - linha 1 = Árbitro
  - linha 2 = 2.º Árbitro
  - linha 3 = 3.º Árbitro
  - linha 4 = Cronometrista
- `OBSV:` = Observador.
- `VAR:` e `AVAR:` não entram como oficiais da publicação.
- Só são criados JPGs para jogos que tenham pelo menos uma pessoa da lista.

## 7. PowerPoint

O PowerPoint deixa de ser o motor de produção. Os PPT antigos podem ficar
como referência, mas não são necessários para o funcionamento.

## 8. Vercel

O projeto usa Vite e pode ser ligado diretamente ao GitHub no Vercel.

Build:
`npm run build`

O ficheiro `vercel.json` já está incluído.

## 9. Teste

Usa o PDF em `test/NI 162 RET.pdf`.

Para testar o caso discutido anteriormente, coloca na lista:

Nuno Guerra
Gonçalo Rosa
Fernando Lopes

O jogo deve ser reconhecido como:

Lusitano de Évora C. — Atlético CP SAD

Gonçalo Rosa — Árbitro
Nuno Guerra — 4.º Árbitro
Fernando Lopes — Observador
