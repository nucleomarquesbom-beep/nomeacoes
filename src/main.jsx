import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const MODELS = {
  footballRef: "01_Futebol_So_Arbitro",
  footballRef4: "02_Futebol_Arbitro_4",
  footballFull: "03_Futebol_Completo",
  footballNo4: "04_Futebol_Sem_4",
  futsal3: "05_Futsal_3_Arbitros",
  futsalNo3: "06_Futsal_Sem_3",
  observer: "07_So_Observador"
};

const modelNames = [
  [MODELS.footballRef,"Futebol — Árbitro"],
  [MODELS.footballRef4,"Futebol — Árbitro + 4.º Árbitro"],
  [MODELS.footballFull,"Futebol — Completo"],
  [MODELS.footballNo4,"Futebol — Sem 4.º Árbitro"],
  [MODELS.futsal3,"Futsal — 3 Árbitros + Cronometrista"],
  [MODELS.futsalNo3,"Futsal — Sem 3.º Árbitro"],
  [MODELS.observer,"Observador"]
];

function normalize(s="") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[ºª]/g,"").replace(/\s+/g," ").trim().toUpperCase();
}

function isKnownCompetition(c) {
  const n=normalize(c);
  return n.includes("LIGA 3") || n.includes("LIGA BPI") || n.includes("LIGA PLACAR");
}
function isFutsal(c) {
  return /futsal|placar/i.test(c);
}
function isPlacard(c) {
  return normalize(c).includes("LIGA PLACAR");
}
function isFootball4(c) {
  const n=normalize(c);
  return n.includes("LIGA 3") || n.includes("LIGA BPI");
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({data}).promise;
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    const items=content.items.map(x=>({
      text:x.str||"", x:x.transform?.[4]||0, y:x.transform?.[5]||0
    }));
    items.sort((a,b)=> b.y-a.y || a.x-b.x);
    const lines=[];
    for(const it of items){
      let line=lines.find(l=>Math.abs(l.y-it.y)<3);
      if(!line){line={y:it.y,items:[]};lines.push(line)}
      line.items.push(it);
    }
    lines.sort((a,b)=>b.y-a.y);
    pages.push(lines.map(l=>l.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(" ").replace(/\s+/g," ").trim()).filter(Boolean));
  }
  return pages;
}

function parseNominationLines(lines, knownNames) {
  const known = knownNames.map(n=>({raw:n,n:norm=normalize(n)}));
  const hits=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const obs=line.match(/OBSV\s*:\s*(.+)/i);
    if(obs){
      const name=obs[1].trim();
      const found=known.find(k=>normalize(name).includes(k.n)||k.n.includes(normalize(name)));
      if(found) hits.push({name:found.raw,role:"Observador",source:i});
      continue;
    }
    for(const k of known){
      if(normalize(line).includes(k.n)){
        hits.push({name:k.raw,role:null,source:i});
      }
    }
  }
  return hits;
}

function assignRoles(hits, competition) {
  if(!hits.length) return [];
  const unique=[];
  const seen=new Set();
  for(const h of hits){if(!seen.has(h.name+"|"+h.source)){seen.add(h.name+"|"+h.source);unique.push(h)}}
  if(unique.some(x=>x.role==="Observador")) return unique.filter(x=>x.role==="Observador");
  const futsal=isFutsal(competition);
  const roles=futsal
    ? (isPlacard(competition)
      ? ["Árbitro","2.º Árbitro","3.º Árbitro","Cronometrista"]
      : ["Árbitro","2.º Árbitro","Cronometrista"])
    : (isFootball4(competition)
      ? ["Árbitro","4.º Árbitro"]
      : ["Árbitro"]);
  return unique.slice(0,roles.length).map((x,i)=>({...x,role:roles[i]}));
}

function App(){
 const [tab,setTab]=useState("pdf");
 return <main className="app">
  <header><div className="badge">NAF MARQUES BOM</div><h1>Gerador de Nomeações</h1><p>Processamento das nomeações da FPF e criação manual.</p></header>
  <nav><button className={tab==="pdf"?"active":""} onClick={()=>setTab("pdf")}>📄 PDF FPF</button><button className={tab==="manual"?"active":""} onClick={()=>setTab("manual")}>✏️ Nomeação manual</button></nav>
  {tab==="pdf"?<PdfPage/>:<ManualPage/>}
 </main>
}

function PdfPage(){
 const [pdf,setPdf]=useState(null),[list,setList]=useState(""),[pages,setPages]=useState([]),[result,setResult]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
 async function analyse(){
  setError("");setResult([]);setBusy(true);
  try{
   const names=list.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   if(!pdf) throw new Error("Escolhe primeiro o PDF da FPF.");
   if(!names.length) throw new Error("Coloca pelo menos um nome na lista de árbitros.");
   const p=await extractPdf(pdf);setPages(p);
   const all=p.flat();
   const found=parseNominationLines(all,names);
   // nesta etapa mostramos o cruzamento real; a geração gráfica vem depois.
   setResult(found.map(x=>({...x})));
  }catch(e){setError(e.message||"Erro ao ler o PDF.")}finally{setBusy(false)}
 }
 return <section className="panel">
  <h2>Nomeações da FPF</h2>
  <label>PDF das nomeações<input type="file" accept=".pdf,application/pdf" onChange={e=>setPdf(e.target.files?.[0]||null)}/></label>
  <label>Lista de árbitros — um nome por linha<textarea value={list} onChange={e=>setList(e.target.value)} placeholder={"Nuno Guerra\nGonçalo Rosa\n..."}/></label>
  <button className="primary" onClick={analyse} disabled={busy}>{busy?"A analisar…":"Analisar PDF"}</button>
  {error&&<div className="error">{error}</div>}
  {result.length>0&&<div className="results"><h3>Árbitros encontrados</h3>{result.map((r,i)=><div className="row" key={i}><b>{r.name}</b><span>{r.role||"posição encontrada"}</span></div>)}</div>}
  {pages.length>0&&<p className="muted">PDF lido: {pages.length} página(s). Próxima etapa: agrupar cada jogo e gerar os JPG.</p>}
 </section>
}

function ManualPage(){
 const [model,setModel]=useState(MODELS.footballFull);
 return <section className="panel">
  <h2>Nomeação manual</h2>
  <div className="grid">
   <label>Data<input type="date"/></label><label>Hora<input type="time"/></label>
   <label>Competição<input placeholder="Liga 3"/></label><label>Fase<input placeholder="Jornada"/></label>
   <label>Equipa da casa<input/></label><label>Equipa visitante<input/></label>
  </div>
  <label>Modelo<select value={model} onChange={e=>setModel(e.target.value)}>{modelNames.map(([v,t])=><option value={v} key={v}>{t}</option>)}</select></label>
  <h3>Oficiais</h3>{[1,2,3,4].map(n=><div className="official" key={n}><input placeholder={"Nome "+n}/><input placeholder="Função"/></div>)}
  <button className="primary">Gerar JPG</button>
  <p className="muted">A criação gráfica será ligada depois de validarmos a leitura do PDF.</p>
 </section>
}

createRoot(document.getElementById("root")).render(<App/>);
