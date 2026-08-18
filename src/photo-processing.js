/*
 * =========================================================
 * PROCESSAMENTO DAS FOTOGRAFIAS DOS ÁRBITROS
 * =========================================================
 *
 * Tratamento exclusivo das fotografias dos oficiais:
 * - remoção automática do fundo;
 * - transparência real;
 * - recorte das margens transparentes;
 * - normalização da resolução;
 * - saída WEBP com alpha;
 * - processamento sequencial para não esgotar a memória;
 * - cache do modelo no browser.
 *
 * Modelo: Xenova/modnet
 * Licença do modelo: Apache-2.0
 */

const MODEL_ID = 'Xenova/modnet';

let pipelinePromise = null;
let processingQueue = Promise.resolve();

function chooseDevice() {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator
  )
    ? 'webgpu'
    : 'wasm';
}

function pipelineOptions(device, onProgress) {
  return {
    device,
    dtype:
      device === 'webgpu'
        ? 'fp16'
        : 'q8',
    ...(onProgress
      ? {
          progress_callback: onProgress
        }
      : {})
  };
}

async function createSegmenter(onProgress) {
  const { pipeline } =
    await import('@huggingface/transformers');

  const device =
    chooseDevice();

  try {
    return await pipeline(
      'background-removal',
      MODEL_ID,
      pipelineOptions(
        device,
        onProgress
      )
    );
  } catch (gpuError) {
    /*
     * Se WebGPU existir mas o driver/modelo não for
     * compatível, fazemos fallback automático para WASM.
     */
    if (device !== 'webgpu') {
      throw gpuError;
    }

    console.warn(
      'WebGPU indisponível para remoção de fundo; ' +
      'a usar WASM.',
      gpuError
    );

    return pipeline(
      'background-removal',
      MODEL_ID,
      pipelineOptions(
        'wasm',
        onProgress
      )
    );
  }
}

async function getSegmenter(onProgress) {
  if (!pipelinePromise) {
    pipelinePromise =
      createSegmenter(
        onProgress
      ).catch(error => {
        pipelinePromise = null;
        throw error;
      });
  }

  return pipelinePromise;
}

function loadImageFromBlob(blob) {
  return new Promise(
    (resolve, reject) => {
      const url =
        URL.createObjectURL(blob);

      const img =
        new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };

      img.onerror =
        error => {
          URL.revokeObjectURL(url);
          reject(error);
        };

      img.src = url;
    }
  );
}

function canvasToBlob(
  canvas,
  type,
  quality
) {
  return new Promise(
    (resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (!blob) {
            reject(
              new Error(
                `O navegador não conseguiu criar ${type}.`
              )
            );
            return;
          }

          resolve(blob);
        },
        type,
        quality
      );
    }
  );
}

async function canvasToCompressedBlob(canvas) {
  /*
   * WEBP com alpha é a primeira escolha.
   */
  try {
    const webp =
      await canvasToBlob(
        canvas,
        'image/webp',
        0.88
      );

    /*
     * O limite de payload das Vercel Functions é 4.5 MB.
     * Mantemos margem confortável porque a imagem ainda
     * será convertida para Base64.
     */
    if (webp.size <= 3000000) {
      return webp;
    }

    const smaller =
      await canvasToBlob(
        canvas,
        'image/webp',
        0.74
      );

    if (smaller.size <= 3000000) {
      return smaller;
    }

    return smaller;
  } catch {
    /*
     * PNG é o fallback universal para transparência.
     */
    return canvasToBlob(
      canvas,
      'image/png'
    );
  }
}

async function resizeForSegmentation(
  blob,
  maxSide = 1536
) {
  const img =
    await loadImageFromBlob(blob);

  const iw =
    img.naturalWidth ||
    img.width;

  const ih =
    img.naturalHeight ||
    img.height;

  const scale =
    Math.min(
      1,
      maxSide /
        Math.max(iw, ih)
    );

  const w =
    Math.max(
      1,
      Math.round(iw * scale)
    );

  const h =
    Math.max(
      1,
      Math.round(ih * scale)
    );

  if (
    w === iw &&
    h === ih
  ) {
    return blob;
  }

  const canvas =
    document.createElement(
      'canvas'
    );

  canvas.width = w;
  canvas.height = h;

  const ctx =
    canvas.getContext(
      '2d',
      { alpha: true }
    );

  ctx.drawImage(
    img,
    0,
    0,
    w,
    h
  );

  return canvasToBlob(
    canvas,
    'image/webp',
    0.92
  );
}

