#!/usr/bin/env node

/*
 * CORREÇÃO ROBUSTA — DISTRIBUIÇÃO DAS FOTOGRAFIAS DOS ÁRBITROS
 *
 * Este script altera APENAS:
 *   1) a função drawOfficialCard()
 *   2) o bloco de posicionamento dos oficiais dentro de render()
 *
 * Não altera parser, PDF, equipas, escudos, textos de competição,
 * exportação ou restantes componentes.
 *
 * Uso:
 *   node apply-layout-fix.mjs
 *
 * O script:
 *   - cria src/app.js.before-photo-layout.bak
 *   - verifica os blocos esperados antes de alterar
 *   - aborta se o código atual não corresponder à versão esperada
 *   - não faz alterações parciais
 */

import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('src/app.js');

if (!fs.existsSync(file)) {
  console.error('ERRO: não encontrei src/app.js.');
  process.exit(1);
}

const source = fs.readFileSync(file, 'utf8');

const startMarker = 'function drawOfficialCard(';
const endMarker = '\n\n/* =========================================================\n   NOME DA COMPETIÇÃO';

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  console.error(
    'ERRO: não consegui localizar a função drawOfficialCard().\\n' +
    'Nada foi alterado.'
  );
  process.exit(1);
}

const oldCard = source.slice(start, end);

const oldRenderStart = source.indexOf(
  '  const count =\\n    Math.max(\\n      1,\\n      Math.min(\\n        game.officials.length,\\n        4\\n      )\\n    );'
);

const oldRenderEnd = source.indexOf(
  '\\n\\n\\n  /*\\n   * ======================================================\\n   * RODAPÉ',
  oldRenderStart
);

if (oldRenderStart < 0 || oldRenderEnd < 0) {
  console.error(
    'ERRO: não consegui localizar o bloco de distribuição dos oficiais.\\n' +
    'Nada foi alterado.'
  );
  process.exit(1);
}

const oldRender = source.slice(oldRenderStart, oldRenderEnd);

