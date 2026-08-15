import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import JSZip from "jszip";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);
const state = {
  pages: [],
  games: [],
  names: new Map(),
  assets: new Map()
};

function normalizeText(v="") {
  return String(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª°]/g, "")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function compact(v=""){ return normalizeText(v).replace(/\s+/g,""); }
function safeFile(v=""){ return String(v).replace(/[<>:"/\\|?*\u0000-\u001F]/g,"").replace(/\s+/g," ").trim(); }
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function setStatus(s){ $("status").textContent=s; $("error").textContent=""; }
function setError(s){ $("error").textContent=s; $("status").textContent=""; }

function findListedName(text) {
  const n=normalizeText(text);
  const entries=[...state.names.entries()].sort((a,b)=>b[0].length-a[0].length);
  for(const [key,original] of entries){
    const p=new RegExp(`(^|\\s)${escapeRegExp(key).replace(/\\s+/g,"\\s+")}(?=\\s|$)`,"i");
    if(p.test(n)) return original;
  }
  return null;
}

function isObserver(t){ return /^OBSV\s*:/i.test(t.trim()); }
function isVAR(t){ return /^(VAR|AVAR)\s*:/i.test(t.trim()); }
function isHeader(t){ return normalizeText(t)==="jogo arbitro associacao"; }
function isMeta(t){ return /^(NOTA INFORMATIVA|N\.?\s*:|DATA\s*:|NI\s+)/i.test(t.trim()); }

function isCompetition(t) {
  const n=normalizeText(t);
  if(!n || isHeader(t) || isObserver(t) || isVAR(t) || isMeta(t)) return false;
  return /\b(liga|campeonato|taca|supertaca|sub-\d+|futsal|futebol de praia)\b/i.test(n)
    && !/\bA\.?\s*F\.?\b/i.test(t);
}
function detectModality(c=""){
  const n=normalizeText(c);
  if(n.includes("liga 3 placard")) return "FUTEBOL";
  if(n.includes("futsal") || n==="liga placard" || n.includes("liga feminina placard")) return "FUTSAL";
  return "FUTEBOL";
}
function isLiga3BPI(c=""){
  const n=normalizeText(c);
  return n.includes("liga 3") || n.includes("liga bpi");
}

/* The FPF header gives the real X positions. We learn them for every table. */
function headerColumns(items){
  const out={team:null,official:null,assoc:null};
  for(const it of items){
    const n=normalizeText(it.text);
    if(n==="jogo") out.team=it.x;
    else if(n==="arbitro") out.official=it.x;
    else if(n==="associacao") out.assoc=it.x;
  }
  return out;
}
function assignColumns(line,anchors){
  if(!anchors || [anchors.team,anchors.official,anchors.assoc].some(v=>v==null))
    return {team:[],official:[],assoc:[]};
  const cols={team:[],official:[],assoc:[]};
  for(const it of line.items){
    const choices=[
      ["team",Math.abs(it.x-anchors.team)],
      ["official",Math.abs(it.x-anchors.official)],
      ["assoc",Math.abs(it.x-anchors.assoc)]
    ].sort((a,b)=>a[1]-b[1]);
    cols[choices[0][0]].push(it.text);
  }
  return cols;
}
function lineColumns(line,anchors){
  const c=assignColumns(line,anchors);
  return {
    team:c.team.join(" ").replace(/\s+/g," ").trim(),
    official:c.official.join(" ").replace(/\s+/g," ").trim(),
    assoc:c.assoc.join(" ").replace(/\s+/g," ").trim()
  };
}
function isGameLine(line,anchors){
  const c=lineColumns(line,anchors);
  return Boolean(c.team && c.official && /^A\.?\s*F\.?/i.test(c.assoc) && /\s-\s/.test(c.team));
}
function splitGameLine(line,anchors){
  const c=lineColumns(line,anchors);
  const dash=c.team.indexOf(" - ");
  if(dash<0) return null;
  return {home:c.team.slice(0,dash).trim(),away:c.team.slice(dash+3).trim(),firstOfficial:c.official};
}

async function extractPDF(file){
  const data=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data}).promise;
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const content=await page.getTextContent({normalizeWhitespace:true,disableCombineTextItems:true});
    const items=content.items
      .filter(i=>i.str?.trim())
      .map(i=>({text:i.str.trim(),x:i.transform[4],y:i.transform[5],width:i.width||0}));
    items.sort((a,b)=>b.y-a.y||a.x-b.x);
    const groups=[];
    const tol=3.5;
    for(const it of items){
      let g=groups.find(x=>Math.abs(x.y-it.y)<=tol);
      if(!g){g={y:it.y,items:[]};groups.push(g);}
      g.items.push(it);
    }
    const lines=groups
      .sort((a,b)=>b.y-a.y)
      .map(g=>{
        g.items.sort((a,b)=>a.x-b.x);
        return {text:g.items.map(i=>i.text).join(" ").replace(/\s+/g," ").trim(),items:g.items};
      })
      .filter(x=>x.text);
    pages.push({page:p,lines});
  }
  return {numPages:pdf.numPages,pages};
}

