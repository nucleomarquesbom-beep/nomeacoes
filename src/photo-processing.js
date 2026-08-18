/*
 * =========================================================
 * PROCESSAMENTO DAS FOTOGRAFIAS DOS ÁRBITROS
 * =========================================================
 *
 * Objetivos:
 * - remover o fundo da fotografia;
 * - manter apenas a pessoa com transparência;
 * - produzir uma imagem leve em WEBP com alpha;
 * - funcionar localmente no browser;
 * - reutilizar o modelo em várias fotografias sem o carregar
 *   novamente;
 * - limitar a resolução de entrada para evitar consumo
 *   excessivo de memória.
 *
 * Modelo:
 *   Xenova/modnet
 *
 * O modelo MODNet é apropriado para portrait matting e é
 * publicado com licença Apache-2.0.
 */

const MODEL_ID = 'Xenova/modnet';

let pipelinePromise = null;
let processingQueue = Promise.resolve();

function chooseDevice() {
  return typeof navigator !== 'undefined' &&
    'gpu' in navigator
    ? 'webgpu'
    : 'wasm';
}

async function getSegmenter() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');

      const device = chooseDevice();

      /*
       * WebGPU:
       *   fp16 reduz memória e acelera bastante em hardware
       *   compatível.
       *
       * WASM:
       *   q8 é mais leve para CPU.
       */
      const dtype =
        device === 'webgpu'
          ? 'fp16'
          : 'q8';

      return pipeline(
        'background-removal',
        MODEL_ID,
        {
          device,
          dtype
        }
      );
    })().catch(error => {
      pipelinePromise = null;
      throw error;
    });
  }

  return pipelinePromise;
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = error => {
      URL.revokeObjectURL(url);
      reject(error);
    };

    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
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
  });
}

function resizeForSegmentation(blob, maxSide = 1536) {
  return new Promise(async (resolve, reject) => {
    try {
      const img = await loadImageFromBlob(blob);

      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;

      const scale = Math.min(
        1,
        maxSide / Math.max(iw, ih)
      );

      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));

      if (w === iw && h === ih) {
        resolve(blob);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d', {
        alpha: true
      });

      ctx.drawImage(img, 0, 0, w, h);

      resolve(
        await canvasToBlob(
          canvas,
          'image/webp',
          0.92
        )
      );
    } catch (error) {
      reject(error);
    }
  });
}

/*
 * O resultado do pipeline já é uma imagem RGBA.
 *
 * Reexportamos para WEBP porque:
 * - mantém transparência;
 * - normalmente é muito mais pequeno que PNG;
 * - é suportado pelos browsers modernos;
 * - evita aproximar-nos do limite de payload das Functions.
 */
async function resultToWebP(result) {
  const image = result?.[0];

  if (!image) {
    throw new Error(
      'O removedor de fundo não devolveu uma imagem.'
    );
  }

  const canvas = image.toCanvas();

  /*
   * Mantemos uma resolução suficiente para Instagram,
   * mas evitamos guardar fotografias gigantes.
   */
  const maxSide = 1400;
  const iw = canvas.width;
  const ih = canvas.height;

  const scale = Math.min(
    1,
    maxSide / Math.max(iw, ih)
  );

  if (scale === 1) {
    return canvasToBlob(
      canvas,
      'image/webp',
      0.92
    );
  }

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(iw * scale));
  out.height = Math.max(1, Math.round(ih * scale));

  const ctx = out.getContext('2d', {
    alpha: true
  });

  ctx.drawImage(
    canvas,
    0,
    0,
    out.width,
    out.height
  );

  return canvasToBlob(
    out,
    'image/webp',
    0.92
  );
}

/*
 * Processa apenas uma fotografia de cada vez.
 *
 * Isto é deliberado: várias inferências simultâneas
 * podem consumir demasiada memória, especialmente em
 * máquinas sem WebGPU.
 */
export function processPersonPhoto(blob) {
  const job = processingQueue.then(async () => {
    const prepared = await resizeForSegmentation(
      blob,
      1536
    );

    const segmenter = await getSegmenter();

    const result = await segmenter(prepared);

    return resultToWebP(result);
  });

  processingQueue = job.catch(() => undefined);

  return job;
}

export async function warmupPersonPhotoModel() {
  await getSegmenter();
}

export function isPersonPhotoCutout(image) {
  return !!image?.__nafPersonCutout;
}

export function markPersonPhotoCutout(image) {
  if (image) {
    image.__nafPersonCutout = true;
  }

  return image;
}
