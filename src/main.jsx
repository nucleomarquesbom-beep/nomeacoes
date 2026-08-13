import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";

const models = [
  ["01_Futebol_So_Arbitro","Futebol — Árbitro"],
  ["02_Futebol_Arbitro_4","Futebol — Árbitro + 4.º Árbitro"],
  ["03_Futebol_Completo","Futebol — Completo"],
  ["04_Futebol_Sem_4","Futebol — Sem 4.º Árbitro"],
  ["05_Futsal_3_Arbitros","Futsal — 3 Árbitros + Cronometrista"],
  ["06_Futsal_Sem_3","Futsal — Sem 3.º Árbitro"],
  ["07_So_Observador","Observador"]
];

function App(){
  const [page,setPage]=useState("home");
  return <main className="app">
    <header><div className="badge">NAF MARQUES BOM</div><h1>Gerador de Nomeações</h1><p>Cria as imagens das nomeações de forma simples e rápida.</p></header>
    {page==="home" && <div className="cards">
      <button className="card" onClick={()=>setPage("pdf")}><span>📄</span><b>Nomeações da FPF</b><small>Carregar o PDF e gerar automaticamente as nomeações.</small></button>
      <button className="card" onClick={()=>setPage("manual")}><span>✏️</span><b>Nomeação manual</b><small>Escolher o modelo e preencher os dados manualmente.</small></button>
    </div>}
    {page==="pdf" && <Pdf onBack={()=>setPage("home")}/>}
    {page==="manual" && <Manual onBack={()=>setPage("home")}/>}
  </main>
}

function Pdf({onBack}){
 const [file,setFile]=useState(null);
 return <section className="panel"><button className="back" onClick={onBack}>← Voltar</button><h2>Nomeações da FPF</h2>
 <p className="muted">Carrega o PDF da FPF. O motor de leitura e classificação será ligado na próxima etapa.</p>
 <label className="upload"><input type="file" accept=".pdf,application/pdf" onChange={e=>setFile(e.target.files?.[0]||null)}/><span>Escolher PDF</span></label>
 {file && <div className="file"><b>{file.name}</b><small>{Math.round(file.size/1024)} KB</small></div>}
 <button className="primary" disabled={!file}>Analisar PDF</button></section>
}

function Manual({onBack}){
 const [model,setModel]=useState(models[2][0]);
 return <section className="panel"><button className="back" onClick={onBack}>← Voltar</button><h2>Nomeação manual</h2>
 <div className="grid">
  <label>Data<input type="date"/></label><label>Hora<input type="time"/></label>
  <label>Competição<input placeholder="Ex.: Liga 3"/></label><label>Fase<input placeholder="Ex.: Jornada 5"/></label>
  <label>Equipa da casa<input/></label><label>Equipa visitante<input/></label>
 </div>
 <label>Modelo<select value={model} onChange={e=>setModel(e.target.value)}>{models.map(([v,t])=><option value={v} key={v}>{t}</option>)}</select></label>
 <h3>Árbitros / oficiais</h3>
 {[1,2,3,4].map(n=><div className="official" key={n}><input placeholder={"Nome "+n}/><input placeholder="Função"/></div>)}
 <button className="primary">Gerar JPG</button></section>
}

createRoot(document.getElementById("root")).render(<App/>);