/*
  IMPORTANT ROLE RULE:
  The role index is based on every referee line in the PDF, not only names
  that happen to be in the user's list. This is what guarantees that if the
  second referee is Nuno Guerra, he remains 4.º Árbitro in Liga 3/BPI.
*/
function roleForSequence(competition, index){
  const mod=detectModality(competition);
  if(mod==="FUTSAL"){
    return index===0 ? "Árbitro"
      : index===1 ? "2.º Árbitro"
      : index===2 ? "3.º Árbitro"
      : index===3 ? "Cronometrista"
      : "Oficial";
  }
  if(isLiga3BPI(competition)){
    return index===0 ? "Árbitro"
      : index===1 ? "4.º Árbitro"
      : index===2 ? "Assistente 1"
      : index===3 ? "Assistente 2"
      : "Oficial";
  }
  return index===0 ? "Árbitro" : "Oficial";
}

function parsePage(page){
  const games=[];
  let competition="";
  let anchors=null;
  let table=false;
  const lines=page.lines;

  for(let i=0;i<lines.length;i++){
    const text=lines[i].text.trim();
    if(!text) continue;

    if(isHeader(text)){
      anchors=headerColumns(lines[i].items);
      table=true;
      continue;
    }

    if(!table){
      if(isCompetition(text)) competition=text;
      continue;
    }

    if(isMeta(text)){
      table=false; anchors=null; continue;
    }

    if(isCompetition(text) && !isGameLine(lines[i],anchors)){
      competition=text; table=false; anchors=null; continue;
    }

    if(!anchors || !isGameLine(lines[i],anchors)) continue;

    const base=splitGameLine(lines[i],anchors);
    if(!base) continue;

    const officials=[];
    let observer=null;
    let officialSequence=0;
    let j=i+1;

    const firstListed=findListedName(base.firstOfficial);
    if(firstListed){
      officials.push({name:firstListed,role:roleForSequence(competition,officialSequence)});
    }
    officialSequence++;

    for(;j<lines.length;j++){
      const t=lines[j].text.trim();
      if(!t) continue;
      if(isHeader(t)||isMeta(t)) break;
      if(isCompetition(t) && !isGameLine(lines[j],anchors)) break;
      if(isGameLine(lines[j],anchors)) break;

      if(isObserver(t)){
        const listed=findListedName(t.replace(/^OBSV\s*:/i,""));
        if(listed) observer={name:listed,role:"Observador"};
        continue;
      }
      if(isVAR(t)) continue;

      const c=lineColumns(lines[j],anchors);
      if(c.official && /^A\.?\s*F\.?/i.test(c.assoc)){
        const listed=findListedName(c.official);
        if(listed){
          officials.push({name:listed,role:roleForSequence(competition,officialSequence)});
        }
        officialSequence++;
      }
    }

    if(observer) officials.push(observer);

    if(officials.length){
      games.push({
        competition,
        home:base.home,
        away:base.away,
        officials,
        page:page.page
      });
    }
    i=j-1;
  }
  return games;
}

function parsePages(pages){
  const out=[];
  for(const p of pages) out.push(...parsePage(p));
  return out;
}

