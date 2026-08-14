import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.mjs",import.meta.url).toString();

const MODELS={
 football1:"01_Futebol_So_Arbitro.pptx",
 football2:"02_Futebol_Arbitro_4.pptx",
 futsal4:"05_Futsal_3_Arbitros.pptx",
 futsal3:"06_Futsal_Sem_3.pptx",
 observer:"07_So_Observador.pptx"
};

function norm(s=""){return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[ºª]/g,"").replace(/\s+/g," ").trim().toUpperCase();}
function clean(s=""){return s.replace(/\s+/g," ").trim();}
function isFutsal(c){return /futsal/i.test(c);}
function isPlacard(c){return norm(c).includes("LIGA PLACARD");}
function isL3BPI(c){const n=norm(c);return n.includes("LIGA 3")||n.includes("LIGA BPI");}
function isStop(line){const n=norm(line);return n==="NOTA INFORMATIVA"||n.startsWith("O CONSELHO DE ARBITRAGEM");}
function isCompetition(line){const n=norm(line);return n.includes("JORNADA") && !n.includes("JOGO ARBITRO ASSOCIACAO") && !/^JOGO\b/.test(n);}
function isGameLine(line){return line.minX<180 && line.text.includes(" - ") && /\bA\.F\./i.test(line.text) && !/^(OBSV|VAR|AVAR)\s*:/i.test(line.text);}
function isOfficialLine(line){return /\bA\.F\./i.test(line.text);}
function officialName(line){
  const words=line.items.filter(w=>w.x>=250 && !/^A\.F\.$/i.test(w.text));
  const before=[];
  for(const w of words){if(/^A\.F\.$/i.test(w.text))break;before.push(w.text);}
  return clean(before.join(" "));
}
function gameNameFromLine(line,knownNames){
  // First try exact known name, because it gives the exact boundary between teams and official.
  for(const k of knownNames){
    const idx=norm(line.text).indexOf(norm(k));
    if(idx>=0) return clean(line.text.slice(0,idx));
  }
  // Fallback: everything before the official column.
  const teamItems=line.items.filter(w=>w.x<250).map(w=>w.text);
  return clean(teamItems.join(" "));
}
function findKnown(name,known){
  const n=norm(name);
  return known.find(k=>n===norm(k)||n.includes(norm(k))||norm(k).includes(n));
}
function roleFor(competition,officialIndex){
  if(isFutsal(competition)){
    if(isPlacard(competition)) return ["Árbitro","2.º Árbitro","3.º Árbitro","Cronometrista"][officialIndex]||"";
    return ["Árbitro","2.º Árbitro","Cronometrista"][officialIndex]||"";
  }
  if(isL3BPI(competition)) return officialIndex===0?"Árbitro":officialIndex===1?"4.º Árbitro":"";
  return officialIndex===0?"Árbitro":"";
}
function modelFor(competition,found){
  if(found.some(x=>x.role==="Observador")) return MODELS.observer;
  if(isFutsal(competition)){
    if(isPlacard(competition)) return found.length>=4?MODELS.futsal4:MODELS.futsal3;
    return MODELS.futsal3;
  }
  if(isL3BPI(competition)) return found.length>=2?MODELS.football2:MODELS.football1;
  return MODELS.football1;
}
function parsePdfPages(pages,knownNames){
  const out=[];
  for(const pageLines of pages){
    let competition="";
    let current=null;
    for(let i=0;i<pageLines.length;i++){
      const line=pageLines[i];
      if(isStop(line)){if(current){out.push(current);current=null;} competition=""; continue;}
      if(isCompetition(line)){
        if(current){out.push(current);current=null;}
        competition=clean(line.text);
        continue;
      }
      if(isGameLine(line)){
        if(current) out.push(current);
        current={competition,jogo:gameNameFromLine(line,knownNames),officials:[],observer:null};
        const first=officialName(line);
        const hit=findKnown(first,knownNames);
        if(hit) current.officials.push({name:hit.raw,line:0,role:roleFor(competition,0)});
        continue;
      }
      if(!current) continue;
      if(/^OBSV\s*:/i.test(line.text)){
        const raw=line.text.replace(/^OBSV\s*:\s*/i,"").trim();
        const hit=findKnown(raw,knownNames);
        if(hit) current.observer={name:hit.raw,role:"Observador"};
        continue;
      }
      if(/^(VAR|AVAR)\s*:/i.test(line.text)) continue;
      if(isOfficialLine(line)){
        const name=officialName(line);
        const hit=findKnown(name,knownNames);
        if(hit){
          const officialIndex=current.officials.length; // only found officials is not enough for role
          // Determine physical official line index from all normal official lines.
        }
      }
      // role assignment is redone below using the physical line order.
      if(isOfficialLine(line) && !/^(OBSV|VAR|AVAR)\s*:/i.test(line.text)){
        if(!current._normalIndex) current._normalIndex=1;
        else current._normalIndex++;
        const idx=current._normalIndex-1;
        const name=officialName(line);
        const hit=findKnown(name,knownNames);
        if(hit){
          // Remove a previous first-line duplicate if this is the first line.
          const role=roleFor(competition,idx);
          current.officials=current.officials.filter(x=>x._idx!==idx);
          current.officials.push({name:hit.raw,line:idx,role,_idx:idx});
        }
      }
    }
    if(current) out.push(current);
  }
  return out.map(g=>{
    delete g._normalIndex;
    g.officials.sort((a,b)=>a.line-b.line);
    const found=[...g.officials];
    if(g.observer) found.push(g.observer);
    return {...g,found,model:modelFor(g.competition,found.filter(x=>x.role!=="Observador"))};
  }).filter(g=>g.found.length>0);
}

