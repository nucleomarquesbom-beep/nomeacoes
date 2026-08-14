# Gerador de Nomeações — NAF Marques Bom

## Implementação definitiva

O gerador deixou de depender do PowerPoint para criar as publicações.
O JPG é desenhado diretamente num canvas 1080x1920, usando uma imagem-base
com o fundo visual do Núcleo.

### Estrutura

```text
public/
  assets/
    fundo_nomeacao.png
  fotografias/
    logo.png
    Nuno Guerra.jpg
    ...
  escudos/
    equipa-a.png
    equipa-b.png
  modelos-ppt/
```

### Logo

**Obrigatório:** colocar o logo original do Núcleo em:

`public/fotografias/logo.png`

O programa usa o ficheiro original sem redesenhar, recolorir ou modificar o logo.

### Fotografias

O nome do ficheiro deve corresponder ao nome da pessoa:

`Nuno Guerra.jpg`

`Gonçalo Rosa.jpg`

### Escudos

O gerador procura os escudos localmente. Se não encontrar algum, não gera
a publicação. Aparece uma área para carregar o ficheiro em falta para a
sessão atual. Isto evita JPGs sem escudos.

### PDF

O leitor usa PDF.js e agrupa os itens de texto pelas coordenadas do PDF,
preservando a estrutura das linhas da FPF.

Regras:
- Liga 3 Placard = Futebol.
- Liga BPI = Futebol.
- Liga 3/BPI: linha 1 Árbitro; linha 2 4.º Árbitro.
- Futsal: linha 1 Árbitro; linha 2 2.º Árbitro; linha 3 3.º Árbitro; linha 4 Cronometrista.
- OBSV = Observador.
- VAR/AVAR não são incluídos como oficiais da publicação.
- Só são criadas publicações para jogos que contenham pelo menos um nome da lista.

### Deploy

No GitHub, carregar todos os ficheiros deste pacote.
No Vercel, fazer novo deploy do repositório.