/* -------------------- Assets -------------------- */

function tryImage(url){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=()=>resolve(null);
    img.src=url;
  });
}
async function loadFirst(key,urls){
  for(const u of urls){
    const img=await tryImage(u+"?v=3");
    if(img){state.assets.set(key,img);return img;}
  }
  return null;
}
async function loadIdentity(){
  await loadFirst("logo",[
    "/fotografias/logo.jpeg",
    "/fotografias/logo.png",
    "/fotografias/logo.jpg"
  ]);
  await loadFirst("background",["/assets/fundo_nomeacao.png"]);
}
function personUrls(name){
  const f=safeFile(name);
  return [
    `/fotografias/${f}.jpg`,
    `/fotografias/${f}.jpeg`,
    `/fotografias/${f}.png`,
    `/fotografias/${f}.webp`
  ];
}
async function personImage(name){
  const key="p:"+compact(name);
  if(state.assets.has(key)) return state.assets.get(key);
  const img=await loadFirst(key,personUrls(name));
  return img;
}
function teamVariants(team){
  const clean=team.trim();
  const variants=new Set([
    clean,
    clean.replace(/\bSAD\b/ig,"").replace(/\bSDUQ\b/ig,"").replace(/\s+/g," ").trim(),
    clean.replace(/[,.]/g,"").trim()
  ]);
  return [...variants].filter(Boolean);
}
async function shieldImage(team){
  const key="s:"+compact(team);
  if(state.assets.has(key)) return state.assets.get(key);
  for(const v of teamVariants(team)){
    const f=safeFile(v);
    for(const ext of ["png","jpg","jpeg","webp"]){
      const img=await tryImage(`/escudos/${f}.${ext}?v=3`);
      if(img){state.assets.set(key,img);return img;}
    }
  }
  return null;
}
function fileToImage(file){
  return new Promise((resolve,reject)=>{
    const u=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{URL.revokeObjectURL(u);resolve(img);};
    img.onerror=reject;
    img.src=u;
  });
}

/* -------------------- Canvas design -------------------- */

