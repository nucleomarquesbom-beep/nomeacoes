
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import JSZip from "jszip";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const SAMPLE = "/exemplos/NI%20162%20RET.pdf";

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isCompetition(text) {
  const n = normalize(text);
  if (!n || n === "NOTA INFORMATIVA" || n === "JOGO ARBITRO ASSOCIACAO") return false;
  if (/^(N\.|DATA:|PARA OS DEVIDOS EFEITOS)/.test(n)) return false;
  return /LIGA|CAMPEONATO|TAÇA|FUTSAL|PROVAS OFICIAIS|TORNEIO/.test(n) && !/ A\.F\./.test(n);
}

function isFutsal(comp) {
  return normalize(comp).includes("FUTSAL");
}
function isPlacardFutsal(comp) {
  const n = normalize(comp);
  return n.includes("LIGA PLACARD") && n.includes("FUTSAL");
}
function isLiga3BPI(comp) {
  const n = normalize(comp);
  return n.includes("LIGA 3") || n.includes("LIGA BPI");
}

function roleFor(comp, refereeIndex) {
  if (isFutsal(comp)) {
    if (isPlacardFutsal(comp)) {
      return ["Árbitro", "2.º Árbitro", "3.º Árbitro", "Cronometrista"][refereeIndex] || "Oficial";
    }
    return ["Árbitro", "2.º Árbitro", "Cronometrista"][refereeIndex] || "Oficial";
  }
  if (isLiga3BPI(comp)) {
    return refereeIndex === 0 ? "Árbitro" : refereeIndex === 1 ? "4.º Árbitro" : "Oficial";
  }
  return refereeIndex === 0 ? "Árbitro" : "Oficial";
}

function modelFor(comp, matched) {
  const refs = matched.filter(x => x.type === "referee");
  const observers = matched.filter(x => x.type === "observer");

  if (!refs.length && observers.length) {
    return { code:"07_So_Observador", label:"Observador" };
  }

  if (isFutsal(comp)) {
    if (isPlacardFutsal(comp) && refs.length >= 4)
      return { code:"05_Futsal_3_Arbitros", label:"Futsal — 3 árbitros + cronometrista" };
    if (!isPlacardFutsal(comp) && refs.length >= 3)
      return { code:"05_Futsal_3_Arbitros", label:"Futsal — 3 árbitros + cronometrista" };
    return { code:"06_Futsal_Sem_3", label:"Futsal — 2 árbitros + cronometrista" };
  }

  if (isLiga3BPI(comp) && refs.length >= 2)
    return { code:"02_Futebol_Arbitro_4", label:"Futebol — Árbitro + 4.º Árbitro" };

  return { code:"01_Futebol_So_Arbitro", label:"Futebol — 1 árbitro" };
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const rows = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    const items = content.items.map(item => ({
      text: item.str || "",
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0
    })).filter(x => x.text.trim());

    items.sort((a,b) => b.y-a.y || a.x-b.x);

    const pageRows = [];
    for (const item of items) {
      let row = pageRows.find(r => Math.abs(r.y-item.y) < 2.8);
      if (!row) {
        row = { y:item.y, items:[] };
        pageRows.push(row);
      }
      row.items.push(item);
    }

    pageRows.sort((a,b) => b.y-a.y);

    for (const row of pageRows) {
      row.items.sort((a,b) => a.x-b.x);

      // FPF layout: match in the left column, official in the middle,
      // association in the right column.
      const left = row.items.filter(x => x.x < 250).map(x => x.text).join(" ").replace(/\s+/g," ").trim();
      const middle = row.items.filter(x => x.x >= 250 && x.x < 450).map(x => x.text).join(" ").replace(/\s+/g," ").trim();
      const right = row.items.filter(x => x.x >= 450).map(x => x.text).join(" ").replace(/\s+/g," ").trim();
      const full = row.items.map(x => x.text).join(" ").replace(/\s+/g," ").trim();

      rows.push({page:pageNo,left,middle,right,full});
    }
  }

  return { pages:pdf.numPages, rows };
}

