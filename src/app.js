
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import JSZip from "jszip";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);
const state = {
  pdfFile: null,
  pages: [],
  games: [],
  names: new Map(),
  localImages: new Map(),
};

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª°]/g, "")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value="") {
  return normalizeText(value).replace(/\s+/g, "");
}

function displayName(name="") {
  return name.replace(/\s+/g, " ").trim();
}

function isAssociation(text="") {
  return /\bA\.?\s*F\.?\s*[A-ZÁÉÍÓÚÀÂÊÔÃÕÇÜ ]+/i.test(text);
}

function isObserver(text="") {
  return /^OBSV\s*:/i.test(text.trim());
}

function isVAR(text="") {
  return /^(VAR|AVAR)\s*:/i.test(text.trim());
}

function isHeader(text="") {
  const n = normalizeText(text);
  return n === "jogo arbitro associacao" || n === "jogo arbitro associacao";
}

function isCompetition(text="") {
  const n = normalizeText(text);
  if (!n) return false;
  if (isHeader(text) || isObserver(text) || isVAR(text)) return false;
  return /(liga|campeonato|taca|supertaça|supertaca|sub-\d+|futsal|futebol de praia)/i.test(text)
    && !/\bA\.?\s*F\.?\b/i.test(text);
}


function columnsForLine(line) {
  const items = line.items || [];
  const cols = {team:[], official:[], assoc:[]};
  for (const it of items) {
    if (it.x < 285) cols.team.push(it.text);
    else if (it.x < 460) cols.official.push(it.text);
    else cols.assoc.push(it.text);
  }
  return {
    team: cols.team.join(" ").replace(/\s+/g," ").trim(),
    official: cols.official.join(" ").replace(/\s+/g," ").trim(),
    assoc: cols.assoc.join(" ").replace(/\s+/g," ").trim()
  };
}

function isGameLine(line) {
  const c = columnsForLine(line);
  return Boolean(c.team && c.official && /^A\.?\s*F\.?/i.test(c.assoc) && /\s-\s/.test(c.team));
}

function splitGameLine(line) {
  const c = columnsForLine(line);
  if (!c.team || !c.official) return null;
  const dash = c.team.indexOf(" - ");
  if (dash < 0) return null;
  return {
    home: c.team.slice(0,dash).trim(),
    away: c.team.slice(dash+3).trim(),
    firstOfficial: c.official,
    association: c.assoc
  };
}

function parseListedOfficial(text, namesMap) {
  return findListedName(text, namesMap);
}

function extractOfficialsFromRows(rows, namesMap, competition) {
  const officials = [];
  let observer = null;
  let i = 0;
  while (i < rows.length) {
    const line = rows[i].text.trim();
    if (!line) { i++; continue; }
    if (isObserver(line)) {
      const raw = line.replace(/^OBSV\s*:/i, "").trim();
      const key = compact(raw);
      const match = findListedName(raw, namesMap);
      if (match) observer = {name: match, role:"Observador", raw};
      i++; continue;
    }
    if (isVAR(line)) { i++; continue; }

    const officialLine = isAssociation(line);
    if (officialLine) {
      const match = findListedName(line, namesMap);
      if (match) {
        // Determine role from the sequence within the game.
        const modality = detectModality(competition);
        const roleIndex = officials.length;
        let role = "Árbitro";
        if (modality === "FUTSAL") {
          if (roleIndex === 1) role = "2.º Árbitro";
          else if (roleIndex === 2) role = "3.º Árbitro";
          else if (roleIndex === 3) role = "Cronometrista";
        } else if (roleIndex === 1 && isBPIorLiga3(competition)) {
          role = "4.º Árbitro";
        } else if (roleIndex === 1) {
          role = "Assistente";
        } else if (roleIndex === 2) {
          role = "Assistente";
        }
        officials.push({name: match, role});
      }
    } else if (rows[i].text && !isGameLine(rows[i].text) && i > 0) {
      // Referee continuation rows (same game) are association-only lines.
    }
    i++;
  }
  if (observer) officials.push(observer);
  return officials;
}

