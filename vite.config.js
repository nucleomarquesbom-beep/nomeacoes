import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

function pdfWorkerForVercel() {
  return {
    name: "pdf-worker-for-vercel",

    buildStart() {
      const source = require.resolve("pdfjs-dist/build/pdf.worker.mjs");
      const publicDir = path.resolve(process.cwd(), "public");
      const target = path.join(publicDir, "pdf.worker.mjs");

      fs.mkdirSync(publicDir, { recursive: true });
      fs.copyFileSync(source, target);
    },

    resolveId(id) {
      // src/app.js usa:
      // import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url"
      //
      // Em alguns deployments Vercel/Vite esse asset fica inacessível
      // e o PDF.js tenta carregar o fake worker, originando 403.
      //
      // Forçamos o ?url a apontar para um ficheiro estático em /public.
      if (
        id === "pdfjs-dist/build/pdf.worker.mjs?url" ||
        id.endsWith("/pdfjs-dist/build/pdf.worker.mjs?url")
      ) {
        return "\0nomeacoes-pdf-worker-url";
      }

      return null;
    },

    load(id) {
      if (id === "\0nomeacoes-pdf-worker-url") {
        return 'export default "/pdf.worker.mjs";';
      }

      return null;
    }
  };
}

export default defineConfig({
  plugins: [pdfWorkerForVercel()]
});
