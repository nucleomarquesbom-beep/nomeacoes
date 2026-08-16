import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
const $ = id => document.getElementById(id);
const state = { pages: [], games: [], names: new Map(), assets: new Map() };

function normalizeText(v='') {
  return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[ºª°]/g,'').replace(/[^\p{L}\p{N}\s.'-]/gu,' ')
    .replace(/\s+/g,' ').trim();
}
function compact(v=''){ return normalizeText(v).replace(/\s+/g,''); }
function safeFile(v=''){ return String(v).replace(/[<>:"/\\|?*\u0000-\u001F]/g,'').replace(/\s+/g,' ').trim(); }
function escapeRegExp(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function setStatus(s){$('status').textContent=s;$('error').textContent='';}
function setError(s){$('error').textContent=s;$('status').textContent='';}
function findListedName(text) {
  const n=normalizeText(text);
  const entries=[...state.names.entries()].sort((a,b)=>b[0].length-a[0].length);
  for(const [key,original] of entries){
    const p=new RegExp(`(^|\\s)${escapeRegExp(key).replace(/\\s+/g,'\\s+')}(?=\\s|$)`,'i');
    if(p.test(n)) return original;
  }
  return null;
}
function isObserver(t){return /^OBSV\s*:/i.test(t.trim());}
function isVAR(t){return /^(VAR|AVAR)\s*:/i.test(t.trim());}
function isHeader(t){return normalizeText(t)==='jogo arbitro associacao';}
function isMeta(t){return /^(NOTA INFORMATIVA|N\.?\s*:|DATA\s*:|NI\s+)/i.test(t.trim());}
function isCompetition(t){
  const n=normalizeText(t);
  if(!n || isHeader(t) || isObserver(t) || isVAR(t) || isMeta(t)) return false;
  return /\b(liga|campeonato|taca|supertaca|sub-\d+|futsal|futebol de praia)\b/i.test(n) && !/\bA\.?\s*F\.?\b/i.test(t);
}
function detectModality(c=''){
  const n=normalizeText(c);
  if(n.includes('liga 3 placard')) return 'FUTEBOL';
  if(n.includes('futsal') || n.includes('liga placard') || n.includes('liga feminina placard')) return 'FUTSAL';
  return 'FUTEBOL';
}
function isLiga3BPI(c=''){const n=normalizeText(c);return n.includes('liga 3')||n.includes('liga bpi');}

function headerColumns(items){
  const result={team:null,official:null,assoc:null};
  for(const it of items){
    const n=normalizeText(it.text);
    if(n==='jogo') result.team=it.x;
    else if(n==='arbitro') result.official=it.x;
    else if(n==='associacao') result.assoc=it.x;
  }
  return result;
}
function assignColumns(line, anchors){
  if(!anchors.team || !anchors.official || !anchors.assoc) return {team:[],official:[],assoc:[]};
  const cols={team:[],official:[],assoc:[]};
  for(const it of line.items){
    const d=[['team',Math.abs(it.x-anchors.team)],['official',Math.abs(it.x-anchors.official)],['assoc',Math.abs(it.x-anchors.assoc)]];
    d.sort((a,b)=>a[1]-b[1]); cols[d[0][0]].push(it.text);
  }
  return cols;
}
function lineColumns(line, anchors){
  const c=assignColumns(line,anchors);
  return {team:c.team.join(' ').replace(/\s+/g,' ').trim(),official:c.official.join(' ').replace(/\s+/g,' ').trim(),assoc:c.assoc.join(' ').replace(/\s+/g,' ').trim()};
}
function isGameLine(line,anchors){
  const c=lineColumns(line,anchors);
  return Boolean(c.team && c.official && /^A\.?\s*F\.?/i.test(c.assoc) && /\s-\s/.test(c.team));
}
function splitGameLine(line,anchors){
  const c=lineColumns(line,anchors); const dash=c.team.indexOf(' - ');
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
    const items=content.items.filter(i=>i.str?.trim()).map(i=>({text:i.str.trim(),x:i.transform[4],y:i.transform[5],width:i.width||0}));
    items.sort((a,b)=>b.y-a.y||a.x-b.x);
    const groups=[]; const tol=3.5;
    for(const it of items){
      let g=groups.find(x=>Math.abs(x.y-it.y)<=tol);
      if(!g){g={y:it.y,items:[]};groups.push(g);} g.items.push(it);
    }
    const lines=groups.sort((a,b)=>b.y-a.y).map(g=>{g.items.sort((a,b)=>a.x-b.x);return {text:g.items.map(i=>i.text).join(' ').replace(/\s+/g,' ').trim(),items:g.items};}).filter(x=>x.text);
    pages.push({page:p,lines});
  }
  return {numPages:pdf.numPages,pages};
}
function parsePage(page){
  const games=[]; let competition=''; let anchors=null; let table=false;
  const lines=page.lines;
  for(let i=0;i<lines.length;i++){
    const text=lines[i].text.trim();
    if(!text) continue;
    if(isHeader(text)){
      anchors=headerColumns(lines[i].items); table=true; continue;
    }
    if(!table){
      if(isCompetition(text)) competition=text;
      continue;
    }
    if(isMeta(text)) { table=false; anchors=null; continue; }
    if(isCompetition(text) && !isGameLine(lines[i],anchors)){ competition=text; table=false; anchors=null; continue; }
    if(!anchors || !isGameLine(lines[i],anchors)) continue;
    const base=splitGameLine(lines[i],anchors); if(!base) continue;
    const officials=[];
    const first=findListedName(base.firstOfficial);
    if(first) officials.push({name:first,role:'Árbitro'});
    let observer=null;
    let j=i+1;
    for(;j<lines.length;j++){
      const t=lines[j].text.trim();
      if(!t) continue;
      if(isHeader(t)||isMeta(t)) break;
      if(isCompetition(t) && !isGameLine(lines[j],anchors)) break;
      if(isGameLine(lines[j],anchors)) break;
      if(isObserver(t)){
        const listed=findListedName(t.replace(/^OBSV\s*:/i,'')); if(listed) observer={name:listed,role:'Observador'}; continue;
      }
      if(isVAR(t)) continue;
      const c=lineColumns(lines[j],anchors);
      if(c.official && /^A\.?\s*F\.?/i.test(c.assoc)){
        const listed=findListedName(c.official);
        if(listed){
          const idx=officials.length; const mod=detectModality(competition); let role='Oficial';
          if(mod==='FUTSAL') role=idx===1?'2.º Árbitro':idx===2?'3.º Árbitro':idx===3?'Cronometrista':'Árbitro';
          else if(isLiga3BPI(competition)) role=idx===1?'4.º Árbitro':idx===2?'Assistente 1':idx===3?'Assistente 2':'Oficial';
          else role=idx===1?'Assistente 1':idx===2?'Assistente 2':'Oficial';
          officials.push({name:listed,role});
        }
      }
    }
    if(observer) officials.push(observer);
    if(officials.length) games.push({competition,home:base.home,away:base.away,officials,page:page.page});
    i=j-1;
  }
  return games;
}
function parsePages(pages){return pages.flatMap(parsePage);}
function tryImage(url){return new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>resolve(null);img.src=url;});}
async function loadFirst(key,urls){
  for(const u of urls){
    const img=await tryImage(u+'?v=3');
    if(img){state.assets.set(key,img);return img;}
  }
  return null;
}
async function loadIdentity(){
  await loadFirst('logo',['/fotografias/logo.png','/fotografias/logo_original.jpeg','/fotografias/logo.jpeg','/fotografias/logo.jpg']);
  // The official NAF Marques Bom background is stored at the project root.
  // Keep the previous background only as a fallback.
  await loadFirst('background',['/fundo_marques_bom.jpg','/assets/fundo_nomeacao.png','/assets/fundo_nomecao.png']);
}
function personUrls(name){const f=safeFile(name);return [`/fotografias/${f}.jpg`,`/fotografias/${f}.jpeg`,`/fotografias/${f}.png`,`/fotografias/${f}.webp`];}
async function personImage(name){const key='p:'+compact(name);if(state.assets.has(key))return state.assets.get(key);const img=await loadFirst(key,personUrls(name));return img;}

function removeOnlyLegalSuffix(team){
  const original=String(team||'').trim();
  // Only SAD or SDUQ at the very end are removed.
  return original.replace(/\s+(?:S\.?\s*A\.?\s*D\.?|S\.?\s*D\.?\s*U\.?\s*Q\.?)$/i,'').trim();
}
function teamVariants(team){
  const original=String(team||'').trim();
  const base=removeOnlyLegalSuffix(original);
  const a=new Set([original]);
  if(base!==original) a.add(base);
  return [...a].filter(Boolean);
}
async function shieldImage(team){
  const key='s:'+compact(team);
  if(state.assets.has(key))return state.assets.get(key);
  for(const v of teamVariants(team)){
    const f=safeFile(v);
    for(const ext of ['png','jpg','jpeg','webp']){
      const img=await tryImage(`/escudos/${f}.${ext}?v=3`);
      if(img){state.assets.set(key,img);return img;}
    }
  }
  // Online API: only after local variants fail.
  try{
    const r=await fetch(`/api/escudo?team=${encodeURIComponent(team)}`);
    if(r.ok){
      const data=await r.json();
      if(data?.imageDataUrl){
        const img=await tryImage(data.imageDataUrl);
        if(img){state.assets.set(key,img);return img;}
      }
    }
  }catch{}
  return null;
}
function drawContain(ctx,img,x,y,w,h){
  if(!img)return;
  const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.min(w/iw,h/ih),dw=iw*s,dh=ih*s;
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
}
function drawCover(ctx,img,x,y,w,h,r=0){
  if(!img)return;
  const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.max(w/iw,h/ih),dw=iw*s,dh=ih*s;
  ctx.save();if(r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();}ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore();
}
function wrap(ctx,text,x,y,maxWidth,lineHeight,maxLines=2){
  const words=text.split(/\s+/),lines=[];let line='';
  for(const w of words){const t=line?line+' '+w:w;if(ctx.measureText(t).width<=maxWidth)line=t;else{if(line)lines.push(line);line=w;}}
  if(line)lines.push(line);lines.slice(0,maxLines).forEach((l,i)=>ctx.fillText(l,x,y+i*lineHeight));
}
function fit(ctx,text,max,start,min=24){let s=start;while(s>min){ctx.font=`700 ${s}px Arial`;if(ctx.measureText(text).width<=max)return s;s-=2;}return s;}
async function render(game){
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;const ctx=canvas.getContext('2d');
  const bg=state.assets.get('background');
  if(bg)ctx.drawImage(bg,0,0,1080,1920);else{ctx.fillStyle='#1d2b32';ctx.fillRect(0,0,1080,1920);}
  const logo=state.assets.get('logo'); if(logo)drawContain(ctx,logo,55,35,165,165);
  ctx.fillStyle='#f5f7f8';ctx.textAlign='left';ctx.font='700 20px Arial';ctx.fillText('NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA',245,65);
  ctx.font='700 62px Arial';ctx.fillText('NOMEAÇÃO',245,145);
  ctx.fillStyle='#e7b63d';ctx.font='700 28px Arial';wrap(ctx,game.competition,60,260,960,38,3);
  ctx.fillStyle='#f5f7f8';ctx.font='700 30px Arial';wrap(ctx,game.home,70,420,400,38,2);wrap(ctx,game.away,610,420,400,38,2);
  ctx.textAlign='center';ctx.fillStyle='#e7b63d';ctx.font='700 38px Arial';ctx.fillText('VS',540,450);ctx.textAlign='left';
  const [homeShield,awayShield]=await Promise.all([shieldImage(game.home),shieldImage(game.away)]);
  drawContain(ctx,homeShield,130,485,270,230);drawContain(ctx,awayShield,680,485,270,230);
  const count=game.officials.length;const h=count<=1?340:count===2?285:count===3?235:count===4?205:175;const start=775;
  for(let i=0;i<count;i++){
    const o=game.officials[i],y=start+i*(h+18);ctx.fillStyle='rgba(13,24,30,.86)';ctx.beginPath();ctx.roundRect(45,y,990,h,26);ctx.fill();
    ctx.strokeStyle='rgba(231,182,61,.45)';ctx.lineWidth=2;ctx.stroke();
    const photo=await personImage(o.name);if(photo){drawCover(ctx,photo,75,y+25,220,h-50,18);}else{ctx.fillStyle='#60727b';ctx.fillRect(75,y+25,220,h-50);}
    ctx.fillStyle='#e7b63d';ctx.font=`700 ${count<=2?25:19}px Arial`;ctx.fillText(o.role.toUpperCase(),330,y+70);
    ctx.fillStyle='#f5f7f8';const sz=fit(ctx,o.name,640,count<=2?50:40);ctx.font=`700 ${sz}px Arial`;wrap(ctx,o.name,330,y+145,640,sz+8,2);
  }
  ctx.textAlign='center';ctx.fillStyle='#f5f7f8';ctx.font='700 21px Arial';ctx.fillText('TRABALHO, COMPETÊNCIA E DEDICAÇÃO',540,1840);ctx.fillStyle='#e7b63d';ctx.font='700 15px Arial';ctx.fillText('#MARQUESBOM  #ARBITRAGEM  #NOMEAÇÕES',540,1875);ctx.textAlign='left';
  return canvas;
}
function showGames(){
  $('results').innerHTML=state.games.map(g=>`<div class="result"><b>${escapeHtml(g.home)}</b> <span>vs</span> <b>${escapeHtml(g.away)}</b><small>${escapeHtml(g.competition)}</small><p>${g.officials.map(o=>escapeHtml(o.name)+' — '+escapeHtml(o.role)).join('<br>')}</p></div>`).join('');
}
async function checkAssets(games){
  await loadIdentity();
  const missing=[];
  if(!state.assets.has('logo'))missing.push({type:'logo',key:'logo'});
  for(const g of games){
    if(!await shieldImage(g.home))missing.push({type:'escudo',key:g.home});
    if(!await shieldImage(g.away))missing.push({type:'escudo',key:g.away});
    for(const o of g.officials)if(!await personImage(o.name))missing.push({type:'foto',key:o.name});
  }
  if(missing.length){renderMissing(missing);return false;} $('missingAssets').hidden=true;return true;
}
function renderMissing(items){
  const unique=[...new Map(items.map(x=>[x.type+':'+compact(x.key),x])).values()];
  $('missingAssets').hidden=false;
  $('missingAssets').innerHTML=`<div class="missingBox"><h3>Faltam ficheiros antes de gerar</h3><p>O gerador bloqueia a criação para não sair uma publicação incompleta.</p>${unique.map(x=>`<div class="missingRow"><span><b>${x.type==='foto'?'Fotografia':x.type==='escudo'?'Escudo':'Logo'}</b>: ${escapeHtml(x.key)}</span><input type="file" accept="image/png,image/jpeg,image/webp" data-key="${escapeHtml(x.type+'|'+x.key)}"></div>`).join('')}<button id="useMissing" class="secondary">Usar ficheiros nesta sessão</button></div>`;
  $('useMissing').onclick=async()=>{
    for(const input of $('missingAssets').querySelectorAll('input[type=file]')){
      if(!input.files[0])continue;
      const [type,key]=input.dataset.key.split('|');
      const img=await fileToImage(input.files[0]);
      state.assets.set(type==='foto'?'p:'+compact(key):type==='escudo'?'s:'+compact(key):'logo',img);
    }
    setStatus('Ficheiros carregados. Podes gerar novamente.');
  };
}
function fileToImage(file){return new Promise((resolve,reject)=>{const u=URL.createObjectURL(file),img=new Image();img.onload=()=>{URL.revokeObjectURL(u);resolve(img)};img.onerror=reject;img.src=u;});}
async function analyze(){
  const file=$('pdfFile').files[0];if(!file)return setError('Escolhe primeiro o PDF da FPF.');
  const names=$('names').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!names.length)return setError('Coloca pelo menos um nome na lista.');
  state.names=new Map(names.map(n=>[compact(n),n]));setStatus('A ler o PDF e a reconstruir as tabelas...');
  try{const data=await extractPDF(file);state.pages=data.pages;state.games=parsePages(data.pages);if(!state.games.length)return setError(`PDF lido (${data.numPages} páginas), mas não foi encontrado nenhum jogo com os nomes indicados.`);showGames();$('generateBtn').disabled=false;setStatus(`PDF lido: ${data.numPages} página(s). Encontrados ${state.games.length} jogo(s).`);}catch(e){console.error(e);setError('Erro ao ler o PDF: '+(e?.message||e));}
}
async function generateAll(){
  if(!state.games.length)return;
  const ok=await checkAssets(state.games);if(!ok)return;
  setStatus('A gerar os JPG...');
  const zip=new JSZip();
  for(const g of state.games){
    const canvas=await render(g);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.96));
    zip.file(safeFile(`${g.home} - ${g.away}.jpg`).slice(0,150),blob);
  }
  const blob=await zip.generateAsync({type:'blob'});
  download(blob,'Nomeacoes_Marques_Bom.zip');
  setStatus(`Concluído: ${state.games.length} JPG(s) gerados.`);
}
async function generateManual(){
  const home=$('mHome').value.trim(),away=$('mAway').value.trim(),competition=$('mCompetition').value.trim();
  if(!home||!away||!competition)return setError('Preenche competição e as duas equipas.');
  const officials=[...document.querySelectorAll('.manualOfficial')].map(r=>({name:r.querySelector('.mName').value.trim(),role:r.querySelector('.mRole').value.trim()||'Árbitro'})).filter(x=>x.name);
  if(!officials.length)return setError('Adiciona pelo menos um oficial.');
  const g={home,away,competition,officials};
  if($('mDate').value.trim())g.date=$('mDate').value.trim();
  const ok=await checkAssets([g]);if(!ok)return;
  const canvas=await render(g);
  const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.96));
  download(blob,safeFile(`${home} - ${away}.jpg`));
  setStatus('Nomeação manual gerada.');
}
function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500);}
function addManualOfficial(role='Árbitro'){const row=document.createElement('div');row.className='manualOfficial';row.innerHTML=`<input class="mName" placeholder="Nome"><input class="mRole" value="${escapeHtml(role)}"><button type="button">×</button>`;row.querySelector('button').onclick=()=>row.remove();$('manualOfficials').appendChild(row);}
function route(){const manual=location.hash==='#manual';$('pdfSection').hidden=manual;$('manualSection').hidden=!manual;$('pdfBtn').classList.toggle('active',!manual);$('manualBtn').classList.toggle('active',manual);}
async function init(){
  await loadIdentity();
  $('analyzeBtn').onclick=analyze;
  $('generateBtn').onclick=generateAll;
  $('pdfFile').onchange=e=>$('fileName').textContent=e.target.files[0]?.name||'';
  $('manualBtn').onclick=()=>location.hash='#manual';
  $('pdfBtn').onclick=()=>location.hash='#pdf';
  $('addOfficial').onclick=()=>addManualOfficial();
  $('manualGenerate').onclick=generateManual;
  addManualOfficial();
  window.onhashchange=route;
  route();
}
init();