const newCard = String.raw`function drawOfficialCard(
  ctx,
  official,
  x,
  y,
  w,
  h
) {
  /*
   * ======================================================
   * CARTÃO VERTICAL — FOTOGRAFIA DOMINANTE
   * ======================================================
   *
   * A fotografia NÃO é recortada pelo quadrado.
   *
   * A moldura é desenhada primeiro e a pessoa recortada
   * é desenhada depois, permitindo que cabeça/ombros/corpo
   * ultrapassem ligeiramente a moldura.
   *
   * Isto reproduz o princípio visual do exemplo fornecido.
   */

  const compactness =
    Math.min(
      1,
      Math.max(
        0,
        (w - 260) / 500
      )
    );

  /*
   * Margens internas.
   */
  const outerPad =
    Math.max(
      10,
      Math.min(
        20,
        w * 0.035
      )
    );

  /*
   * A moldura fotográfica ocupa quase toda a largura.
   */
  const frameX =
    x + outerPad;

  const frameW =
    w - outerPad * 2;

  /*
   * Reservamos uma faixa inferior para função + nome.
   */
  const labelH =
    Math.max(
      62,
      Math.min(
        112,
        h * 0.19
      )
    );

  const frameY =
    y + outerPad;

  const frameH =
    Math.max(
      1,
      h - outerPad * 2 - labelH
    );

  /*
   * Moldura branca.
   */
  ctx.save();

  ctx.shadowColor =
    'rgba(0,0,0,.34)';

  ctx.shadowBlur =
    Math.max(
      8,
      Math.min(
        18,
        w * 0.025
      )
    );

  ctx.shadowOffsetY = 5;

  ctx.fillStyle =
    '#f4f1e9';

  ctx.fillRect(
    frameX,
    frameY,
    frameW,
    frameH
  );

  ctx.restore();

  /*
   * Área interior cinzenta.
   */
  const inner =
    Math.max(
      7,
      Math.min(
        14,
        w * 0.025
      )
    );

  const photoX =
    frameX + inner;

  const photoY =
    frameY + inner;

  const photoW =
    frameW - inner * 2;

  const photoH =
    frameH - inner * 2;

  ctx.fillStyle =
    '#596b73';

  ctx.fillRect(
    photoX,
    photoY,
    photoW,
    photoH
  );

  /*
   * Fotografia recortada.
   *
   * IMPORTANTE:
   * Não usamos drawCover() nem clip().
   * Uma fotografia transparente deve poder ultrapassar
   * a moldura.
   */
  const photo =
    state.assets.get(
      'p:' + compact(official.name)
    ) || null;

  if (photo) {
    const iw =
      photo.naturalWidth ||
      photo.width ||
      1;

    const ih =
      photo.naturalHeight ||
      photo.height ||
      1;

    /*
     * Escala baseada na altura.
     *
     * A pessoa deve dominar o cartão, não ficar pequena.
     */
    const targetH =
      photoH *
      (
        0.98 +
        compactness * 0.08
      );

    const scale =
      targetH / ih;

    const dw =
      iw * scale;

    const dh =
      ih * scale;

    /*
     * Centro horizontal.
     *
     * Pequena subida para aproximar a cabeça da zona
     * superior e criar o efeito de "sair da moldura".
     */
    const dx =
      photoX +
      (photoW - dw) / 2;

    const dy =
      photoY +
      photoH -
      dh +
      Math.min(
        12,
        photoH * 0.025
      );

    /*
     * Não fazemos clip.
     * O recorte transparente fica visível sobre a moldura.
     */
    ctx.drawImage(
      photo,
      dx,
      dy,
      dw,
      dh
    );
  }

  /*
   * ======================================================
   * FAIXA INFERIOR
   * ======================================================
   */

  const labelY =
    y +
    h -
    labelH;

  /*
   * Fundo branco sólido para o nome.
   */
  ctx.fillStyle =
    '#f4f1e9';

  ctx.fillRect(
    x,
    labelY,
    w,
    labelH
  );

  /*
   * Linha dourada fina entre fotografia e nome.
   */
  ctx.fillStyle =
    '#e7b63d';

  ctx.fillRect(
    x,
    labelY,
    w,
    Math.max(
      3,
      Math.min(
        5,
        h * 0.009
      )
    )
  );

  /*
   * Conteúdo textual.
   */
  const textPad =
    Math.max(
      10,
      Math.min(
        22,
        w * 0.04
      )
    );

  const textW =
    w -
    textPad * 2;

  ctx.textAlign =
    'center';

  /*
   * Função.
   *
   * Mantemos esta informação para não alterar o conteúdo
   * existente da aplicação.
   */
  const roleSize =
    Math.max(
      15,
      Math.min(
        25,
        labelH * 0.23
      )
    );

  /*
   * Nome.
   *
   * O tamanho adapta-se à largura disponível.
   */
  const nameStart =
    Math.max(
      24,
      Math.min(
        46,
        labelH * 0.42
      )
    );

  const nameSize =
    fit(
      ctx,
      official.name.toUpperCase(),
      textW,
      nameStart,
      17
    );

  ctx.font =
    `700 ${roleSize}px Arial`;

  ctx.fillStyle =
    '#e7b63d';

  /*
   * Em cartões muito baixos (4 árbitros), reduzimos
   * o espaço da função e damos prioridade ao nome.
   */
  if (labelH >= 80) {
    ctx.fillText(
      official.role.toUpperCase(),
      x + w / 2,
      labelY + roleSize + 8
    );
  }

  ctx.font =
    `900 ${nameSize}px Arial`;

  ctx.fillStyle =
    '#111';

  const nameLines =
    wrapLines(
      ctx,
      official.name.toUpperCase(),
      textW,
      labelH >= 80 ? 2 : 1
    );

  const lineHeight =
    nameSize + 3;

  const nameBlockH =
    nameLines.length *
    lineHeight;

  const nameBase =
    labelY +
    labelH -
    Math.max(
      10,
      (labelH - nameBlockH) / 2
    );

  /*
   * Se há função, sobe ligeiramente o nome.
   */
  const finalBase =
    labelH >= 80
      ? Math.min(
          nameBase,
          labelY + labelH - 10
        )
      : labelY +
        labelH / 2 +
        nameSize * 0.35;

  nameLines.forEach(
    (line, i) => {
      ctx.fillText(
        line,
        x + w / 2,
        finalBase +
          i * lineHeight
      );
    }
  );
}
`;

