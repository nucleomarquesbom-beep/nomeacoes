/*
 * APPLY-PHOTO-FIX.MJS
 *
 * Executar na raiz do projeto:
 *   node apply-photo-fix.mjs
 *
 * O script altera APENAS as partes do app.js relacionadas
 * com fotografias e não mexe no PDF, equipas, escudos,
 * composição geral ou restante lógica da aplicação.
 */

import fs from 'node:fs';

const path = 'src/app.js';

let source = fs.readFileSync(path, 'utf8');

function replaceOnce(label, oldText, newText) {
  const count = source.split(oldText).length - 1;

  if (count !== 1) {
    throw new Error(
      `${label}: esperado 1 ocorrência, encontrado ${count}. ` +
      'O app.js parece ter sido alterado e a aplicação segura foi abortada.'
    );
  }

  source = source.replace(oldText, newText);
}

/* ---------------------------------------------------------
   1. IMPORT DO PROCESSADOR
   --------------------------------------------------------- */

replaceOnce(
  'import do processador',
  "import JSZip from 'jszip';\n",
  `import JSZip from 'jszip';
import {
  processPersonPhoto,
  markPersonPhotoCutout,
  isPersonPhotoCutout
} from './photo-processing.js';
`
);

/* ---------------------------------------------------------
   2. URLs DAS FOTOGRAFIAS
   --------------------------------------------------------- */

replaceOnce(
  'personUrls',
`function personUrls(name) {
  const base = safeFile(name);

  const variants = [...new Set([
    base,
    base.toLowerCase(),
    base.toUpperCase(),
    base.replace(
      /\\b\\w/g,
      c => c.toUpperCase()
    )
  ])];

  const urls = [];

  for (const f of variants) {
    for (const ext of [
      'jpg',
      'jpeg',
      'png',
      'webp'
    ]) {
      urls.push(
        \`/fotografias/\${encodeURIComponent(f)}.\${ext}\`
      );
    }
  }

  return urls;
}

async function personImage(name) {
  const key = 'p:' + compact(name);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  return loadFirst(
    key,
    personUrls(name)
  );
}
`,
`function personUrls(name) {
  const base = safeFile(name);

  const variants = [...new Set([
    base,
    base.toLowerCase(),
    base.toUpperCase(),
    base.replace(
      /\\b\\w/g,
      c => c.toUpperCase()
    )
  ])];

  const urls = [];

  /*
   * Primeiro a versão processada.
   * Só depois usamos as fotografias antigas.
   */
  for (const f of variants) {
    urls.push(
      \`/fotografias/recortadas/\${encodeURIComponent(f)}.webp\`
    );
  }

  for (const f of variants) {
    for (const ext of [
      'jpg',
      'jpeg',
      'png',
      'webp'
    ]) {
      urls.push(
        \`/fotografias/\${encodeURIComponent(f)}.\${ext}\`
      );
    }
  }

  return urls;
}

async function loadPersonPhoto(name) {
  const key = 'p:' + compact(name);

  if (state.assets.has(key)) {
    return state.assets.get(key);
  }

  const urls = personUrls(name);

  /*
   * As primeiras URLs são obrigatoriamente as versões
   * recortadas e transparentes.
   */
  for (let i = 0; i < urls.length; i++) {
    const img = await tryImage(
      urls[i] + '?v=photo-3'
    );

    if (!img) {
      continue;
    }

    if (i < variantsProcessedCount(name)) {
      markPersonPhotoCutout(img);
    }

    state.assets.set(key, img);
    return img;
  }

  return null;
}

function variantsProcessedCount(name) {
  const base = safeFile(name);

  return new Set([
    base,
    base.toLowerCase(),
    base.toUpperCase(),
    base.replace(
      /\\b\\w/g,
      c => c.toUpperCase()
    )
  ]).size;
}

async function personImage(name) {
  return loadPersonPhoto(name);
}
`
);

/* ---------------------------------------------------------
   3. FICHEIRO -> IMAGEM
   --------------------------------------------------------- */

replaceOnce(
  'fileToImage',
`function fileToImage(file) {
  return new Promise(
    (resolve, reject) => {
      const u =
        URL.createObjectURL(file);

      const img =
        new Image();

      img.onload = () => {
        URL.revokeObjectURL(u);
        resolve(img);
      };

      img.onerror =
        reject;

      img.src = u;
    }
  );
}
`,
`function fileToImage(file) {
  return new Promise(
    (resolve, reject) => {
      const u =
        URL.createObjectURL(file);

      const img =
        new Image();

      img.onload = () => {
        URL.revokeObjectURL(u);
        resolve(img);
      };

      img.onerror =
        reject;

      img.src = u;
    }
  );
}

function blobToDataUrl(blob) {
  return new Promise(
    (resolve, reject) => {
      const reader =
        new FileReader();

      reader.onload =
        () => resolve(reader.result);

      reader.onerror =
        reject;

      reader.readAsDataURL(blob);
    }
  );
}

async function saveProcessedPersonPhoto(
  name,
  blob
) {
  const dataUrl =
    await blobToDataUrl(blob);

  try {
    const response =
      await fetch(
        '/api/foto',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            name,
            dataUrl
          })
        }
      );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data?.error ||
        \`HTTP \${response.status}\`
      );
    }

    return data;
  } catch (error) {
    /*
     * A gravação persistente nunca invalida a fotografia
     * da sessão atual.
     */
    console.warn(
      'Não foi possível guardar a fotografia no GitHub:',
      name,
      error
    );

    return null;
  }
}

async function processUploadedPersonPhoto(
  name,
  file
) {
  setStatus(
    \`A remover o fundo da fotografia de \${name}...\`
  );

  const processed =
    await processPersonPhoto(file);

  const img =
    await fileToImage(processed);

  markPersonPhotoCutout(img);

  state.assets.set(
    'p:' + compact(name),
    img
  );

  /*
   * Guardamos em background depois de a fotografia
   * já estar disponível para a sessão.
   */
  const saved =
    await saveProcessedPersonPhoto(
      name,
      processed
    );

  if (saved) {
    setStatus(
      \`Fotografia de \${name} processada e guardada.\`
    );
  } else {
    setStatus(
      \`Fotografia de \${name} processada. ` +
      `Não foi possível guardá-la no GitHub nesta sessão.\`
    );
  }

  return img;
}
`
);