function findListedName(text, namesMap) {
  const n = normalizeText(text);
  // Longest first to avoid partial matches.
  const entries = [...namesMap.entries()].sort((a,b)=>b[0].length-a[0].length);
  for (const [key, original] of entries) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(key).replace(/\s+/g,"\\s+")}(?=\\s|$)`, "i");
    if (pattern.test(n)) return original;
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectModality(competition="") {
  const n = normalizeText(competition);
  if (n.includes("liga 3 placard")) return "FUTEBOL";
  if (n.includes("futsal") || n.includes("liga placard") || n.includes("liga feminina placard")) return "FUTSAL";
  return "FUTEBOL";
}

function isBPIorLiga3(competition="") {
  const n = normalizeText(competition);
  return n.includes("liga 3") || n.includes("liga bpi");
}

function parseNameFromGameLine(line, namesMap) {
  const match = findListedName(line, namesMap);
  return match;
}


function parseGameAndFollowing(lines, start, competition, namesMap) {
  const first = lines[start];
  const parts = splitGameLine(first);
  if (!parts) return null;

  const officials = [];
  const listedFirst = parseListedOfficial(parts.firstOfficial, namesMap);
  if (listedFirst) officials.push({name:listedFirst, role:"Árbitro"});

  let observer = null;
  let j = start + 1;
  while (j < lines.length) {
    const line = lines[j].text.trim();
    if (!line) { j++; continue; }
    if (isGameLine(lines[j])) break;
    if (isHeader(line)) break;
    // A competition title starts the next table. We only accept it after at least
    // one line of the current table has been consumed.
    if (isCompetition(line)) break;
    if (/^NOTA INFORMATIVA/i.test(line) || /^N\.?:/i.test(line) || /^DATA:/i.test(line) || /^NI /i.test(line)) break;

    const c = columnsForLine(lines[j]);
    if (isObserver(line)) {
      const raw = line.replace(/^OBSV\s*:/i,"").trim();
      const listed = findListedName(raw, namesMap);
      if (listed) observer = {name:listed, role:"Observador"};
      j++; continue;
    }
    if (isVAR(line)) { j++; continue; }

    if (c.official && /^A\.?\s*F\.?/i.test(c.assoc)) {
      const listed = findListedName(c.official, namesMap);
      if (listed) {
        const idx = officials.length;
        const modality = detectModality(competition);
        let role;
        if (modality === "FUTSAL") {
          role = idx===1 ? "2.º Árbitro" : idx===2 ? "3.º Árbitro" : idx===3 ? "Cronometrista" : "Árbitro";
        } else if (isBPIorLiga3(competition)) {
          role = idx===1 ? "4.º Árbitro" : idx===2 ? "Assistente 1" : idx===3 ? "Assistente 2" : "Oficial";
        } else {
          role = idx===1 ? "Assistente 1" : idx===2 ? "Assistente 2" : "Oficial";
        }
        officials.push({name:listed, role});
      }
    }
    j++;
  }

  if (observer) officials.push(observer);
  return {
    competition: competition.trim(),
    home: parts.home,
    away: parts.away,
    officials,
    startIndex:start,
    endIndex:j
  };
}


function parsePages(pages, namesMap) {
  const games = [];
  for (const page of pages) {
    const lines = page.lines;
    let pendingTitle = [];
    let competition = "";
    let inTable = false;

    for (let i=0;i<lines.length;i++) {
      const line = lines[i].text.trim();
      if (!line) continue;

      if (isHeader(line)) {
        if (pendingTitle.length) competition = pendingTitle.join(" ").replace(/\s+/g," ").trim();
        pendingTitle = [];
        inTable = true;
        continue;
      }

      if (!inTable) {
        if (isCompetition(line)) {
          pendingTitle = [line];
        } else if (pendingTitle.length && !/^NOTA INFORMATIVA/i.test(line) && !/^N\.?:/i.test(line) && !/^DATA:/i.test(line) && !/^NI /i.test(line)) {
          // FPF sometimes wraps a competition title over two or more PDF lines.
          pendingTitle.push(line);
        }
        continue;
      }

      if (isGameLine(lines[i])) {
        const game = parseGameAndFollowing(lines, i, competition, namesMap);
        if (game && game.officials.length) {
          games.push(game);
          i = Math.max(i, game.endIndex-1);
        }
        continue;
      }

      if (/^NOTA INFORMATIVA/i.test(line)) {
        inTable = false;
        pendingTitle = [];
        continue;
      }

      // A new competition title can occur immediately after a table when there
      // was no note footer. Close the old table and accumulate the new title.
      if (isCompetition(line)) {
        inTable = false;
        pendingTitle = [line];
      }
    }
  }
  return games;
}

async function extractPDF(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data:buffer}).promise;
  const pages = [];
  for (let p=1;p<=pdf.numPages;p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({normalizeWhitespace:true, disableCombineTextItems:true});
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({
        text: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: it.height || 0
      }));
    items.sort((a,b)=> b.y-a.y || a.x-b.x);
    const groups=[];
    const tolerance=3.5;
    for (const item of items) {
      let g=groups.find(q=>Math.abs(q.y-item.y)<=tolerance);
      if (!g) { g={y:item.y, items:[]}; groups.push(g); }
      g.items.push(item);
    }
    const lines=groups
      .sort((a,b)=>b.y-a.y)
      .map(g=>{
        g.items.sort((a,b)=>a.x-b.x);
        return {text:g.items.map(x=>x.text).join(" ").replace(/\s+/g," ").trim(), items:g.items};
      })
      .filter(x=>x.text);
    pages.push({page:p, lines});
  }
  return {numPages:pdf.numPages,pages};
}

async function loadLocalAssets() {
  const paths = [
    ["logo", "/fotografias/logo.png"],
    ["background", "/assets/fundo_nomeacao.png"]
  ];
  for (const [key,url] of paths) {
    const img = new Image();
    img.src = url + "?v=" + Date.now();
    try { await img.decode(); state.localImages.set(key,img); } catch {}
  }
}

async function loadImageForPerson(name) {
  const key = normalizeText(name);
  if (state.localImages.has("person:"+key)) return state.localImages.get("person:"+key);
  const candidates = [
    `/fotografias/${safeFile(name)}.jpg`,
    `/fotografias/${safeFile(name)}.png`,
    `/fotografias/${safeFile(name)}.jpeg`,
    `/fotografias/${safeFile(name)}.webp`
  ];
  for (const url of candidates) {
    const img = await tryImage(url);
    if (img) { state.localImages.set("person:"+key,img); return img; }
  }
  return null;
}

async function loadShield(team) {
  const key=normalizeText(team);
  if (state.localImages.has("shield:"+key)) return state.localImages.get("shield:"+key);
  const aliases = teamAliases(team);
  for (const alias of aliases) {
    for (const ext of ["png","jpg","jpeg","webp"]) {
      const img=await tryImage(`/escudos/${safeFile(alias)}.${ext}`);
      if(img){ state.localImages.set("shield:"+key,img); return img; }
    }
  }
  // Intentionally no automatic web search here. A wrong club badge is worse
  // than a missing badge. The generator blocks output and asks for the correct
  // file when the local repository does not contain it.
  return null;
}

function teamAliases(team) {
  const clean=team.replace(/\s+/g," ").trim();
  const variants = new Set([clean]);
  variants.add(clean.replace(/\bSAD\b/ig,"").replace(/\bSDUQ\b/ig,"").trim());
  variants.add(clean.replace(/[,".]/g,"").trim());
  return [...variants].filter(Boolean);
}

function safeFile(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001F]/g,"").replace(/\s+/g," ").trim();
}

function tryImage(url) {
  return new Promise(resolve=>{
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>resolve(img);
    img.onerror=()=>resolve(null);
    img.src=url;
  });
}

function drawCover(ctx,img,x,y,w,h,radius=0) {
  if(!img) return false;
  const iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
  const scale=Math.max(w/iw,h/ih);
  const sw=iw*scale, sh=ih*scale;
  const sx=x+(w-sw)/2, sy=y+(h-sh)/2;
  ctx.save();
  if(radius){ ctx.beginPath(); roundRect(ctx,x,y,w,h,radius); ctx.clip(); }
  ctx.drawImage(img,sx,sy,sw,sh);
  ctx.restore();
  return true;
}

function drawContain(ctx,img,x,y,w,h) {
  if(!img) return false;
  const iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
  const scale=Math.min(w/iw,h/ih);
  const dw=iw*scale, dh=ih*scale;
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  return true;
}

function roundRect(ctx,x,y,w,h,r){
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function fitText(ctx,text,maxWidth,startSize,minSize=20,bold=true){
  let size=startSize;
  while(size>minSize){
    ctx.font=`${bold?"700":"400"} ${size}px Arial`;
    if(ctx.measureText(text).width<=maxWidth) return size;
    size-=2;
  }
  return size;
}

function drawWrapped(ctx,text,x,y,maxWidth,lineHeight,maxLines=2){
  const words=text.split(/\s+/);
  let line="", lines=[];
  for(const word of words){
    const test=line?line+" "+word:word;
    if(ctx.measureText(test).width<=maxWidth) line=test;
    else { if(line) lines.push(line); line=word; }
  }
  if(line) lines.push(line);
  lines=lines.slice(0,maxLines);
  lines.forEach((l,i)=>ctx.fillText(l,x,y+i*lineHeight));
  return lines.length;
}

async function renderNomination(game) {
  const canvas=document.createElement("canvas");
  canvas.width=1080; canvas.height=1920;
  const ctx=canvas.getContext("2d");
  const bg=state.localImages.get("background");
  if(bg) ctx.drawImage(bg,0,0,1080,1920);
  else { ctx.fillStyle="#1c282f"; ctx.fillRect(0,0,1080,1920); }

  // Header
  const logo=state.localImages.get("logo");
  if(logo) drawContain(ctx,logo,65,45,170,170);
  ctx.fillStyle="#f5f7f8";
  ctx.textAlign="left";
  ctx.font="700 20px Arial";
  ctx.fillText("NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA",260,75);
  ctx.font="700 66px Arial";
  ctx.fillText("NOMEAÇÃO",260,160);

  ctx.fillStyle="#e7b63d";
  ctx.font="700 30px Arial";
  drawWrapped(ctx,game.competition,70,280,940,40,3);
  if (game.date) {
    ctx.fillStyle="#f5f7f8";
    ctx.font="700 22px Arial";
    ctx.textAlign="right";
    ctx.fillText(game.date,1010,360);
    ctx.textAlign="left";
  }

  ctx.fillStyle="#f5f7f8";
  ctx.font="700 32px Arial";
  const home=game.home, away=game.away;
  drawWrapped(ctx,home,70,410,420,40,2);
  drawWrapped(ctx,away,590,410,420,40,2);
  ctx.textAlign="center"; ctx.fillStyle="#e7b63d"; ctx.font="700 38px Arial"; ctx.fillText("VS",540,455);
  ctx.textAlign="left";

  const [shieldHome,shieldAway]=await Promise.all([loadShield(home),loadShield(away)]);
  if(shieldHome) drawContain(ctx,shieldHome,160,500,230,230);
  else drawShieldMissing(ctx,275,615,home);
  if(shieldAway) drawContain(ctx,shieldAway,690,500,230,230);
  else drawShieldMissing(ctx,805,615,away);

  const count=game.officials.length;
  const cardH = count===1 ? 330 : count===2 ? 300 : count===3 ? 250 : count===4 ? 210 : 175;
  const startY=790;
  for(let i=0;i<count;i++){
    const o=game.officials[i];
    const y=startY+i*(cardH+20);
    ctx.fillStyle="rgba(14,24,30,0.84)";
    roundRect(ctx,45,y,990,cardH,28); ctx.fill();
    ctx.strokeStyle="rgba(231,182,61,0.42)"; ctx.lineWidth=2; ctx.stroke();
    const photo=await loadImageForPerson(o.name);
    ctx.fillStyle="#e7b63d";
    ctx.fillRect(75,y+35,220,cardH-70);
    if(photo) drawCover(ctx,photo,82,y+42,206,cardH-84,18);
    else {
      ctx.fillStyle="#60727b"; roundRect(ctx,82,y+42,206,cardH-84,18); ctx.fill();
      ctx.fillStyle="#dce3e6"; ctx.font="700 18px Arial"; ctx.textAlign="center";
      ctx.fillText("FOTOGRAFIA",185,y+cardH/2);
      ctx.textAlign="left";
    }
    ctx.fillStyle="#e7b63d"; ctx.font=`700 ${count<=2?24:20}px Arial`;
    ctx.fillText(o.role.toUpperCase(),335,y+80);
    ctx.fillStyle="#f5f7f8"; 
    const size=fitText(ctx,o.name,630,count<=2?52:42,24,true);
    ctx.font=`700 ${size}px Arial`;
    drawWrapped(ctx,o.name,335,y+150,630,size+8,2);
  }

  ctx.fillStyle="#f5f7f8"; ctx.textAlign="center"; ctx.font="700 22px Arial";
  ctx.fillText("TRABALHO, COMPETÊNCIA E DEDICAÇÃO",540,1840);
  ctx.fillStyle="#e7b63d"; ctx.font="700 16px Arial";
  ctx.fillText("#MARQUESBOM  #ARBITRAGEM  #NOMEAÇÕES",540,1875);
  ctx.textAlign="left";
  return canvas;
}

function drawShieldMissing(ctx,x,y,label){
  ctx.save();
  ctx.strokeStyle="#e7b63d"; ctx.lineWidth=3;
  ctx.beginPath(); ctx.arc(x,y,85,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle="#e7b63d"; ctx.font="700 15px Arial"; ctx.textAlign="center";
  drawWrapped(ctx,"ESCUDO EM FALTA",x,y-10,150,20,2);
  ctx.restore();
}

function resultHtml(g){
  const officials=g.officials.map(o=>`${o.name} — ${o.role}`).join("<br>");
  return `<div class="result"><div><b>${escapeHtml(g.home)}</b> <span>vs</span> <b>${escapeHtml(g.away)}</b></div><small>${escapeHtml(g.competition)}</small><p>${officials}</p></div>`;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

async function analyze() {
  const file=$("pdfFile").files[0];
  if(!file){ setError("Escolhe primeiro o PDF da FPF."); return; }
  const raw=$("names").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!raw.length){ setError("Coloca pelo menos um nome na lista de árbitros."); return; }
  state.names=new Map(raw.map(n=>[compact(n),displayName(n)]));
  setStatus("A ler o PDF e a reconstruir as linhas...");
  try{
    const data=await extractPDF(file);
    state.pages=data.pages;
    state.games=parsePages(data.pages,state.names);
    if(!state.games.length){
      setError("O PDF foi lido, mas não encontrei nenhum jogo com nomes da lista. Verifica os nomes e tenta novamente.");
      return;
    }
    $("results").innerHTML=state.games.map(resultHtml).join("");
    $("generateBtn").disabled=false;
    $("downloadAllBtn").disabled=false;
    setStatus(`PDF lido: ${data.numPages} página(s). Encontrados ${state.games.length} jogo(s).`);
  }catch(err){
    console.error(err);
    setError(`Erro ao ler o PDF: ${err.message||err}`);
  }
}


async function ensureAssetsForGames(games) {
  if (!state.localImages.get("logo")) {
    setError("Falta o logo original. Coloca public/fotografias/logo.png no GitHub e faz novo deploy.");
    return false;
  }
  const missing = [];
  for (const g of games) {
    const [home, away] = await Promise.all([loadShield(g.home), loadShield(g.away)]);
    if (!home) missing.push({type:"escudo", key:g.home});
    if (!away) missing.push({type:"escudo", key:g.away});
    for (const o of g.officials) {
      const photo = await loadImageForPerson(o.name);
      if (!photo) missing.push({type:"foto", key:o.name});
    }
  }
  if (missing.length) {
    showMissingAssets(missing);
    return false;
  }
  return true;
}

function showMissingAssets(missing) {
  const unique = [...new Map(missing.map(x=>[x.type+":"+normalizeText(x.key),x])).values()];
  $("missingAssets").innerHTML = `
    <div class="missingBox">
      <h3>Faltam ficheiros antes de gerar</h3>
      <p>Para garantir que nenhuma publicação sai sem fotografia ou escudo, o gerador bloqueia a criação até estes ficheiros existirem.</p>
      ${unique.map((x,i)=>`
        <div class="missingRow">
          <span><b>${x.type==="foto"?"Fotografia":"Escudo"}</b>: ${escapeHtml(x.key)}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-missing="${x.type}|${escapeHtml(x.key)}">
        </div>`).join("")}
      <button id="loadMissingBtn" class="secondary">Usar ficheiros escolhidos nesta sessão</button>
    </div>`;
  $("missingAssets").hidden=false;
  $("loadMissingBtn").onclick=async()=>{
    const inputs=[...$("missingAssets").querySelectorAll("input[type=file]")];
    for(const input of inputs){
      const file=input.files[0];
      if(!file) continue;
      const [type,key]=input.dataset.missing.split("|");
      const img=await fileToImage(file);
      if(type==="foto") state.localImages.set("person:"+normalizeText(key),img);
      else state.localImages.set("shield:"+normalizeText(key),img);
    }
    $("missingAssets").hidden=true;
    setStatus("Ficheiros carregados. Podes gerar novamente.");
  };
}

function fileToImage(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};
    img.onerror=reject; img.src=url;
  });
}

async function generateAll(){
  if(!state.games.length) return;
  const ok=await ensureAssetsForGames(state.games);
  if(!ok) return;
  setStatus("A gerar as imagens...");
  const zip = new JSZip();
  for(let i=0;i<state.games.length;i++){
    const g=state.games[i];
    const canvas=await renderNomination(g);
    const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",0.96));
    const name=safeFile(`${g.home} - ${g.away}.jpg`).slice(0,150);
    zip.file(name,blob);
  }
  const out=await zip.generateAsync({type:"blob"});
  const url=URL.createObjectURL(out);
  const a=document.createElement("a"); a.href=url; a.download="Nomeacoes_Marques_Bom.zip"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  setStatus(`Concluído: ${state.games.length} JPG(s) gerados.`);
}

async function generateManual(){
  const home=$("mHome").value.trim(), away=$("mAway").value.trim();
  const comp=$("mCompetition").value.trim();
  if(!home || !away || !comp){setError("Preenche competição e as duas equipas.");return;}
  const officials=[];
  document.querySelectorAll(".manualOfficial").forEach(row=>{
    const name=row.querySelector(".mName").value.trim();
    const role=row.querySelector(".mRole").value.trim();
    if(name) officials.push({name,role:role||"Árbitro"});
  });
  if(!officials.length){setError("Adiciona pelo menos um árbitro ou observador.");return;}
  state.localImages.get("logo") || await loadLocalAssets();
  const g={home,away,competition:comp,officials,date:$("mDate").value.trim()};
  if(!state.localImages.get("logo")){setError("Falta public/fotografias/logo.png.");return;}
  const ok=await ensureAssetsForGames([g]);
  if(!ok) return;
  setStatus("A gerar a nomeação manual...");
  const canvas=await renderNomination(g);
  const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",0.96));
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=safeFile(`${home} - ${away}.jpg`);
  a.click();
  setStatus("Nomeação manual gerada.");
}

function addManualOfficial(role="Árbitro"){
  const wrap=$("manualOfficials");
  const row=document.createElement("div");
  row.className="manualOfficial";
  row.innerHTML=`<input class="mName" placeholder="Nome"><input class="mRole" value="${escapeHtml(role)}"><button type="button" class="remove">×</button>`;
  row.querySelector(".remove").onclick=()=>row.remove();
  wrap.appendChild(row);
}

function route(){
  const manual=location.hash==="#manual";
  $("pdfSection").hidden=manual;
  $("manualSection").hidden=!manual;
  $("pdfBtn").classList.toggle("active",!manual);
  $("manualBtn").classList.toggle("active",manual);
}
function setStatus(msg){$("status").textContent=msg;$("error").textContent="";}
function setError(msg){$("error").textContent=msg;$("status").textContent="";}


async function init(){
  await loadLocalAssets();
  $("analyzeBtn").addEventListener("click",analyze);
  $("generateBtn").addEventListener("click",generateAll);
  $("pdfFile").addEventListener("change",e=>$("fileName").textContent=e.target.files[0]?.name||"");
  $("manualBtn").addEventListener("click",()=>location.hash="#manual");
  $("pdfBtn").addEventListener("click",()=>location.hash="#pdf");
  $("addOfficial").addEventListener("click",()=>addManualOfficial());
  $("manualGenerate").addEventListener("click",generateManual);
  window.addEventListener("hashchange",route);
  addManualOfficial("Árbitro");
  route();
}
init();