function parseGames(rows, wantedNames) {
  const wanted = wantedNames.filter(Boolean).map(raw => ({raw, n:normalize(raw)}));
  const games = [];
  let competition = "";
  let current = null;

  const findWanted = (name) => {
    const n = normalize(name);
    return wanted.find(w => n === w.n || n.includes(w.n) || w.n.includes(n));
  };

  const addOfficial = (game, name, type) => {
    const n = clean(name);
    if (!n) return;
    if (/^(VAR|AVAR)\s*:/i.test(n)) return;
    game.officials.push({name:n,type});
  };

  const close = () => {
    if (!current) return;

    let refIndex = 0;
    const matched = [];

    for (const official of current.officials) {
      const found = findWanted(official.name);

      if (official.type === "observer") {
        if (found) matched.push({
          ...official,
          requestedName: found.raw,
          role: "Observador",
          sourceIndex: -1
        });
      } else if (official.type === "referee") {
        const role = roleFor(current.competition, refIndex);
        if (found) matched.push({
          ...official,
          requestedName: found.raw,
          role,
          sourceIndex: refIndex
        });
        refIndex++;
      }
    }

    if (matched.length) {
      games.push({
        ...current,
        matched,
        model:modelFor(current.competition, matched)
      });
    }

    current = null;
  };

  for (const row of rows) {
    const full = clean(row.full);
    const left = clean(row.left);
    const middle = clean(row.middle);

    if (isCompetition(full)) {
      close();
      competition = full;
      continue;
    }

    if (/^JOGO\s+ARBITRO\s+ASSOCIACAO$/i.test(normalize(full))) {
      continue;
    }

    // The first referee is on the SAME PDF row as the match.
    if (left.includes(" - ")) {
      close();

      const match = left.split(/\s+-\s+/, 2);
      if (match.length === 2) {
        current = {
          home:clean(match[0]),
          away:clean(match[1]),
          competition,
          officials:[]
        };

        if (middle) {
          if (/^OBSV\s*:/i.test(middle)) {
            addOfficial(current, middle.replace(/^OBSV\s*:\s*/i,""), "observer");
          } else if (!/^(VAR|AVAR)\s*:/i.test(middle)) {
            addOfficial(current, middle, "referee");
          }
        }
      }
      continue;
    }

    if (!current || !middle) continue;

    if (/^OBSV\s*:/i.test(middle)) {
      addOfficial(current, middle.replace(/^OBSV\s*:\s*/i,""), "observer");
    } else if (/^(VAR|AVAR)\s*:/i.test(middle)) {
      // Explicitly ignored.
    } else if (row.right && /A\.F\./i.test(row.right)) {
      addOfficial(current, middle, "referee");
    }
  }

  close();
  return games;
}