/* ---------------------------------------------------------
   4. UPLOAD MANUAL
   --------------------------------------------------------- */

replaceOnce(
  'upload manual de fotografias',
`        const img =
          await fileToImage(
            input.files[0]
          );

        state.assets.set(
          type === 'foto'
            ? 'p:' + compact(key)
            : type === 'escudo'
              ? 's:' + compact(key)
              : 'logo',
          img
        );
`,
`        if (type === 'foto') {
          try {
            await processUploadedPersonPhoto(
              key,
              input.files[0]
            );
          } catch (error) {
            console.error(
              'Falha ao processar fotografia:',
              key,
              error
            );

            setError(
              \`Não foi possível remover o fundo de \${key}: \` +
              (error?.message || error)
            );

            return;
          }

          continue;
        }

        const img =
          await fileToImage(
            input.files[0]
          );

        state.assets.set(
          type === 'escudo'
            ? 's:' + compact(key)
            : 'logo',
          img
        );
`
);

/* ---------------------------------------------------------
   5. CARTÃO DA FOTOGRAFIA
   --------------------------------------------------------- */

replaceOnce(
  'render da fotografia',
`  const photo =
    state.assets.get(
      'p:' + compact(official.name)
    ) || null;

  if (photo) {
    drawCover(
      ctx,
      photo,
      photoX + frame,
      photoY + frame,
      photoW - frame * 2,
      photoH - frame * 2,
      0
    );
  } else {
`,
`  const photo =
    state.assets.get(
      'p:' + compact(official.name)
    ) || null;

  if (photo && isPersonPhotoCutout(photo)) {
    /*
     * Fundo do quadro.
     */
    ctx.fillStyle =
      '#596b73';

    ctx.fillRect(
      photoX + frame,
      photoY + frame,
      photoW - frame * 2,
      photoH - frame * 2
    );

    /*
     * A pessoa NÃO é recortada pelo quadro.
     *
     * O recorte ultrapassa ligeiramente a moldura:
     * - cabeça pode entrar na margem branca;
     * - tronco pode descer até à margem inferior;
     * - braços não ficam artificialmente cortados.
     */
    drawPersonCutout(
      ctx,
      photo,
      photoX + frame,
      photoY + frame,
      photoW - frame * 2,
      photoH - frame * 2
    );

  } else if (photo) {
    /*
     * Compatibilidade com fotografias antigas.
     */
    drawCover(
      ctx,
      photo,
      photoX + frame,
      photoY + frame,
      photoW - frame * 2,
      photoH - frame * 2,
      0
    );
  } else {
`
);

/* ---------------------------------------------------------
   6. FUNÇÃO DE DESENHO DO RECORTE
   --------------------------------------------------------- */

replaceOnce(
  'função drawPersonCutout',
`function drawCover(
  ctx,
  img,
  x,
  y,
  w,
  h,
  r = 0
) {
`,
`function drawPersonCutout(
  ctx,
  img,
  x,
  y,
  w,
  h
) {
  if (!img) return;

  const iw =
    img.naturalWidth ||
    img.width;

  const ih =
    img.naturalHeight ||
    img.height;

  /*
   * A pessoa ocupa mais área que o quadro.
   * O fator 1.10 cria o pequeno "bleed" pretendido.
   */
  const scale =
    Math.max(
      w / iw,
      h / ih
    ) * 1.10;

  const dw =
    iw * scale;

  const dh =
    ih * scale;

  /*
   * Mantemos a pessoa centrada e ligeiramente elevada.
   * Isto deixa o recorte entrar na margem branca inferior
   * sem destruir o enquadramento da cabeça.
   */
  const drawX =
    x + (w - dw) / 2;

  const drawY =
    y + (h - dh) / 2 - h * 0.025;

  ctx.save();

  ctx.drawImage(
    img,
    drawX,
    drawY,
    dw,
    dh
  );

  ctx.restore();
}

function drawCover(
  ctx,
  img,
  x,
  y,
  w,
  h,
  r = 0
) {
`
);

fs.writeFileSync(path, source);

console.log(
  'Fotografias: alteração aplicada com sucesso em src/app.js.'
);