function groupPages(rawPages,knownNames){
  return rawPages.map(page=>{
    const items=page.items;
    items.sort((a,b)=>b.y-a.y||a.x-b.x);
    const lines=[];
    for(const it of items){
      let l=lines.find(x=>Math.abs(x.y-it.y)<3);
      if(!l){l={y:it.y,items:[]};lines.push(l);}
      l.items.push(it);
    }
    lines.sort((a,b)=>b.y-a.y);
    return lines.map(l=>{
      l.items.sort((a,b)=>a.x-b.x);
      return {text:clean(l.items.map(x=>x.text).join(" ")),items:l.items,minX:Math.min(...l.items.map(x=>x.x))};
    }).filter(x=>x.text);
  }).map(lines=>lines);
}
async function extract(file){
  const data=new Uint8Array(await file.arrayBuffer());
  const pdf=await pdfjsLib.getDocument({data}).promise;
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    pages.push({items:content.items.map(x=>({text:x.str||"",x:x.transform?.[4]||0,y:x.transform?.[5]||0}))});
  }
  return pages;
}

function App(){
 const [pdf,setPdf]=useState(null),[list,setList]=useState("Nuno Guerra\nGonçalo Rosa"),[rows,setRows]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
 async function run(file=pdf){
  setError("");setRows([]);setBusy(true);
  try{
   if(!file) throw Error("Escolhe o PDF.");
   const names=list.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(raw=>({raw}));
   const raw=await extract(file);
   const pages=groupPages(raw,names);
   const games=parsePdfPages(pages,names);
   setRows(games);
  }catch(e){setError(e.message||"Erro ao processar o PDF.");}
  finally{setBusy(false);}
 }
 async function sample(){
  const r=await fetch("/exemplos/NI%20162%20RET.pdf");
  if(!r.ok){setError("Não foi possível carregar o PDF de exemplo.");return;}
  const f=new File([await r.blob()],"NI 162 RET.pdf",{type:"application/pdf"});
  setPdf(f); await run(f);
 }
 return <main className="app">
  <header><div className="badge">NAF MARQUES BOM</div><h1>Gerador de Nomeações</h1><p>Teste real da leitura das nomeações da FPF.</p></header>
  <section className="panel">
   <h2>PDF FPF</h2>
   <div className="actions"><label className="fileBtn">Escolher PDF<input type="file" accept=".pdf,application/pdf" onChange={e=>setPdf(e.target.files?.[0]||null)}/></label><button className="secondary" onClick={sample}>Carregar exemplo NI 162</button></div>
   <label>Lista de árbitros — um nome por linha<textarea value={list} onChange={e=>setList(e.target.value)}/></label>
   <button className="primary" disabled={busy} onClick={()=>run()}>{busy?"A analisar…":"Analisar PDF"}</button>
   {error&&<div className="error">{error}</div>}
  </section>
  {rows.length>0&&<section className="panel results"><h2>Jogos encontrados: {rows.length}</h2>
   {rows.map((g,i)=><article className="game" key={i}>
    <div className="gameHead"><div><b>{g.jogo}</b><small>{g.competition||"Competição não identificada"}</small></div><span>{g.model}</span></div>
    <div className="officials">{g.found.map((x,j)=><div className="official" key={j}><b>{x.name}</b><span>{x.role}</span></div>)}</div>
   </article>)}
  </section>}
 </main>
}
createRoot(document.getElementById("root")).render(<App/>);