function wrapText(ctx, text, maxWidth, font) {
  ctx.font = font;
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function getImageForName(name, uploaded) {
  const n = normalize(name);

  for (const [key, url] of Object.entries(uploaded)) {
    if (normalize(key.replace(/\.[^.]+$/,"")) === n) return loadImage(url);
  }

  const variants = [
    `/fotos/${encodeURIComponent(name)}.jpg`,
    `/fotos/${encodeURIComponent(name)}.jpeg`,
    `/fotos/${encodeURIComponent(name)}.png`,
    `/fotos/${encodeURIComponent(name)}.webp`
  ];

  for (const url of variants) {
    try {
      const img = await loadImage(url);
      return img;
    } catch (_) {}
  }

  return null;
}

function loadImage(src) {
  return new Promise((resolve,reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawCoverCircle(ctx, img, cx, cy, radius) {
  if (!img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx,cy,radius,0,Math.PI*2);
    ctx.fillStyle="#191d21";
    ctx.fill();
    ctx.strokeStyle="#e4b400";
    ctx.lineWidth=2;
    ctx.stroke();
    ctx.fillStyle="#777";
    ctx.font="16px Arial";
    ctx.textAlign="center";
    ctx.fillText("FOTOGRAFIA",cx,cy+5);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx,cy,radius,0,Math.PI*2);
  ctx.clip();

  const scale = Math.max((radius*2)/img.width,(radius*2)/img.height);
  const w = img.width*scale, h = img.height*scale;
  ctx.drawImage(img,cx-w/2,cy-h/2,w,h);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx,cy,radius,0,Math.PI*2);
  ctx.strokeStyle="#e4b400";
  ctx.lineWidth=2;
  ctx.stroke();
  ctx.restore();
}

async function renderPoster(game, uploaded) {
  const W=900,H=1600;
  const canvas=document.createElement("canvas");
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="#070a0d"; ctx.fillRect(0,0,W,H);

  ctx.textAlign="center";
  ctx.fillStyle="#e8e8e8";
  ctx.font="bold 13px Arial";
  ctx.fillText("NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA",W/2,55);

  ctx.font="bold 50px Arial";
  ctx.fillStyle="#fff";
  ctx.fillText("NOMEAÇÃO",W/2,125);

  ctx.fillStyle="#e4b400";
  ctx.font="bold 24px Arial";
  const date = "01 DE MAIO";
  ctx.fillText(date,W/2,175);

  // Competition
  ctx.strokeStyle="#e4b400"; ctx.lineWidth=2;
  roundRect(ctx,55,205,790,72,12);
  ctx.fillStyle="#eee";
  ctx.font="bold 17px Arial";
  drawCenteredWrapped(ctx,game.competition,450,248,730,17,22);

  // Match
  ctx.strokeStyle="#59616a";
  roundRect(ctx,55,300,790,78,12);
  ctx.fillStyle="#eee";
  ctx.font="bold 19px Arial";
  drawCenteredWrapped(ctx,`${game.home}  VS  ${game.away}`,450,343,730,19,24);

  const entries = game.matched.filter(x=>x.type==="referee");
  const observers = game.matched.filter(x=>x.type==="observer");
  const people = entries.length ? entries : observers;

  const cards = people.length;
  const cardH = cards === 1 ? 520 : cards === 2 ? 390 : 260;
  const gap = 18;
  let y = cards === 1 ? 425 : 415;

  for (let i=0;i<people.length;i++) {
    const p=people[i];
    const h=cardH;
    ctx.strokeStyle="#e4b400";
    ctx.lineWidth=2;
    roundRect(ctx,45,y,810,h,28);

    const photoR = Math.min(145, h*0.37);
    const cx=220, cy=y+h/2;
    const img=await getImageForName(p.requestedName,uploaded);
    drawCoverCircle(ctx,img,cx,cy,photoR);

    ctx.textAlign="left";
    ctx.fillStyle="#e4b400";
    ctx.font="bold 16px Arial";
    ctx.fillText(p.role.toUpperCase(),405,y+75);

    ctx.fillStyle="#fff";
    ctx.font="bold 27px Arial";
    const nameLines=wrapText(ctx,p.requestedName,390,"bold 27px Arial");
    nameLines.slice(0,2).forEach((line,j)=>ctx.fillText(line,405,y+120+j*35));

    ctx.fillStyle="#aaa";
    ctx.font="14px Arial";
    ctx.fillText("NÚCLEO DE ÁRBITROS MARQUES BOM",405,y+h-55);

    y += h + gap;
  }

  ctx.textAlign="center";
  ctx.fillStyle="#e4b400";
  ctx.font="bold 20px Arial";
  ctx.fillText("TRABALHO, COMPETÊNCIA E DEDICAÇÃO",W/2,1515);

  return canvas;
}

function roundRect(ctx,x,y,w,h,r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
  ctx.stroke();
}

function drawCenteredWrapped(ctx,text,cx,centerY,maxWidth,fontSize,lineHeight) {
  ctx.font=`bold ${fontSize}px Arial`;
  const lines=wrapText(ctx,text,maxWidth,`bold ${fontSize}px Arial`).slice(0,3);
  const start=centerY-((lines.length-1)*lineHeight)/2;
  lines.forEach((line,i)=>ctx.fillText(line,cx,start+i*lineHeight));
}

async function canvasBlob(canvas) {
  return new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.95));
}