function drawContain(ctx,img,x,y,w,h){
  if(!img) return;
  const iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
  const s=Math.min(w/iw,h/ih);
  const dw=iw*s, dh=ih*s;
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
}
function drawCover(ctx,img,x,y,w,h,r=0){
  if(!img) return;
  const iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
  const s=Math.max(w/iw,h/ih);
  const dw=iw*s, dh=ih*s;
  ctx.save();
  if(r){
    ctx.beginPath();
    ctx.roundRect(x,y,w,h,r);
    ctx.clip();
  }
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  ctx.restore();
}
function roundedPanel(ctx,x,y,w,h,fill="rgba(8,18,24,.80)",stroke="rgba(231,182,61,.70)"){
  ctx.save();
  ctx.fillStyle=fill;
  ctx.beginPath();ctx.roundRect(x,y,w,h,28);ctx.fill();
  ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();
  ctx.restore();
}
function wrapLines(ctx,text,maxWidth,maxLines=2){
  const words=String(text).split(/\s+/);
  const lines=[]; let line="";
  for(const word of words){
    const test=line?line+" "+word:word;
    if(ctx.measureText(test).width<=maxWidth) line=test;
    else {if(line) lines.push(line);line=word;}
  }
  if(line) lines.push(line);
  return lines.slice(0,maxLines);
}
function fitFont(ctx,text,maxWidth,start,min=20,weight=700){
  let s=start;
  while(s>min){
    ctx.font=`${weight} ${s}px Arial`;
    if(ctx.measureText(text).width<=maxWidth) return s;
    s-=2;
  }
  return s;
}
function centerText(ctx,text,x,y,size,color="#f5f7f8",weight=700){
  ctx.save();
  ctx.textAlign="center";
  ctx.fillStyle=color;
  ctx.font=`${weight} ${size}px Arial`;
  ctx.fillText(text,x,y);
  ctx.restore();
}
function drawCompetition(ctx,competition,y){
  const lines=[];
  ctx.font="700 38px Arial";
  lines.push(...wrapLines(ctx,competition,900,2));
  lines.forEach((line,i)=>{
    centerText(ctx,line,540,y+i*44,38,"#e7b63d",700);
  });
  return y+lines.length*44;
}
function drawGame(ctx,game,homeShield,awayShield,y){
  const h=260;
  roundedPanel(ctx,45,y,990,h,"rgba(9,22,29,.72)","rgba(231,182,61,.62)");

  drawContain(ctx,homeShield,80,y+42,180,175);
  drawContain(ctx,awayShield,820,y+42,180,175);

  ctx.save();
  ctx.textAlign="center";
  ctx.fillStyle="#f5f7f8";
  const homeSize=fitFont(ctx,game.home,510,34,22);
  ctx.font=`700 ${homeSize}px Arial`;
  const homeLines=wrapLines(ctx,game.home,510,2);
  homeLines.forEach((l,i)=>ctx.fillText(l,540,y+82+i*(homeSize+5)));

  ctx.fillStyle="#e7b63d";ctx.font="700 36px Arial";
  ctx.fillText("VS",540,y+166);

  ctx.fillStyle="#f5f7f8";
  const awaySize=fitFont(ctx,game.away,510,34,22);
  ctx.font=`700 ${awaySize}px Arial`;
  const awayLines=wrapLines(ctx,game.away,510,2);
  awayLines.forEach((l,i)=>ctx.fillText(l,540,y+212+i*(awaySize+4)));
  ctx.restore();

  return y+h;
}
function drawOfficialCard(ctx,o,photo,x,y,w,h){
  roundedPanel(ctx,x,y,w,h,"rgba(8,17,22,.84)","rgba(231,182,61,.55)");
  const photoSize=Math.min(h-30,190);
  const px=x+24, py=y+(h-photoSize)/2;

  if(photo){
    ctx.save();
    ctx.beginPath();ctx.arc(px+photoSize/2,py+photoSize/2,photoSize/2,0,Math.PI*2);ctx.clip();
    drawCover(ctx,photo,px,py,photoSize,photoSize,0);
    ctx.restore();
    ctx.save();ctx.beginPath();ctx.arc(px+photoSize/2,py+photoSize/2,photoSize/2+5,0,Math.PI*2);
    ctx.strokeStyle="#e7b63d";ctx.lineWidth=4;ctx.stroke();ctx.restore();
  } else {
    ctx.fillStyle="#26343b";ctx.beginPath();ctx.arc(px+photoSize/2,py+photoSize/2,photoSize/2,0,Math.PI*2);ctx.fill();
  }

  const tx=px+photoSize+55;
  ctx.fillStyle="#e7b63d";ctx.font=`700 ${h<190?22:27}px Arial`;
  ctx.fillText(o.role.toUpperCase(),tx,y+70);

  const maxW=w-photoSize-95;
  const nameSize=fitFont(ctx,o.name,maxW,h<190?36:46,22);
  ctx.fillStyle="#f5f7f8";ctx.font=`700 ${nameSize}px Arial`;
  const lines=wrapLines(ctx,o.name,maxW,2);
  lines.forEach((l,i)=>ctx.fillText(l,tx,y+125+i*(nameSize+6)));
}
async function render(game){
  const canvas=document.createElement("canvas");
  canvas.width=1080;canvas.height=1920;
  const ctx=canvas.getContext("2d");

  const bg=state.assets.get("background");
  if(bg) ctx.drawImage(bg,0,0,1080,1920);
  else {ctx.fillStyle="#16262e";ctx.fillRect(0,0,1080,1920);}

  /* Dark overlay keeps the information readable without changing the base art. */
  ctx.fillStyle="rgba(3,10,14,.24)";
  ctx.fillRect(0,0,1080,1920);

  const logo=state.assets.get("logo");
  if(logo) drawContain(ctx,logo,45,35,145,145);

  ctx.fillStyle="#f5f7f8";ctx.font="700 18px Arial";
  ctx.fillText("NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM · COIMBRA",215,62);

  ctx.fillStyle="#f5f7f8";ctx.font="700 70px Arial";
  ctx.fillText("NOMEAÇÃO",215,142);

  let y=195;
  if(game.date){
    roundedPanel(ctx,45,y,990,76,"rgba(7,16,21,.78)","rgba(231,182,61,.62)");
    centerText(ctx,game.date,540,y+51,28,"#f5f7f8",700);
    y+=102;
  }

  y=drawCompetition(ctx,game.competition,y+35)+24;
  const [homeShield,awayShield]=await Promise.all([
    shieldImage(game.home),shieldImage(game.away)
  ]);
  y=drawGame(ctx,game,homeShield,awayShield,y+10)+28;

  const count=game.officials.length;
  const gap=12;
  const available=1920-y-115;
  const cardH=Math.max(135,Math.min(250,(available-(count-1)*gap)/Math.max(count,1)));
  for(let i=0;i<count;i++){
    const o=game.officials[i];
    const photo=await personImage(o.name);
    drawOfficialCard(ctx,o,photo,45,y,990,cardH);
    y+=cardH+gap;
  }

  const footerY=Math.min(1845,y+18);
  ctx.strokeStyle="rgba(231,182,61,.70)";ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(65,footerY);ctx.lineTo(1015,footerY);ctx.stroke();
  centerText(ctx,"TRABALHO, COMPETÊNCIA E DEDICAÇÃO",540,footerY+48,24,"#f5f7f8",700);
  centerText(ctx,"@NAFMARQUES_BOM  ·  #MARQUESBOM  ·  #ARBITRAGEM  ·  #NOMEAÇÕES",540,footerY+82,14,"#e7b63d",700);

  return canvas;
}

