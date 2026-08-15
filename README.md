# Gerador de Nomeações — NAF Marques Bom

Versão única, limpa e sem PowerPoint como motor de geração.

## Fluxo
PDF FPF → leitura das tabelas → identificação dos nomes da lista → validação de fotografias/escudos → JPG 1080×1920 → ZIP.

## Estrutura
- `src/app.js` — aplicação e leitor PDF.
- `src/style.css` — interface.
- `public/assets/fundo_nomeacao.png` — fundo-base visual.
- `public/fotografias/logo.jpeg` — logo original fornecido pelo Núcleo.
- `public/fotografias/` — fotografias dos árbitros/observadores.
- `public/escudos/` — escudos das equipas.
- `public/modelos-ppt/` — reservado para os modelos PPT de referência.
- `test/NI 162 RET.pdf` — PDF de teste.

## Regras
- Liga 3 Placard = Futebol.
- Liga BPI = Futebol.
- Liga 3/BPI: linha 1 Árbitro; linha 2 4.º Árbitro.
- Futsal: linha 1 Árbitro; linha 2 2.º Árbitro; linha 3 3.º Árbitro; linha 4 Cronometrista.
- OBSV = Observador.
- VAR/AVAR são ignorados.
- Só são criadas publicações para jogos que contenham pelo menos um nome da lista.
- Um jogo não é gerado se faltar fotografia ou escudo.

## Logo
O ficheiro original é mantido como `public/fotografias/logo.jpeg`. O código também aceita `logo.png` ou `logo.jpg` caso o ficheiro original seja substituído no GitHub.

## GitHub / Vercel
Substituir o conteúdo do repositório por este pacote. Depois fazer um novo deploy no Vercel.

## Teste inicial
Usar `test/NI 162 RET.pdf` e, por exemplo:

Nuno Guerra
Gonçalo Rosa
Fernando Lopes
