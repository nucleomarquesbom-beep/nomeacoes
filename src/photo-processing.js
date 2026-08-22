/*
 * Processamento das fotografias dos oficiais.
 *
 * Usa Transformers.js + Xenova/modnet no browser para:
 * 1. remover o fundo;
 * 2. recortar margens transparentes;
 * 3. limitar a resolução;
 * 4. devolver uma data URL com transparência.
 *
 * O modelo só é descarregado quando esta função é realmente usada.
 */

const MODEL_ID = 'Xenova/modnet';

let segmenterPromise = null;
let queue = Promise.resolve();

function chooseDevice() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
    ? 'webgpu'
    : 'wasm';
}

async function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const device = chooseDevice();

      try {
        return await pipeline('background-removal', MODEL_ID, {
          device,
          dtype: device === 'webgpu' ? 'fp16' : 'q8'
        });
      } catch (error) {
        if (device !== 'webgpu') throw error;

        return pipeline('background-removal', MODEL_ID, {
          device: 'wasm',
          dtype: 'q8'
        });
      }
    })().catch(error => {
      segmenterPromise = null;
      throw error;
    });
  }

  return segmenterPromise;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = error => {
      URL.revokeObjectURL(url);
      reject(error);
    };

    image.src = url;
  });
}

function canvasToBlob(canvas, type = 'image/webp', quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error(`Não foi possível criar ${type}.`));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

async function prepareInput(file, maxSide = 1536) {
  const image = await loadImage(file);
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const width = Math.max(1, Math.round(iw * scale));
  const height = Math.max(1, Math.round(ih * scale));

  if (width === iw && height === ih) return file;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.drawImage(image, 0, 0, width, height);

  return canvasToBlob(canvas, 'image/webp', 0.92);
}

function cropTransparentBounds(canvas, paddingRatio = 0.035) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];

      if (alpha >= 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return canvas;

  const padding = Math.round(
    Math.max(maxX - minX + 1, maxY - minY + 1) * paddingRatio
  );

  const sx = Math.max(0, minX - padding);
  const sy = Math.max(0, minY - padding);
  const ex = Math.min(width - 1, maxX + padding);
  const ey = Math.min(height - 1, maxY + padding);

  const out = document.createElement('canvas');
  out.width = ex - sx + 1;
  out.height = ey - sy + 1;

  out.getContext('2d', { alpha: true }).drawImage(
    canvas,
    sx,
    sy,
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height
  );

  return out;
}

async function resultToBlob(result) {
  const image = result?.[0];

  if (!image) {
    throw new Error('O removedor de fundo não devolveu uma imagem.');
  }

  const cropped = cropTransparentBounds(image.toCanvas());
  const maxSide = 1400;
  const scale = Math.min(
    1,
    maxSide / Math.max(cropped.width, cropped.height)
  );

  let output = cropped;

  if (scale < 1) {
    output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(cropped.width * scale));
    output.height = Math.max(1, Math.round(cropped.height * scale));

    output.getContext('2d', { alpha: true }).drawImage(
      cropped,
      0,
      0,
      output.width,
      output.height
    );
  }

  try {
    return await canvasToBlob(output, 'image/webp', 0.88);
  } catch {
    return canvasToBlob(output, 'image/png');
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * API usada pelo src/app.js.
 *
 * O processamento é serializado para evitar várias inferências
 * simultâneas e picos de memória.
 */
export function removeBackground(file) {
  const job = queue.then(async () => {
    if (!file) throw new Error('Fotografia não fornecida.');

    const prepared = await prepareInput(file);
    const segmenter = await getSegmenter();
    const result = await segmenter(prepared);
    const blob = await resultToBlob(result);
    const dataUrl = await blobToDataUrl(blob);

    return {
      blob,
      dataUrl,
      mimeType: blob.type || 'image/webp'
    };
  });

  queue = job.catch(() => undefined);

  return job;
}