/* -------------------- Validation / UI -------------------- */

function showGames(){
  $("results").innerHTML=state.games.map((g,i)=>`
    <div class="result">
      <b>${i+1}. ${escapeHtml(g.home)}</b> <span>vs</span> <b>${escapeHtml(g.away)}</b>
      <span class="tag">${escapeHtml(g.competition)}</span>
      <p>${g.officials.map(o=>escapeHtml(o.name)+" — "+escapeHtml(o.role)).join("<br>")}</p>
    </div>
  `).join("");
}

async function checkAssets(games){
  await loadIdentity();
  const missing=[];
  if(!state.assets.has("logo")) missing.push({type:"logo",key:"logo"});
  for(const g of games){
    if(!await shieldImage(g.home)) missing.push({type:"escudo",key:g.home});
    if(!await shieldImage(g.away)) missing.push({type:"escudo",key:g.away});
    for(const o of g.officials){
      if(!await personImage(o.name)) missing.push({type:"foto",key:o.name});
    }
  }
  if(missing.length){renderMissing(missing);return false;}
  $("missingAssets").hidden=true;
  return true;
}

function renderMissing(items){
  const unique=[...new Map(items.map(x=>[x.type+":"+compact(x.key),x])).values()];
  $("missingAssets").hidden=false;
  $("missingAssets").innerHTML=`
    <div class="missingBox">
      <h3>Faltam ficheiros antes de gerar</h3>
      <p>O gerador bloqueia a criação para não sair uma publicação incompleta.</p>
      ${unique.map(x=>`
        <div class="missingRow">
          <span><b>${x.type==="foto"?"Fotografia":x.type==="escudo"?"Escudo":"Logo"}</b>: ${escapeHtml(x.key)}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-key="${escapeHtml(x.type+"|"+x.key)}">
        </div>`).join("")}
      <button id="useMissing" class="secondary">Usar ficheiros nesta sessão</button>
    </div>`;

  $("useMissing").onclick=async()=>{
    for(const input of $("missingAssets").querySelectorAll("input[type=file]")){
      if(!input.files[0]) continue;
      const [type,key]=input.dataset.key.split("|");
      const img=await fileToImage(input.files[0]);
      state.assets.set(type==="foto"?"p:"+compact(key):type==="escudo"?"s:"+compact(key):"logo",img);
    }
    setStatus("Ficheiros carregados para esta sessão. Podes gerar novamente.");
  };
}