async function saveJpg(game,index,uploaded) {
  const canvas=await renderPoster(game,uploaded);
  const blob=await canvasBlob(canvas);
  const a=document.createElement("a");
  const safe=(s)=>String(s).replace(/[\\/:*?"<>|]/g,"_");
  a.download=`Nomeacao_${String(index+1).padStart(2,"0")}_${safe(game.home)}_vs_${safe(game.away)}.jpg`;
  a.href=URL.createObjectURL(blob);
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}

async function makeZip(games,uploaded) {
  const zip=new JSZip();
  for (let i=0;i<games.length;i++) {
    const canvas=await renderPoster(games[i],uploaded);
    const blob=await canvasBlob(canvas);
    const ab=await blob.arrayBuffer();
    const safe=(s)=>String(s).replace(/[\\/:*?"<>|]/g,"_");
    zip.file(`Nomeacao_${String(i+1).padStart(2,"0")}_${safe(games[i].home)}_vs_${safe(games[i].away)}.jpg`,ab);
  }
  const out=await zip.generateAsync({type:"blob"});
  const a=document.createElement("a");
  a.download="Nomeacoes_Marques_Bom.zip";
  a.href=URL.createObjectURL(out);
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}

function App() {
  const [tab,setTab]=useState("pdf");
  const [photoMap,setPhotoMap]=useState({});

  const loadPhotos=(files)=>{
    const next={...photoMap};
    [...files].forEach(file=>{
      next[file.name]=URL.createObjectURL(file);
    });
    setPhotoMap(next);
  };

  return <div className="app">
    <header>
      <div className="pill">NAF MARQUES BOM</div>
      <h1>Gerador de Nomeações</h1>
      <p>PDF FPF → jogos → funções → fotografia → JPG</p>
    </header>

    <nav>
      <button className={tab==="pdf"?"active":""} onClick={()=>setTab("pdf")}>📄 PDF FPF</button>
      <button className={tab==="manual"?"active":""} onClick={()=>setTab("manual")}>✏️ Nomeação manual</button>
    </nav>

    {tab==="pdf"
      ? <PdfPage uploaded={photoMap} onPhotos={loadPhotos}/>
      : <ManualPage uploaded={photoMap} />}
  </div>;
}

function PdfPage({uploaded,onPhotos}) {
  const [file,setFile]=useState(null);
  const [names,setNames]=useState("Nuno Guerra\nGonçalo Rosa");
  const [games,setGames]=useState([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [pages,setPages]=useState(0);

  const analyse=async()=>{
    setError(""); setGames([]); setBusy(true);
    try {
      if(!file) throw new Error("Escolhe o PDF ou carrega o exemplo NI 162.");
      const wanted=names.split(/\r?\n/).map(clean).filter(Boolean);
      if(!wanted.length) throw new Error("Indica pelo menos um nome.");
      const out=await extractPdf(file);
      setPages(out.pages);
      setGames(parseGames(out.rows,wanted));
    } catch(e) {
      setError(e?.message||String(e));
    } finally { setBusy(false); }
  };

  const sample=async()=>{
    setError(""); setBusy(true);
    try {
      const r=await fetch(SAMPLE);
      if(!r.ok) throw new Error("Não foi possível carregar o exemplo.");
      const b=await r.blob();
      setFile(new File([b],"NI 162 RET.pdf",{type:"application/pdf"}));
    } catch(e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return <section className="panel">
    <h2>Nomeações da FPF</h2>

    <div className="actions">
      <input type="file" accept=".pdf,application/pdf" onChange={e=>setFile(e.target.files?.[0]||null)}/>
      <button onClick={sample}>Carregar exemplo NI 162</button>
    </div>

    <label>
      Lista de árbitros — um nome por linha
      <textarea value={names} onChange={e=>setNames(e.target.value)}/>
    </label>

    <label>
      Fotografias — pode carregar várias de uma vez
      <input type="file" accept="image/*" multiple onChange={e=>onPhotos(e.target.files||[])}/>
    </label>

    <p className="hint">
      Para a pasta <code>public/fotos</code>, use por exemplo <code>Nuno Guerra.jpg</code>.
      Se não houver fotografia, o sistema mostra "FOTOGRAFIA" em vez de inventar uma.
    </p>

    <button className="primary" onClick={analyse} disabled={busy}>
      {busy?"A analisar…":"Analisar PDF"}
    </button>

    {error&&<div className="error">{error}</div>}
    {pages>0&&<p className="muted">PDF lido: {pages} página(s). Jogos com pelo menos um nome da lista: {games.length}.</p>}

    {games.length>0&&<div className="toolbar">
      <button className="primary small" onClick={()=>makeZip(games,uploaded)}>Gerar todos os JPG</button>
    </div>}

    <div className="results">
      {games.map((g,i)=><article className="game" key={i}>
        <div className="gameHead">
          <small>{g.competition}</small>
          <h3>{g.home} — {g.away}</h3>
        </div>
        <div className="officials">
          {g.matched.map((m,j)=><div key={j}><b>{m.requestedName}</b><span>{m.role}</span></div>)}
        </div>
        <div className="model">Modelo: <b>{g.model.label}</b></div>
        <button onClick={()=>saveJpg(g,i,uploaded)}>Gerar JPG deste jogo</button>
      </article>)}
    </div>
  </section>;
}

function ManualPage() {
  const [model,setModel]=useState("01_Futebol_So_Arbitro");
  return <section className="panel">
    <h2>Nomeação manual</h2>
    <div className="grid">
      <label>Competição<input placeholder="Liga 3"/></label>
      <label>Data<input type="date"/></label>
      <label>Hora<input type="time"/></label>
      <label>Equipa casa<input/></label>
      <label>Equipa fora<input/></label>
      <label>Modelo<select value={model} onChange={e=>setModel(e.target.value)}>
        <option value="01_Futebol_So_Arbitro">Futebol — 1 árbitro</option>
        <option value="02_Futebol_Arbitro_4">Futebol — Árbitro + 4.º</option>
        <option value="03_Futebol_Completo">Futebol — Completo</option>
        <option value="04_Futebol_Sem_4">Futebol — Sem 4.º</option>
        <option value="05_Futsal_3_Arbitros">Futsal — 3 + cronometrista</option>
        <option value="06_Futsal_Sem_3">Futsal — 2 + cronometrista</option>
        <option value="07_So_Observador">Observador</option>
      </select></label>
    </div>
    <p className="muted">A geração manual será ligada ao mesmo motor de JPG depois de validarmos os exemplos do PDF.</p>
  </section>;
}

createRoot(document.getElementById("root")).render(<App />);