const newRender = String.raw`  /*
   * ======================================================
   * DISTRIBUIÇÃO ADAPTATIVA DOS OFICIAIS
   * ======================================================
   *
   * Nunca dividimos simplesmente a altura total por N.
   *
   * Cada quantidade tem uma composição própria:
   *
   * 1 → cartão grande, centrado
   * 2 → dois cartões horizontais
   * 3 → três cartões horizontais
   * 4 → grelha 2 × 2
   *
   * Isto é deliberadamente independente do parser e dos
   * restantes elementos da publicação.
   */

  const officials =
    game.officials
      .slice(0, 4);

  const count =
    officials.length;

  const hasMatchInfo =
    !!(
      game.date ||
      game.matchDate ||
      game.time ||
      game.matchTime ||
      game.venue ||
      game.stadium
    );

  const top =
    hasMatchInfo
      ? 865
      : 815;

  const bottom =
    1765;

  const areaH =
    bottom -
    top;

  const centerX =
    540;

  if (count === 1) {
    /*
     * ====================================================
     * 1 ÁRBITRO
     * ====================================================
     *
     * O cartão fica grande e centralizado.
     */
    const cardW =
      720;

    const cardH =
      Math.min(
        820,
        areaH - 30
      );

    const cardX =
      centerX -
      cardW / 2;

    const cardY =
      top +
      (areaH - cardH) / 2;

    drawOfficialCard(
      ctx,
      officials[0],
      cardX,
      cardY,
      cardW,
      cardH
    );

  } else if (count === 2) {
    /*
     * ====================================================
     * 2 ÁRBITROS
     * ====================================================
     *
     * Dois cartões grandes lado a lado.
     */
    const gap =
      34;

    const side =
      70;

    const cardW =
      (
        1080 -
        side * 2 -
        gap
      ) / 2;

    const cardH =
      Math.min(
        720,
        areaH - 70
      );

    const cardY =
      top +
      (areaH - cardH) / 2;

    drawOfficialCard(
      ctx,
      officials[0],
      side,
      cardY,
      cardW,
      cardH
    );

    drawOfficialCard(
      ctx,
      officials[1],
      side +
        cardW +
        gap,
      cardY,
      cardW,
      cardH
    );

  } else if (count === 3) {
    /*
     * ====================================================
     * 3 ÁRBITROS
     * ====================================================
     *
     * Três cartões equilibrados.
     */
    const gap =
      24;

    const side =
      80;

    const cardW =
      (
        1080 -
        side * 2 -
        gap * 2
      ) / 3;

    const cardH =
      Math.min(
        690,
        areaH - 80
      );

    const cardY =
      top +
      (areaH - cardH) / 2;

    officials.forEach(
      (official, i) => {
        drawOfficialCard(
          ctx,
          official,
          side +
            i *
              (cardW + gap),
          cardY,
          cardW,
          cardH
        );
      }
    );

  } else if (count >= 4) {
    /*
     * ====================================================
     * 4 ÁRBITROS
     * ====================================================
     *
     * Grelha 2 × 2.
     *
     * É muito mais equilibrada visualmente do que quatro
     * cartões empilhados verticalmente.
     */
    const gapX =
      28;

    const gapY =
      28;

    const side =
      90;

    const cardW =
      (
        1080 -
        side * 2 -
        gapX
      ) / 2;

    const cardH =
      Math.min(
        405,
        (
          areaH -
          40 -
          gapY
        ) / 2
      );

    const gridH =
      cardH * 2 +
      gapY;

    const startY =
      top +
      (areaH - gridH) / 2;

    officials.forEach(
      (official, i) => {
        const col =
          i % 2;

        const row =
          Math.floor(i / 2);

        drawOfficialCard(
          ctx,
          official,
          side +
            col *
              (cardW + gapX),
          startY +
            row *
              (cardH + gapY),
          cardW,
          cardH
        );
      }
    );
  }`;

if (source.slice(start, end) !== oldCard) {
  console.error(
    'ERRO: a função drawOfficialCard() não corresponde à versão esperada.\\n' +
    'Nada foi alterado.'
  );
  process.exit(1);
}

const expectedStart =
  source.slice(oldRenderStart, oldRenderEnd);

if (expectedStart !== oldRender) {
  console.error(
    'ERRO: o bloco de distribuição dos oficiais não corresponde à versão esperada.\\n' +
    'Nada foi alterado.'
  );
  process.exit(1);
}

const backup =
  file + '.before-photo-layout.bak';

if (!fs.existsSync(backup)) {
  fs.writeFileSync(
    backup,
    source,
    'utf8'
  );
}

let result =
  source.slice(0, start) +
  newCard +
  source.slice(end);

const renderStart2 =
  result.indexOf(
    '  const count =\\n    Math.max(\\n      1,\\n      Math.min(\\n        game.officials.length,\\n        4\\n      )\\n    );'
  );

const renderEnd2 =
  result.indexOf(
    '\\n\\n\\n  /*\\n   * ======================================================\\n   * RODAPÉ',
    renderStart2
  );

if (renderStart2 < 0 || renderEnd2 < 0) {
  console.error(
    'ERRO interno: não consegui localizar novamente o bloco render().\\n' +
    'Nada foi gravado.'
  );
  process.exit(1);
}

result =
  result.slice(0, renderStart2) +
  newRender +
  result.slice(renderEnd2);

fs.writeFileSync(
  file,
  result,
  'utf8'
);

console.log('');
console.log('OK — correção aplicada.');
console.log('');
console.log('Alterado apenas:');
console.log('  • drawOfficialCard()');
console.log('  • distribuição dos oficiais dentro de render()');
console.log('');
console.log('Layouts:');
console.log('  • 1 árbitro → cartão grande centrado');
console.log('  • 2 árbitros → 2 cartões lado a lado');
console.log('  • 3 árbitros → 3 cartões equilibrados');
console.log('  • 4 árbitros → grelha 2 × 2');
console.log('');
console.log('Backup criado em:');
console.log(`  ${backup}`);
console.log('');