async function analyze(){
  const file=$("pdfFile").files[0];
  if(!file) return setError("Escolhe primeiro o PDF da FPF.");

  const names=$("names").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!names.length) return setError("Coloca pelo menos um nome na lista.");

  state.names=new Map(names.map(n=>[compact(n),n]));
  state.games=[];
  $("generateBtn").disabled=true;
  $("results").innerHTML="";
  $("missingAssets").hidden=true;
  setStatus("A ler o PDF e a reconstruir as tabelas da FPF...");

  try{
    const data=await extractPDF(file);
    state.pages=data.pages;
    state.games=parsePages(data.pages);
    if(!state.games.length){
      return setError(`PDF lido (${data.numPages} páginas), mas não foi encontrado nenhum jogo com os nomes indicados.`);
    }
    showGames();
    $("generateBtn").disabled=false;
    setStatus(`PDF lido: ${data.numPages} página(s). Encontrados ${state.games.length} jogo(s).`);
  }catch(e){
    console.error(e);
    setError("Erro ao ler o PDF: "+(e?.message||e));
  }
}

async function generateAll(){
  if(!state.games.length) return;
  const ok=await checkAssets(state.games);
  if(!ok) return;

  setStatus("A gerar os JPG com o modelo gráfico do Núcleo...");
  const zip=new JSZip();

  for(let i=0;i<state.games.length;i++){
    const g=state.games[i];
    const canvas=await render(g);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.96));
    const filename=safeFile(`${String(i+1).padStart(2,"0")} - ${g.home} vs ${g.away}.jpg`).slice(0,150);
    zip.file(filename,blob);
    setStatus(`A gerar JPG ${i+1}/${state.games.length}...`);
  }

  const blob=await zip.generateAsync({type:"blob"});
  download(blob,"Nomeacoes_Marques_Bom.zip");
  setStatus(`Concluído: ${state.games.length} JPG(s) gerados.`);
}

async function generateManual(){
  const home=$("mHome").value.trim();
  const away=$("mAway").value.trim();
  const competition=$("mCompetition").value.trim();
  if(!home||!away||!competition) return setError("Preenche competição e as duas equipas.");

  const officials=[...document.querySelectorAll(".manualOfficial")]
    .map(r=>({
      name:r.querySelector(".mName").value.trim(),
      role:r.querySelector(".mRole").value.trim()||"Árbitro"
    }))
    .filter(x=>x.name);

  if(!officials.length) return setError("Adiciona pelo menos um oficial.");

  const g={home,away,competition,officials};
  if($("mDate").value.trim()) g.date=$("mDate").value.trim();

  const ok=await checkAssets([g]);
  if(!ok) return;

  setStatus("A gerar a nomeação manual...");
  const canvas=await render(g);
  const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",0.96));
  download(blob,safeFile(`${home} vs ${away}.jpg`));
  setStatus("Nomeação manual gerada.");
}

function download(blob,name){
  const u=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=u;a.download=name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}

function addManualOfficial(role="Árbitro"){
  const row=document.createElement("div");
  row.className="manualOfficial";
  row.innerHTML=`<input class="mName" placeholder="Nome"><input class="mRole" value="${escapeHtml(role)}"><button type="button">×</button>`;
  row.querySelector("button").onclick=()=>row.remove();
  $("manualOfficials").appendChild(row);
}
function route(){
  const manual=location.hash==="#manual";
  $("pdfSection").hidden=manual;
  $("manualSection").hidden=!manual;
  $("pdfBtn").classList.toggle("active",!manual);
  $("manualBtn").classList.toggle("active",manual);
}
async function init(){
  await loadIdentity();
  $("analyzeBtn").onclick=analyze;
  $("generateBtn").onclick=generateAll;
  $("pdfFile").onchange=e=>$("fileName").textContent=e.target.files[0]?.name||"";
  $("manualBtn").onclick=()=>location.hash="#manual";
  $("pdfBtn").onclick=()=>location.hash="#pdf";
  $("addOfficial").onclick=()=>addManualOfficial();
  $("manualGenerate").onclick=generateManual;
  addManualOfficial();
  window.onhashchange=route;
  route();
}
init();
