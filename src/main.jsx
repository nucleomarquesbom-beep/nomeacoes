import React, {useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
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

function cleanName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMatchLine(line) {
  const s = cleanName(line);
  if (!s.includes(" - ")) return false;
  const u = normalize(s);
  if (/^(OBSV|VAR|AVAR)\s*:/.test(u)) return false;
  const excluded = [
    "NOTA INFORMATIVA","JORNADA","FASE","SÉRIE","SERIE","DIVISÃO",
    "DIVISAO","LIGA PLACARD","LIGA BPI","CAMPEONATO","TAÇA NACIONAL",
    "CAMPEONATO NACIONAL","PROVAS OFICIAIS"
  ];
  if (excluded.some(x => u.includes(normalize(x)))) return false;
  const [a,b] = s.split(" - ",2).map(cleanName);
  return a.length >= 3 && b.length >= 3;
}

function looksLikeCompetition(line) {
  const u = normalize(line);
  if (!u || u === "JOGO") return false;
  if (line.includes("A.F.") || isMatchLine(line)) return false;
  return /LIGA|CAMPEONATO|TAÇA|FUTSAL|PROVAS|TORNEIO|NACIONAL/.test(u);
}

function isHeaderNoise(line) {
  const u = normalize(line);
  return !u || u === "NOTA INFORMATIVA" || u.startsWith("N.:") ||
    u.startsWith("DATA:") || u.startsWith("PARA OS DEVIDOS EFEITOS") ||
    u === "JOGO" || u.startsWith("ÁRBITRO") || u.startsWith("ARBITRO");
}

function extractOfficial(line) {
  const s = cleanName(line);
  const u = normalize(s);
  if (/^OBSV\s*:/.test(u)) {
    return {name: cleanName(s.replace(/^OBSV\s*:\s*/i,"")), type:"observer"};
  }
  if (/^(VAR|AVAR)\s*:/.test(u)) return null;
  const af = s.search(/\bA\.F\.\s*/i);
  if (af < 0) return null;
  const name = cleanName(s.slice(0,af));
  if (!name) return null;
  const association = cleanName(s.slice(af));
  return {name, association, type:"referee"};
}

function isFutsal(comp) {
  return normalize(comp).includes("FUTSAL");
}
function isPlacardFutsal(comp) {
  const n=normalize(comp);
  return n.includes("LIGA PLACARD") && n.includes("FUTSAL");
}
function isLiga3OrBPI(comp) {
  const n=normalize(comp);
  return n.includes("LIGA 3") || n.includes("LIGA BPI");
}

function assignRole(comp, officialIndex) {
  if (isFutsal(comp)) {
    if (isPlacardFutsal(comp)) {
      return ["Árbitro","2.º Árbitro","3.º Árbitro","Cronometrista"][officialIndex] ?? "Oficial";
    }
    return ["Árbitro","2.º Árbitro","Cronometrista"][officialIndex] ?? "Oficial";
  }
  if (isLiga3OrBPI(comp)) {
    return officialIndex === 0 ? "Árbitro" : officialIndex === 1 ? "4.º Árbitro" : "Oficial";
  }
  return officialIndex === 0 ? "Árbitro" : "Oficial";
}

function chooseModel(comp, matchedOfficials) {
  const observers = matchedOfficials.filter(x=>x.type==="observer");
  if (observers.length && matchedOfficials.filter(x=>x.type==="referee").length===0) {
    return {code:"07_So_Observador", label:"Observador"};
  }
  const refs = matchedOfficials.filter(x=>x.type==="referee");
  if (isFutsal(comp)) {
    if (isPlacardFutsal(comp)) {
      return refs.length >= 4
        ? {code:"05_Futsal_3_Arbitros",label:"Futsal — 3 árbitros + cronometrista"}
        : {code:"06_Futsal_Sem_3",label:"Futsal — 2 árbitros + cronometrista"};
    }
    return refs.length >= 3
      ? {code:"05_Futsal_3_Arbitros",label:"Futsal — 3 árbitros + cronometrista"}
      : {code:"06_Futsal_Sem_3",label:"Futsal — 2 árbitros + cronometrista"};
  }
  if (isLiga3OrBPI(comp) && refs.length >= 2) {
    return {code:"02_Futebol_Arbitro_4",label:"Futebol — Árbitro + 4.º Árbitro"};
  }
  return {code:"01_Futebol_So_Arbitro",label:"Futebol — 1 elemento"};
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({data}).promise;
  const allLines=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    const items=content.items.map(i=>({text:i.str||"",x:i.transform?.[4]??0,y:i.transform?.[5]??0}));
    items.sort((a,b)=>b.y-a.y || a.x-b.x);
    const rows=[];
    for(const item of items){
      let row=rows.find(r=>Math.abs(r.y-item.y)<2.5);
      if(!row){row={y:item.y,items:[]};rows.push(row);}
      row.items.push(item);
    }
    rows.sort((a,b)=>b.y-a.y);
    const lines=rows.map(r=>r.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(" ").replace(/\s+/g," ").trim()).filter(Boolean);
    allLines.push(...lines);
  }
  return {pages:pdf.numPages,lines:allLines};
}