/*
 * Remove margens totalmente transparentes.
 *
 * Isto é importante: muitas fotografias têm muito espaço
 * vazio à volta da pessoa. Se mantivermos esse espaço,
 * a pessoa ficará pequena dentro do quadrado.
 */
function cropTransparentBounds(
  canvas,
  paddingRatio = 0.035
) {
  const ctx =
    canvas.getContext(
      '2d',
      { willReadFrequently: true }
    );

  const {
    width,
    height
  } = canvas;

  const pixels =
    ctx.getImageData(
      0,
      0,
      width,
      height
    ).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  /*
   * Alpha >= 16 ignora apenas ruído quase invisível
   * nas extremidades do recorte.
   */
  for (
    let y = 0;
    y < height;
    y++
  ) {
    for (
      let x = 0;
      x < width;
      x++
    ) {
      const alpha =
        pixels[
          (y * width + x) * 4 + 3
        ];

      if (alpha >= 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  /*
   * Se não existir foreground, devolvemos a imagem
   * original para que o fluxo principal possa tratar
   * o erro sem destruir a fotografia.
   */
  if (
    maxX < minX ||
    maxY < minY
  ) {
    return canvas;
  }

  const subjectW =
    maxX - minX + 1;

  const subjectH =
    maxY - minY + 1;

  const padding =
    Math.round(
      Math.max(
        subjectW,
        subjectH
      ) * paddingRatio
    );

  const sx =
    Math.max(
      0,
      minX - padding
    );

  const sy =
    Math.max(
      0,
      minY - padding
    );

  const ex =
    Math.min(
      width - 1,
      maxX + padding
    );

  const ey =
    Math.min(
      height - 1,
      maxY + padding
    );

  const outW =
    ex - sx + 1;

  const outH =
    ey - sy + 1;

  const out =
    document.createElement(
      'canvas'
    );

  out.width = outW;
  out.height = outH;

  const outCtx =
    out.getContext(
      '2d',
      { alpha: true }
    );

  outCtx.drawImage(
    canvas,
    sx,
    sy,
    outW,
    outH,
    0,
    0,
    outW,
    outH
  );

  return out;
}

async function resultToWebP(result) {
  const image =
    result?.[0];

  if (!image) {
    throw new Error(
      'O removedor de fundo não devolveu uma imagem.'
    );
  }

  const rawCanvas =
    image.toCanvas();

  const cropped =
    cropTransparentBounds(
      rawCanvas
    );

  /*
   * Limite final de resolução.
   */
  const maxSide = 1400;

  const scale =
    Math.min(
      1,
      maxSide /
        Math.max(
          cropped.width,
          cropped.height
        )
    );

  let finalCanvas =
    cropped;

  if (scale < 1) {
    finalCanvas =
      document.createElement(
        'canvas'
      );

    finalCanvas.width =
      Math.max(
        1,
        Math.round(
          cropped.width * scale
        )
      );

    finalCanvas.height =
      Math.max(
        1,
        Math.round(
          cropped.height * scale
        )
      );

    const ctx =
      finalCanvas.getContext(
        '2d',
        { alpha: true }
      );

    ctx.drawImage(
      cropped,
      0,
      0,
      finalCanvas.width,
      finalCanvas.height
    );
  }

  return canvasToCompressedBlob(
    finalCanvas
  );
}

/*
 * As inferências são serializadas.
 *
 * O modelo pode ser pesado e executar várias imagens
 * simultaneamente é uma forma fácil de rebentar a memória.
 */
export function processPersonPhoto(
  blob,
  {
    onProgress
  } = {}
) {
  const job =
    processingQueue.then(
      async () => {
        const prepared =
          await resizeForSegmentation(
            blob,
            1536
          );

        const segmenter =
          await getSegmenter(
            onProgress
          );

        const result =
          await segmenter(
            prepared
          );

        return resultToWebP(
          result
        );
      }
    );

  processingQueue =
    job.catch(
      () => undefined
    );

  return job;
}

export function markPersonPhotoCutout(
  image
) {
  if (image) {
    image.__nafPersonCutout = true;
  }

  return image;
}

export function isPersonPhotoCutout(
  image
) {
  return !!image?.__nafPersonCutout;
}
