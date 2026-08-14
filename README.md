# Gerador de Nomeações — pacote definitivo

## Estrutura
- `src/`: aplicação React/Vite.
- `public/modelos/`: os 7 modelos PowerPoint reais fornecidos para o projeto.
- `public/exemplos/NI 162 RET.pdf`: PDF real de teste.
- `public/fotos/`: pasta para as fotografias.

## Regras implementadas
### Futebol — Liga 3 / Liga BPI
- 1.ª linha: Árbitro
- 2.ª linha: 4.º Árbitro
- Se apenas 1 nome da lista for encontrado no jogo, é escolhido o modelo de 1 elemento.
- Se 2 forem encontrados, é escolhido o modelo Árbitro + 4.º Árbitro.

### Futebol — restantes competições
- 1.ª linha: Árbitro.
- Elementos VAR/AVAR não são tratados como árbitros do modelo.

### Futsal — Liga Placard
- 1.ª linha: Árbitro
- 2.ª: 2.º Árbitro
- 3.ª: 3.º Árbitro
- 4.ª: Cronometrista

### Restante Futsal
- 1.ª: Árbitro
- 2.ª: 2.º Árbitro
- 3.ª: Cronometrista

### Observadores
- `OBSV:` identifica o Observador.
- Um jogo só é incluído se existir pelo menos um nome da lista.

## Regra principal
É gerado um resultado por jogo, não um resultado por árbitro.

## Vercel / GitHub
1. Substituir o conteúdo do repositório pela estrutura deste ZIP.
2. A raiz do repositório deve conter `index.html` e `package.json`.
3. A Vercel deve estar ligada ao repositório GitHub.
4. Build: `npm run build`
5. Output: `dist`

## Nota sobre PowerPoint/JPG
Os PPTX reais estão incluídos e são os modelos de referência do projeto. A leitura/seleção do modelo é feita no navegador. A exportação JPG incluída nesta versão cria uma pré-visualização web com os dados do jogo; a automação de edição/renderização direta dos PPTX requer um motor PowerPoint/LibreOffice fora do ambiente estático da Vercel.