function parseGames(lines, wantedNames) {
  const wanted = wantedNames.filter(Boolean).map(raw=>({raw,n:normalize(raw)}));
  const games=[];
  let competition="";
  let pendingHeading=[];
  let current=null;

  const closeGame=()=>{
    if(!current) return;
    const officials=current.officials;
    const matched=[];
    officials.forEach((o,index)=>{
      const w=wanted.find(x=>normalize(o.name)===x.n || normalize(o.name).includes(x.n) || x.n.includes(normalize(o.name)));
      if(w) matched.push({...o, requestedName:w.raw,index,role: o.type==="observer" ? "Observador" : assignRole(current.competition,index)});
    });
    if(matched.length){
      const model=chooseModel(current.competition,matched);
      games.push({...current,matched,model});
    }
    current=null;
  };

  for(const line of lines){
    if(looksLikeCompetition(line)){
      if(current) closeGame();
      pendingHeading.push(line);
      continue;
    }
    if(line === "Jogo" || normalize(line).startsWith("JOGO ")){
      if(pendingHeading.length) competition=pendingHeading.join(" ");
      pendingHeading=[];
      continue;
    }
    if(isMatchLine(line)){
      if(current) closeGame();
      const [home,away]=line.split(" - ",2).map(cleanName);
      current={home,away,competition,officials:[]};
      continue;
    }
    if(current){
      const official=extractOfficial(line);
      if(official) current.officials.push(official);
    }
  }
  if(current) closeGame();
  return games;
}

