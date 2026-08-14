/* Gerador de Nomeações — NAF Marques Bom
   Geração direta em Canvas. Não depende de PowerPoint para exportar JPG.
   O logo é sempre carregado de /fotografias/logo.png sem edição.
*/
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const state={games:[],list:[],pdfText:"",generated:[],manualFiles:[]};

function norm(s){
  return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[ºª°]/g,"").replace(/[^a-zA-Z0-9\s]/g," ")
    .replace(/\s+/g," ").trim().toUpperCase();
}
function cleanName(s){return String(s||"").replace(/\s+/g," ").trim()}
function safeFile(s){return cleanName(s).replace(/[\\/:*?"<>|]+/g,"-").replace(/\s+/g," ").slice(0,180)}
function isCompetitionLine(line){
  const n=norm(line);
  return /^(LIGA |CAMPEONATO |TAÇA |TACA |SUPER |TORNEIO |DIVISAO |DIVISÃO )/.test(n) ||
    /(^| )LIGA (3|BPI|PLACARD)/.test(n) || /FUTSAL/.test(n) && !line.includes(" A.F.");
}
function isGameLine(line){
  return line.includes(" - ") && / A\.F\./i.test(line) && !/^(Jogo|OBS|NOTA)/i.test(line.trim());
}
function extractAssociationName(line){
  const p=line.search(/\s+A\.F\./i);
  if(p<0) return "";
  return cleanName(line.slice(0,p));
}
function findListedName(line){
  const n=norm(line);
  // longest first: avoids partial matches
  const arr=[...state.list].sort((a,b)=>norm(b).length-norm(a).length);
  return arr.find(name=>n.includes(norm(name)))||"";
}
function extractObserver(line){
  const m=line.match(/OBSV\s*:\s*(.*)$/i);
  return m?cleanName(m[1]):"";
}
function modality(comp){return /FUTSAL|LIGA PLACARD(?!.*LIGA 3)/i.test(comp) ? "FUTSAL":"FUTEBOL";}
function roleFor(comp,mode,pos){
  const n=norm(comp);
  if(mode==="FUTSAL"){
    if(n.includes("LIGA PLACARD")) return ["ÁRBITRO","2.º ÁRBITRO","3.º ÁRBITRO","CRONOMETRISTA"][pos-1]||"";
    return ["ÁRBITRO","2.º ÁRBITRO","CRONOMETRISTA"][pos-1]||"";
  }
  if(n.includes("LIGA 3")||n.includes("LIGA BPI")) return pos===1?"ÁRBITRO":pos===2?"4.º ÁRBITRO":"";
  return pos===1?"ÁRBITRO":"";
}
function modelFor(comp,mode,count,observer=false){
  if(observer) return "observer";
  if(mode==="FUTSAL") return norm(comp).includes("LIGA PLACARD") ? (count>=4?"futsal4":"futsal3") : "futsal3";
  if(norm(comp).includes("LIGA 3")||norm(comp).includes("LIGA BPI")) return count>=2?"football2":"football1";
  return "football1";
}
function parseText(text){
  const lines=text.split(/\r?\n/).map(x=>cleanName(x)).filter(Boolean);
  const games=[]; let comp=""; let current=null;
  function finish(){if(current && (current.officials.length||current.observer)){games.push(current)} current=null}
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/NOTA INFORMATIVA|Jogo Árbitro Associação/i.test(line) && !isGameLine(line)){ if(/NOTA INFORMATIVA/i.test(line)) {finish();comp="";} continue; }
    if(isCompetitionLine(line)){ finish(); comp=line; continue; }
    if(isGameLine(line)){
      finish();
      const first=findListedName(line);
      let game=line;
      const af=line.search(/\s+A\.F\./i);
      const dash=line.lastIndexOf(" - ", af>0?af:line.length);
      if(first && af>0 && dash>=0){
        const refBlock=line.slice(dash+3,af).trim();
        const ni=norm(refBlock), nn=norm(first);
        const pni=ni.lastIndexOf(nn);
        if(pni>=0){
          // Most FPF lines preserve token order; derive the game from the
          // part before the listed referee name.
          const approxRef=refBlock.length-nn.length;
          game=line.slice(0,dash+3+Math.max(0,approxRef)).trim();
          // remove a trailing team/name separator
          game=game.replace(/\s+$/,"").trim();
        }else{
          game=line.slice(0,dash+3+Math.max(0,refBlock.length-first.length-1)).trim();
        }
      }
      current={competition:comp,game:game||line,mode:modality(comp),officials:[],observer:"",allRows:[]};
      if(first) current.officials.push(first);
      continue;
    }
    if(current){
      const obs=extractObserver(line);
      if(obs){const listed=state.list.find(n=>norm(n)===norm(obs))||findListedName(obs); if(listed) current.observer=listed; continue;}
      if(/ A\.F\./i.test(line)){
        const listed=findListedName(line);
        if(listed && current.officials.length<4) current.officials.push(listed);
      }
    }
  }
  finish();
  // Remove duplicate officials while preserving order
  games.forEach(g=>{g.officials=[...new Set(g.officials)];});
  return games.filter(g=>g.officials.length||g.observer);
}

async function readPdf(file){
  const data=new Uint8Array(await file.arrayBuffer());
  const pdf=await pdfjsLib.getDocument({data}).promise;
  let text="";
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    const items=content.items.map(i=>i.str).filter(Boolean);
    text+=items.join(" ")+"\n";
  }
  return {pages:pdf.numPages,text};
}

