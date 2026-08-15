# Gerador de Nomeações — NAF Marques Bom

Versão limpa baseada no projeto que já estava funcional, com o motor gráfico melhorado.

## Fluxo

PDF FPF → leitura das tabelas → identificação dos nomes da lista → validação de fotografias/escudos → JPG 1080×1920 → ZIP.

## Regras

- Liga 3 Placard = Futebol.
- Liga BPI = Futebol.
- Liga 3/BPI: 1.ª linha de árbitro = Árbitro; 2.ª linha = 4.º Árbitro.
- A posição é determinada pela ordem real das linhas do PDF, mesmo quando o primeiro oficial não está na lista.
- Futsal: 1.º Árbitro, 2.º Árbitro, 3.º Árbitro, Cronometrista.
- OBSV = Observador.
- VAR/AVAR são ignorados.
- Só são criadas publicações para jogos com pelo menos um nome da lista.
- Um JPG não é gerado se faltar fotografia, escudo ou logo.
- Se faltar um ficheiro, a aplicação permite carregá-lo para a sessão atual.
- O logo é usado como ficheiro original, sem redesenho ou alteração.

## Estrutura

```text
public/
  assets/fundo_nomeacao.png
  fotografias/logo.jpeg
  fotografias/[nome do oficial].jpg|jpeg|png|webp
  escudos/[nome da equipa].png|jpg|jpeg|webp
  modelos-ppt/
```

## GitHub

Substituir o conteúdo do repositório pela estrutura deste pacote.

Não misturar com versões antigas de `main.jsx`, `styles.css` ou `app.js` na raiz.

## Vercel

Depois de atualizar o GitHub, fazer um novo deploy do projeto Vercel ligado ao repositório.

## Teste

Usar:

`test/NI 162 RET.pdf`

e:

```text
Nuno Guerra
Gonçalo Rosa
Fernando Lopes
```

No exemplo Liga 3 do PDF, o segundo nome mantém a função de 4.º Árbitro mesmo quando o primeiro nome não pertence à lista.