function posterSvg(game) {
  const w=900,h=1600;
  const roleLines=game.matched.map((m,i)=>`<text x="450" y="${650+i*130}" text-anchor="middle" font-size="28" fill="#ddd">${escapeXml(m.requestedName)} — ${escapeXml(m.role)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#0c0c0c"/>
  <text x="55" y="70" font-size="18" fill="#ddd">NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA</text>
  <text x="55" y="155" font-size="52" font-weight="700" fill="#fff">NOMEAÇÃO</text>
  <text x="55" y="215" font-size="25" fill="#ddd">${escapeXml(game.competition)}</text>
  <text x="55" y="270" font-size="28" font-weight="700" fill="#fff">${escapeXml(game.home)} VS ${escapeXml(game.away)}</text>
  ${roleLines}
  <text x="55" y="1510" font-size="19" fill="#aaa">TRABALHO, COMPETÊNCIA E DEDICAÇÃO</text>
  </svg>`;
}
function escapeXml(s){return String(s).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));}
async function downloadJpg(game, idx) {
  const svg=posterSvg(game);
  const blob=new Blob([svg],{type:"image/svg+xml"});
  const url=URL.createObjectURL(blob);
  const img=new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url});
  const c=document.createElement("canvas"); c.width=900;c.height=1600;
  c.getContext("2d").drawImage(img,0,0);
  URL.revokeObjectURL(url);
  const a=document.createElement("a");
  a.download=`Nomeacao_${String(idx+1).padStart(2,"0")}_${game.home}_vs_${game.away}.jpg`.replace(/[\\/:*?"<>|]/g,"_");
  a.href=c.toDataURL("image/jpeg",.94);a.click();
}

function App(){
  const [tab,setTab]=useState("pdf");
  return <div className="app">
    <header><div className="pill">NAF MARQUES BOM</div><h1>Gerador de Nomeações</h1><p>PDF da FPF → jogos → árbitros → modelo</p></header>
    <nav><button className={tab==="pdf"?"active":""} onClick={()=>setTab("pdf")}>📄 PDF FPF</button><button className={tab==="manual"?"active":""} onClick={()=>setTab("manual")}>✏️ Nomeação manual</button></nav>
    {tab==="pdf"?<PdfPage/>:<ManualPage/>}
  </div>
}

function PdfPage(){
  const [file,setFile]=useState(null),[names,setNames]=useState("Nuno Guerra\nGonçalo Rosa"),[games,setGames]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[pages,setPages]=useState(0);
  const analyse=async()=>{
    setError("");setGames([]);setBusy(true);
    try{
      if(!file) throw new Error("Escolhe um PDF ou carrega o exemplo.");
      const wanted=names.split(/\r?\n/).map(cleanName).filter(Boolean);
      if(!wanted.length) throw new Error("Indica pelo menos um nome.");
      const out=await extractPdf(file);setPages(out.pages);
      setGames(parseGames(out.lines,wanted));
    }catch(e){setError(e?.message||String(e));}finally{setBusy(false);}
  };
  const loadSample=async()=>{
    setError("");setBusy(true);
    try{const r=await fetch(SAMPLE);if(!r.ok)throw new Error("Não foi possível carregar o PDF de exemplo.");const b=await r.blob();setFile(new File([b],"NI 162 RET.pdf",{type:"application/pdf"}));}
    catch(e){setError(e.message)}finally{setBusy(false);}
  };
  return <section className="panel">
    <h2>Nomeações da FPF</h2>
    <div className="actions"><input type="file" accept=".pdf,application/pdf" onChange={e=>setFile(e.target.files?.[0]||null)}/><button onClick={loadSample}>Carregar exemplo NI 162</button></div>
    <label>Lista de árbitros — um nome por linha<textarea value={names} onChange={e=>setNames(e.target.value)}/></label>
    <button className="primary" onClick={analyse} disabled={busy}>{busy?"A analisar…":"Analisar PDF"}</button>
    {error&&<div className="error">{error}</div>}
    {pages>0&&<p className="muted">PDF lido: {pages} página(s).</p>}
    <div className="results">
      <h3>Jogos encontrados: {games.length}</h3>
      {games.map((g,i)=><article className="game" key={i}>
        <div><small>{g.competition}</small><h3>{g.home} — {g.away}</h3></div>
        <div className="officials">{g.matched.map((m,j)=><div key={j}><b>{m.requestedName}</b><span>{m.role}</span></div>)}</div>
        <div className="model">Modelo: <b>{g.model.label}</b></div>
        <button onClick={()=>downloadJpg(g,i)}>Pré-visualizar / exportar JPG</button>
      </article>)}
    </div>
  </section>
}

function ManualPage(){
  const [model,setModel]=useState("01_Futebol_So_Arbitro"),[comp,setComp]=useState(""),[home,setHome]=useState(""),[away,setAway]=useState(""),[rows,setRows]=useState([{name:"",role:"Árbitro"}]);
  const add=()=>setRows(r=>[...r,{name:"",role:""}]);
  return <section className="panel">
    <h2>Nomeação manual</h2>
    <label>Modelo<select value={model} onChange={e=>setModel(e.target.value)}>{models.map(m=><option value={m.code} key={m.code}>{m.label}</option>)}</select></label>
    <div className="grid"><label>Competição<input value={comp} onChange={e=>setComp(e.target.value)}/></label><label>Data<input type="date"/></label><label>Hora<input type="time"/></label><label>Equipa casa<input value={home} onChange={e=>setHome(e.target.value)}/></label><label>Equipa fora<input value={away} onChange={e=>setAway(e.target.value)}/></label></div>
    <h3>Árbitros / oficiais</h3>
    {rows.map((r,i)=><div className="rowInputs" key={i}><input placeholder="Nome" value={r.name} onChange={e=>setRows(a=>a.map((x,k)=>k===i?{...x,name:e.target.value}:x))}/><input placeholder="Função" value={r.role} onChange={e=>setRows(a=>a.map((x,k)=>k===i?{...x,role:e.target.value}:x))}/></div>)}
    <button onClick={add}>+ Adicionar elemento</button>
    <div className="manualPreview"><b>{comp||"COMPETIÇÃO"}</b><h3>{home||"EQUIPA CASA"} — {away||"EQUIPA FORA"}</h3>{rows.filter(r=>r.name).map((r,i)=><p key={i}><b>{r.name}</b> — {r.role}</p>)}</div>
  </section>
}
createRoot(document.getElementById("root")).render(<App/>);