function showStatus(el,msg,error=false){el.textContent=msg;el.classList.remove("hidden");el.classList.toggle("error",error)}

async function analyse(){
  const file=$("#pdfFile").files[0]; state.list=$("#nameList").value.split(/\r?\n/).map(cleanName).filter(Boolean);
  if(!file){showStatus($("#pdfStatus"),"Escolhe primeiro o PDF.",true);return}
  if(!state.list.length){showStatus($("#pdfStatus"),"Indica pelo menos um nome.",true);return}
  showStatus($("#pdfStatus"),"A ler o PDF e a agrupar os jogos…");
  try{
    const r=await readPdf(file); state.pdfText=r.text; state.games=parseText(r.text); state.generated=[];
    renderResults(r.pages);
    showStatus($("#pdfStatus"),`PDF lido: ${r.pages} página(s). ${state.games.length} jogo(s) com pelo menos um nome encontrado.`);
    $("#pdfActions").classList.toggle("hidden",!state.games.length);
  }catch(e){console.error(e);showStatus($("#pdfStatus"),"Erro ao ler o PDF: "+e.message,true)}
}

function renderResults(pages){
  const box=$("#results");box.innerHTML="";
  if(!state.games.length){box.innerHTML='<div class="result">Nenhum nome da lista foi encontrado nos jogos.</div>';return}
  state.games.forEach((g,idx)=>{
    const d=document.createElement("div");d.className="result";
    const officials=g.officials.map((n,i)=>`<span class="pill">${escapeHtml(n)} — ${escapeHtml(roleFor(g.competition,g.mode,i+1))}</span>`).join("");
    const obs=g.observer?`<span class="pill">Observador: ${escapeHtml(g.observer)}</span>`:"";
    d.innerHTML=`<b>${idx+1}. ${escapeHtml(g.game)}</b><div class="small">${escapeHtml(g.competition||"Competição não identificada")}</div>${officials}${obs}`;
    box.appendChild(d);
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

async function loadImage(src){
  return new Promise((resolve,reject)=>{
    const im=new Image(); im.onload=()=>resolve(im); im.onerror=()=>reject(new Error("Imagem não encontrada: "+src)); im.src=src;
  });
}
const imgCache=new Map();
async function getLocalPhoto(name){
  const candidates=[name,name.normalize("NFD").replace(/[\u0300-\u036f]/g,""),safeFile(name)];
  const exts=[".jpg",".jpeg",".png",".webp"];
  const manualKey=imgCache.get("manual:"+norm(name));
  if(manualKey) return manualKey;
  for(const c of candidates) for(const ext of exts){
    const src="./fotografias/"+encodeURIComponent(c+ext).replace(/%2F/g,"/");
    try{const im=await loadImage(src);return im}catch(_){}
  }
  return null;
}
async function getLogo(){
  if(imgCache.has("logo")) return imgCache.get("logo");
  try{const im=await loadImage("./fotografias/logo.png");imgCache.set("logo",im);return im}
  catch(e){throw new Error("Falta o logo original em public/fotografias/logo.png")}
}
async function getCrest(team){
  const keys=[team,team.replace(/\bSAD\b|\bSDUQ\b|\bFC\b|\bSC\b/gi,"").trim()];
  for(const k of keys){
    for(const ext of [".png",".jpg",".jpeg",".webp"]){
      try{return await loadImage("./escudos/"+encodeURIComponent(k+ext))}catch(_){}
    }
  }
  // Best-effort Wikipedia lookup. It is optional and never blocks JPG creation.
  try{
    const q=encodeURIComponent(team+" futebol Portugal");
    const sr=await fetch(`https://pt.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=${q}&srlimit=1`);
    const sj=await sr.json(); const page=sj.query?.search?.[0]; if(!page) return null;
    const pr=await fetch(`https://pt.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageimages&piprop=original&titles=${encodeURIComponent(page.title)}`);
    const pj=await pr.json(); const pages=Object.values(pj.query?.pages||{}); const url=pages[0]?.original?.source; if(!url)return null;
    return await loadImage(url);
  }catch(_){return null}
}

function roundRect(ctx,x,y,w,h,r,fill,stroke){
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
  if(fill){ctx.fillStyle=fill;ctx.fill()} if(stroke){ctx.strokeStyle=stroke;ctx.stroke()}
}
function drawCover(ctx,im,x,y,w,h){
  const s=Math.max(w/im.width,h/im.height), nw=im.width*s,nh=im.height*s;
  ctx.drawImage(im,x+(w-nw)/2,y+(h-nh)/2,nw,nh);
}
function drawContain(ctx,im,x,y,w,h){
  const s=Math.min(w/im.width,h/im.height),nw=im.width*s,nh=im.height*s;
  ctx.drawImage(im,x+(w-nw)/2,y+(h-nh)/2,nw,nh);
}
function fitText(ctx,text,maxWidth,size,font="Arial",weight=700){
  let s=size;ctx.font=`${weight} ${s}px ${font}`;
  while(ctx.measureText(text).width>maxWidth&&s>18){s-=2;ctx.font=`${weight} ${s}px ${font}`}
  return s;
}
function text(ctx,txt,x,y,maxW,size,color="#fff",align="left",weight=700){
  size=fitText(ctx,txt,maxW,size,"Arial",weight);ctx.font=`${weight} ${size}px Arial`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline="middle";ctx.fillText(txt,x,y);return size;
}
function drawBackground(ctx){
  ctx.fillStyle="#17242b";ctx.fillRect(0,0,1080,1920);
  // Use the exact visual reference texture asset created from the supplied screenshot.
  ctx.globalAlpha=.95;ctx.drawImage(backgroundImage,0,0,1080,1920);ctx.globalAlpha=1;
  ctx.fillStyle="rgba(6,13,17,.28)";ctx.fillRect(0,0,1080,1920);
}
let backgroundImage=null;
async function initBackground(){try{backgroundImage=await loadImage("./fundo_marques_bom.jpg")}catch(_){backgroundImage=null}}

function drawHeader(ctx,logo,title="NOMEAÇÃO"){
  if(logo) drawContain(ctx,logo,58,55,145,145);
  text(ctx,"NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA",58,32,940,20,"#f3f4f4","left",700);
  text(ctx,title,235,125,770,88,"#fff","left",900);
  // gold accent line
  ctx.fillStyle="#e7b63d";ctx.fillRect(235,173,270,6);
}
function drawMatch(ctx,home,away,homeCrest,awayCrest){
  roundRect(ctx,40,620,1000,300,22,"rgba(9,17,21,.55)","rgba(255,255,255,.16)");
  if(homeCrest)drawContain(ctx,homeCrest,70,680,170,170);
  if(awayCrest)drawContain(ctx,awayCrest,840,680,170,170);
  text(ctx,home,270,715,540,42,"#fff","center",900);
  text(ctx,"VS",540,790,150,42,"#e7b63d","center",900);
  text(ctx,away,270,855,540,42,"#fff","center",900);
}
async function drawOfficialCard(ctx,off,x,y,w,h,role){
  roundRect(ctx,x,y,w,h,22,"rgba(12,21,26,.62)","rgba(255,255,255,.14)");
  const photo=await getLocalPhoto(off.name);
  if(photo){roundRect(ctx,x+28,y+28,300,h-56,12,"#e9e9e1");ctx.save();ctx.beginPath();ctx.rect(x+45,y+45,266,h-90);ctx.clip();drawCover(ctx,photo,x+45,y+45,266,h-90);ctx.restore()}
  else{roundRect(ctx,x+28,y+28,300,h-56,12,"#26343b");text(ctx,"FOTOGRAFIA",178,y+h/2,240,24,"#aab6bc","center",700)}
  text(ctx,role.toUpperCase(),365,y+88,w-400,28,"#e7b63d","left",900);
  text(ctx,off.name,365,y+175,w-400,44,"#fff","left",900);
}
async function renderCanvas(g,opts={}){
  const canvas=document.createElement("canvas");canvas.width=1080;canvas.height=1920;const ctx=canvas.getContext("2d");
  drawBackground(ctx);
  const logo=await getLogo();
  drawHeader(ctx,logo,opts.title||"NOMEAÇÃO");
  const date=opts.date||"";
  const time=opts.time||"";
  if(date||time){text(ctx,date,235,235,500,28,"#fff","left",800);if(time)text(ctx,time,820,235,150,28,"#e7b63d","right",800)}
  text(ctx,g.competition||opts.competition||"",58,315,960,40,"#e7b63d","left",900);
  text(ctx,opts.phase||g.phase||"",58,365,960,24,"#fff","left",700);
  drawMatch(ctx,opts.home||g.home||"Equipa da casa",opts.away||g.away||"Equipa visitante",await getCrest(opts.home||g.home||""),await getCrest(opts.away||g.away||""));
  let y=960;
  const officials=opts.officials||g.officials.map((name,i)=>({name,role:roleFor(g.competition,g.mode,i+1)}));
  const count=officials.length;
  const cardH=count<=1?480:count===2?330:260;
  for(let i=0;i<Math.min(count,4);i++){await drawOfficialCard(ctx,officials[i],40,y,1000,cardH,officials[i].role);y+=cardH+20}
  if(opts.observer){
    await drawOfficialCard(ctx,{name:opts.observer},40,y,1000,330,"Observador");y+=350;
  }
  text(ctx,"TRABALHO, COMPETÊNCIA E DEDICAÇÃO",540,1840,960,26,"#fff","center",800);
  text(ctx,"/NAFMARQUES_BOM",540,1880,500,20,"#e7b63d","center",700);
  return canvas;
}
function downloadCanvas(canvas,name){
  return new Promise(resolve=>canvas.toBlob(blob=>{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);resolve(blob)},"image/jpeg",.94));
}
async function generateGame(g,index){
  const canvas=await renderCanvas(g);
  const name=safeFile(`${String(index+1).padStart(2,"0")}_${g.game}`)+".jpg";
  const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",.94));
  return {name,blob,canvas};
}
async function generateAll(download=true){
  if(!state.games.length)return;
  $("#pdfActions").classList.add("hidden");
  showStatus($("#pdfStatus"),"A gerar as nomeações…");
  state.generated=[];
  for(let i=0;i<state.games.length;i++){
    const g=state.games[i];
    const r=await generateGame(g,i);state.generated.push(r);
    if(download){const a=document.createElement("a");a.href=URL.createObjectURL(r.blob);a.download=r.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
    // Observer is a separate JPG only if observer is in the list.
    if(g.observer){
      const obs={...g,officials:[],observer:g.observer};
      const c=await renderCanvas(obs,{title:"NOMEAÇÃO",observer:g.observer});
      const b=await new Promise(res=>c.toBlob(res,"image/jpeg",.94));
      const n=safeFile(`${String(i+1).padStart(2,"0")}_${g.game}_OBSERVADOR`)+".jpg";
      state.generated.push({name:n,blob:b,canvas:c});
      if(download){const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
    }
  }
  showStatus($("#pdfStatus"),`${state.generated.length} JPG(s) gerado(s).`);
  $("#pdfActions").classList.remove("hidden");
}
async function zipAll(){
  if(!state.generated.length) await generateAll(false);
  const zip=new JSZip();state.generated.forEach(x=>zip.file(x.name,x.blob));
  const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="Nomeacoes_Marques_Bom_JPG.zip";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function setupManual(){
  const box=$("#manualOfficials");box.innerHTML="";
  for(let i=0;i<4;i++){const t=$("#officialTemplate").content.cloneNode(true);t.querySelector(".official-name").value="";t.querySelector(".official-role").value="";box.appendChild(t)}
}
async function manualGenerate(){
  const names=$$(".official-name").map(x=>cleanName(x.value)).filter(Boolean);
  const roles=$$(".official-role").map(x=>cleanName(x.value));
  const competition=cleanName($("#mCompetition").value), model=$("#mModel").value;
  let mode=/FUTSAL/i.test(competition)?"FUTSAL":"FUTEBOL";
  const compObj={competition,mode,game:`${cleanName($("#mHome").value)} - ${cleanName($("#mAway").value)}`,officials:[]};
  names.forEach((n,i)=>compObj.officials.push({name:n,role:roles[i]||roleFor(competition,mode,i+1)}));
  const selected=$("#manualPhotoFiles").files; for(const f of selected){const url=URL.createObjectURL(f);try{const im=await loadImage(url);const key=norm(f.name.replace(/\.[^.]+$/,""));imgCache.set("manual:"+key,im)}catch(_){}}
  if(model==="observer"){compObj.officials=[];compObj.observer=names[0]||""}
  const c=await renderCanvas(compObj,{date:$("#mDate").value,time:$("#mTime").value,phase:$("#mPhase").value,home:$("#mHome").value,away:$("#mAway").value,officials:compObj.officials,observer:compObj.observer||""});
  const name=safeFile(`Manual_${compObj.game}`)+".jpg";const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",.94));
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  $("#manualPreview").innerHTML="";const wrap=document.createElement("div");wrap.className="preview-wrap";const im=document.createElement("img");im.src=URL.createObjectURL(blob);wrap.appendChild(im);$("#manualPreview").appendChild(wrap);
  showStatus($("#manualStatus"),"JPG criado.");
}
function switchTab(tab){
  $$(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  $("#pdfPanel").classList.toggle("hidden",tab!=="pdf");$("#manualPanel").classList.toggle("hidden",tab!=="manual");
}
async function loadExample(){
  try{const r=await fetch("./NI%20162%20RET.pdf");const b=await r.blob();const f=new File([b],"NI 162 RET.pdf",{type:"application/pdf"});const dt=new DataTransfer();dt.items.add(f);$("#pdfFile").files=dt.files;$("#nameList").value="Nuno Guerra\nGonçalo Rosa\nFernando Lopes";showStatus($("#pdfStatus"),"Exemplo carregado. Agora clica em Analisar PDF.");}catch(e){showStatus($("#pdfStatus"),"Não foi possível carregar o exemplo: "+e.message,true)}
}
document.addEventListener("DOMContentLoaded",async()=>{
  await initBackground();setupManual();
  $$(".tab").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab)));
  $("#analyseBtn").addEventListener("click",analyse);$("#loadExampleBtn").addEventListener("click",loadExample);
  $("#generateAllBtn").addEventListener("click",()=>generateAll(true));$("#downloadZipBtn").addEventListener("click",zipAll);
  $("#manualGenerateBtn").addEventListener("click",manualGenerate);
});
