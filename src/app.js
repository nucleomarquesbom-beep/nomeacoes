import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';
import { processPersonPhoto, markPersonPhotoCutout, isPersonPhotoCutout } from './photo-processing.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
const $ = id => document.getElementById(id);
const state = { pages: [], games: [], names: new Map(), assets: new Map() };

function normalizeText(v = '') {
  return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ºª°]/g, '').replace(/[^\p{L}\p{N}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function compact(v = '') { return normalizeText(v).replace(/\s+/g, ''); }
function safeFile(v = '') { return String(v).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function setStatus(s) { $('status').textContent = s; $('error').textContent = ''; }
function setError(s) { $('error').textContent = s; $('status').textContent = ''; }

function findListedName(text) {
  const normalized = normalizeText(text), compactText = compact(text);
  for (const [key, original] of [...state.names.entries()].sort((a,b) => b[0].length-a[0].length)) {
    if (normalized.includes(normalizeText(original)) || compactText.includes(key)) return original;
  }
  return null;
}
function isObserver(t) { return /^OBSV\s*:/i.test(t.trim()); }
function isVAR(t) { return /^(VAR|AVAR)\s*:/i.test(t.trim()); }
function isHeader(t) { return normalizeText(t) === 'jogo arbitro associacao'; }
function isMeta(t) { return /^(NOTA INFORMATIVA|N\.?\s*:|DATA\s*:|NI\s+)/i.test(t.trim()); }
function isCompetition(t) {
  const n = normalizeText(t);
  if (!n || isHeader(t) || isObserver(t) || isVAR(t) || isMeta(t)) return false;
  return /\b(liga|campeonato|taca|supertaca|sub-\d+|futsal|futebol de praia)\b/i.test(n) && !/\bA\.?\s*F\.?\b/i.test(t);
}
function detectModality(c='') { const n=normalizeText(c); return n.includes('futsal')||n.includes('liga placard')||n.includes('liga feminina placard')?'FUTSAL':'FUTEBOL'; }
function isLiga3BPI(c='') { const n=normalizeText(c); return n.includes('liga 3') || n.includes('liga bpi'); }
function hasAssociation(t) { return /\bA\.?\s*F\.?\s+/i.test(t); }
function roleForPosition(index, competition, modality) {
  if (modality === 'FUTSAL') return ['Árbitro','2.º Árbitro','3.º Árbitro','Cronometrista'][index] || 'Oficial';
  if (isLiga3BPI(competition)) return ['Árbitro','4.º Árbitro','Assistente 1','Assistente 2'][index] || 'Oficial';
  return ['Árbitro','Assistente 1','Assistente 2'][index] || 'Oficial';
}
function finalizeGame(current) {
  if (!current) return null;
  const modality = detectModality(current.competition);
  const officials = current.officials.filter(o=>o.name).map(o=>({name:o.name,role:roleForPosition(o.position,current.competition,modality)}));
  if (current.observer) officials.push({name:current.observer,role:'Observador'});
  return officials.length ? {competition:current.competition,home:current.home,away:current.away,officials,page:current.page} : null;
}
function headerAnchors(items) {
  const a={game:null,official:null,assoc:null};
  for(const it of items){const n=normalizeText(it.text);if(n==='jogo')a.game=it.x;else if(n==='arbitro')a.official=it.x;else if(n==='associacao')a.assoc=it.x;}
  return a;
}
function columnText(line,anchors){
  const out={game:[],official:[],assoc:[]};
  if(anchors.game==null||anchors.official==null||anchors.assoc==null)return out;
  for(const it of line.items){const c=[['game',Math.abs(it.x-anchors.game)],['official',Math.abs(it.x-anchors.official)],['assoc',Math.abs(it.x-anchors.assoc)]].sort((a,b)=>a[1]-b[1]);out[c[0][0]].push(it.text);}
  return {game:out.game.join(' ').replace(/\s+/g,' ').trim(),official:out.official.join(' ').replace(/\s+/g,' ').trim(),assoc:out.assoc.join(' ').replace(/\s+/g,' ').trim()};
}
function parsePage(page){
  const games=[];let competition='',current=null,table=false,anchors=null;
  const push=()=>{const g=finalizeGame(current);if(g)games.push(g);current=null;};
  for(const line of page.lines){const text=line.text.trim();if(!text)continue;
    if(isHeader(text)){push();anchors=headerAnchors(line.items);table=true;continue;}
    if(!table){if(isCompetition(text))competition=text;continue;}
    if(isMeta(text)){push();table=false;anchors=null;continue;}
    if(isCompetition(text)&&!hasAssociation(text)){push();competition=text;table=false;anchors=null;continue;}
    if(isObserver(text)){if(current){const listed=findListedName(text.replace(/^OBSV\s*:/i,'').trim());if(listed)current.observer=listed;}continue;}
    if(isVAR(text)||!hasAssociation(text))continue;
    const cols=columnText(line,anchors),assoc=cols.assoc||'',official=cols.official||'',gameText=cols.game||'';
    if(gameText.includes(' - ')&&official&&/^A\.?\s*F\.?/i.test(assoc)){
      push();const dash=gameText.lastIndexOf(' - ');const listed=findListedName(official);
      current={competition,home:gameText.slice(0,dash).trim(),away:gameText.slice(dash+3).trim(),officials:[{name:listed||null,position:0}],observer:null,page:page.page};continue;
    }
    if(official&&/^A\.?\s*F\.?/i.test(assoc)&&current){const listed=findListedName(official);current.officials.push({name:listed||null,position:current.officials.length});}
  }
  push();return games;
}
function parsePages(pages){return pages.flatMap(parsePage);}
async function extractPDF(file){
  const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise,pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    const content=await (await pdf.getPage(p)).getTextContent({normalizeWhitespace:true,disableCombineTextItems:true});
    const items=content.items.filter(i=>i.str?.trim()).map(i=>({text:i.str.trim(),x:i.transform[4],y:i.transform[5],width:i.width||0})).sort((a,b)=>b.y-a.y||a.x-b.x);
    const groups=[];for(const it of items){let g=groups.find(x=>Math.abs(x.y-it.y)<=3.5);if(!g){g={y:it.y,items:[]};groups.push(g);}g.items.push(it);}
    const lines=groups.sort((a,b)=>b.y-a.y).map(g=>{g.items.sort((a,b)=>a.x-b.x);return{text:g.items.map(i=>i.text).join(' ').replace(/\s+/g,' ').trim(),items:g.items};}).filter(x=>x.text);
    pages.push({page:p,lines});
  }
  return {numPages:pdf.numPages,pages};
}

function tryImage(url){return new Promise(resolve=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve(img);img.onerror=()=>resolve(null);img.src=url;});}
async function loadFirst(key,urls){for(const u of urls){const img=await tryImage(u+'?v=8');if(img){state.assets.set(key,img);return img;}}return null;}
async function loadIdentity(){await loadFirst('logo',['/fotografias/logo.png','/fotografias/logo.jpeg','/fotografias/logo.jpg']);await loadFirst('background',['/assets/fundo_nomeacao.png']);}
function personUrls(name){const f=safeFile(name);return [`/fotografias/recortadas/${encodeURIComponent(f)}.webp`,`/fotografias/recortadas/${encodeURIComponent(f)}.png`,`/fotografias/recortadas/${encodeURIComponent(f)}.jpg`,`/fotografias/${encodeURIComponent(f)}.jpg`,`/fotografias/${encodeURIComponent(f)}.jpeg`,`/fotografias/${encodeURIComponent(f)}.png`,`/fotografias/${encodeURIComponent(f)}.webp`];}
async function imageToBlob(img){const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d',{alpha:true});ctx.drawImage(img,0,0,w,h);return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Não foi possível preparar a fotografia.')),'image/png'));}
async function saveProcessedPhoto(name,blob){try{const reader=new FileReader();const dataUrl=await new Promise((resolve,reject)=>{reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});const r=await fetch('/api/foto',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({name,dataUrl})});if(!r.ok)throw new Error('Falha ao guardar fotografia');return true;}catch(e){console.warn('Não foi possível guardar a fotografia recortada no GitHub:',e);return false;}}
async function processAndCachePerson(name,img){if(!img)return null;if(isPersonPhotoCutout(img))return img;try{setStatus(`A preparar fotografia de ${name}...`);const source=await imageToBlob(img);const cutoutBlob=await processPersonPhoto(source);const cutout=await fileToImage(cutoutBlob);markPersonPhotoCutout(cutout);await saveProcessedPhoto(name,cutoutBlob);return cutout;}catch(e){console.warn('Remoção automática do fundo falhou para',name,e);return img;}}
async function personImage(name){const key='p:'+compact(name);if(state.assets.has(key))return state.assets.get(key);const f=safeFile(name);const cutout=await loadFirst(key,[`/fotografias/recortadas/${encodeURIComponent(f)}.webp`,`/fotografias/recortadas/${encodeURIComponent(f)}.png`,`/fotografias/recortadas/${encodeURIComponent(f)}.jpg`]);if(cutout){markPersonPhotoCutout(cutout);return cutout;}const original=await loadFirst(key,personUrls(name).slice(3));if(!original)return null;const processed=await processAndCachePerson(name,original);state.assets.set(key,processed);return processed;}
function teamVariants(team){return [...new Set([team.trim(),team.replace(/\bSAD\b/ig,'').replace(/\bSDUQ\b/ig,'').trim(),team.replace(/[,.]/g,'').trim()])].filter(Boolean);}
async function searchRemoteShield(team,timeoutMs=4500){
  const key='remoteShield:'+compact(team);if(state.assets.has(key))return state.assets.get(key);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await fetch(`/api/escudo?team=${encodeURIComponent(team)}`,{headers:{Accept:'application/json'},signal:controller.signal});if(!r.ok)return null;const data=await r.json(),img=await tryImage(data?.imageDataUrl);if(!img)return null;state.assets.set(key,img);state.assets.set('s:'+compact(team),img);state.assets.set('source:'+compact(team),data.source||'');return img;}catch(e){if(e?.name!=='AbortError')console.warn('Pesquisa automática de escudo falhou:',team,e);return null;}finally{clearTimeout(timer);}
}
async function shieldLocalImage(team){const key='s:'+compact(team);if(state.assets.has(key))return state.assets.get(key);for(const v of teamVariants(team)){const f=safeFile(v);for(const ext of ['png','jpg','jpeg','webp']){const img=await tryImage(`/escudos/${f}.${ext}?v=8`);if(img){state.assets.set(key,img);state.assets.set('source:'+compact(team),'Biblioteca local do Núcleo');return img;}}}return null;}
async function prepareOneShield(team){if(await shieldLocalImage(team))return true;return !!(await searchRemoteShield(team));}
async function prefetchShields(games){const teams=new Map();for(const g of games){teams.set(compact(g.home),g.home);teams.set(compact(g.away),g.away);}const unique=[...teams.values()],started=performance.now();await Promise.all(unique.map(prepareOneShield));return{total:unique.length,found:unique.filter(t=>state.assets.has('s:'+compact(t))).length,seconds:(performance.now()-started)/1000};}

function drawContain(ctx,img,x,y,w,h){if(!img)return;const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.min(w/iw,h/ih),dw=iw*s,dh=ih*s;ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
function drawCover(ctx,img,x,y,w,h,r=0){if(!img)return;const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,s=Math.max(w/iw,h/ih),dw=iw*s,dh=ih*s;ctx.save();if(r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();}ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore();}
function wrap(ctx,text,x,y,maxWidth,lineHeight,maxLines=2){const words=String(text||'').split(/\s+/),lines=[];let line='';for(const w of words){const t=line?line+' '+w:w;if(ctx.measureText(t).width<=maxWidth)line=t;else{if(line)lines.push(line);line=w;}}if(line)lines.push(line);lines.slice(0,maxLines).forEach((l,i)=>ctx.fillText(l,x,y+i*lineHeight));return lines.slice(0,maxLines);}
function fit(ctx,text,max,start,min=18){let s=start;while(s>min){ctx.font=`700 ${s}px Arial`;if(ctx.measureText(text).width<=max)return s;s-=2;}return min;}
function fitLines(ctx,text,max,start,min=16,maxLines=2){let s=start;while(s>min){ctx.font=`900 ${s}px Arial`;const words=String(text).split(/\s+/);let line='',n=1,ok=true;for(const w of words){const t=line?line+' '+w:w;if(ctx.measureText(t).width<=max)line=t;else{n++;line=w;if(n>maxLines){ok=false;break;}}}if(ok)return s;s-=2;}return min;}
function roundRect(ctx,x,y,w,h,r,fill,stroke=null,lw=1){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.stroke();}}
function drawGoldLine(ctx,x1,y,x2){ctx.strokeStyle='#e7b63d';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();ctx.fillStyle='#e7b63d';ctx.fillRect((x1+x2)/2-24,y-4,48,8);}

function drawOfficialCard(ctx,o,x,y,w,h,mode){
  const photo=state.assets.get('p:'+compact(o.name))||null;
  const pad=Math.max(10,Math.round(Math.min(w,h)*0.035));
  const labelH=Math.max(82,Math.min(135,h*0.19));
  const frameX=x+pad,frameY=y+pad,frameW=w-pad*2,frameH=h-labelH-pad*2;
  // Frame is deliberately drawn first. A transparent cut-out can therefore
  // overlap it slightly, producing the requested Instagram-style effect.
  ctx.save();ctx.shadowColor='rgba(0,0,0,.28)';ctx.shadowBlur=18;ctx.shadowOffsetY=7;ctx.fillStyle='#f4f1e9';ctx.fillRect(frameX,frameY,frameW,frameH);ctx.restore();
  ctx.fillStyle='#596b73';ctx.fillRect(frameX+10,frameY+10,frameW-20,frameH-20);
  if(photo){
    // Transparent PNG/WebP: no clipping here. Normal JPEGs are still covered
    // inside the frame, so existing assets continue to work.
    const transparent = /\.png|\.webp/i.test(photo.currentSrc||photo.src||'');
    if(transparent){
      const maxW=frameW*0.92,maxH=frameH*1.08,iw=photo.naturalWidth||photo.width,ih=photo.naturalHeight||photo.height,s=Math.min(maxW/iw,maxH/ih),dw=iw*s,dh=ih*s;
      ctx.drawImage(photo,frameX+(frameW-dw)/2,frameY+frameH-dh+Math.min(22,frameH*.035),dw,dh);
    }else drawCover(ctx,photo,frameX+10,frameY+10,frameW-20,frameH-20,0);
  }
  ctx.fillStyle='#fffdf7';ctx.fillRect(x,y+h-labelH,w,labelH);
  const roleSize=fit(ctx,o.role.toUpperCase(),w*.82,Math.max(18,Math.min(28,labelH*.24)),16);
  ctx.textAlign='center';ctx.fillStyle='#e7b63d';ctx.font=`900 ${roleSize}px Arial`;ctx.fillText(o.role.toUpperCase(),x+w/2,y+h-labelH+roleSize+8);
  const nameSize=fitLines(ctx,o.name.toUpperCase(),w*.88,Math.max(30,Math.min(58,labelH*.43)),18,2);
  ctx.fillStyle='#101820';ctx.font=`900 ${nameSize}px Arial`;const lines=wrap(ctx,o.name.toUpperCase(),x+w/2,y+h-labelH+roleSize+nameSize+18,w*.88,nameSize+4,2);
  if(lines.length>1){ctx.clearRect(x,y+h-labelH+roleSize+nameSize+12,w,labelH-(roleSize+nameSize+12));ctx.fillStyle='#fffdf7';ctx.fillRect(x,y+h-labelH,w,labelH);ctx.fillStyle='#e7b63d';ctx.font=`900 ${roleSize}px Arial`;ctx.fillText(o.role.toUpperCase(),x+w/2,y+h-labelH+roleSize+6);ctx.fillStyle='#101820';ctx.font=`900 ${nameSize}px Arial`;wrap(ctx,o.name.toUpperCase(),x+w/2,y+h-labelH+roleSize+nameSize+16,w*.88,nameSize+4,2);}
  ctx.textAlign='left';
}

function drawOfficialLayout(ctx,officials){
  const list=officials.slice(0,4),count=list.length;
  const left=45,right=1035,top=755,bottom=1785;
  if(count===1){drawOfficialCard(ctx,list[0],130,805,820,820,'single');return;}
  if(count===2){const gap=36,w=(right-left-gap)/2;drawOfficialCard(ctx,list[0],left,820,w,790,'double');drawOfficialCard(ctx,list[1],left+w+gap,820,w,790,'double');return;}
  if(count===3){const gap=24,w=(right-left-gap*2)/3;for(let i=0;i<3;i++)drawOfficialCard(ctx,list[i],left+i*(w+gap),790,w,835,'triple');return;}
  const gapX=30,gapY=30,w=(right-left-gapX)/2,h=(bottom-top-gapY)/2;for(let i=0;i<4;i++){const col=i%2,row=Math.floor(i/2);drawOfficialCard(ctx,list[i],left+col*(w+gapX),top+row*(h+gapY),w,h,'quad');}
}

function render(game){
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;const ctx=canvas.getContext('2d');
  const bg=state.assets.get('background');if(bg)ctx.drawImage(bg,0,0,1080,1920);else{ctx.fillStyle='#1d2b32';ctx.fillRect(0,0,1080,1920);}
  const logo=state.assets.get('logo');if(logo)drawContain(ctx,logo,55,35,165,165);
  ctx.fillStyle='#f5f7f8';ctx.textAlign='left';ctx.font='700 20px Arial';ctx.fillText('NÚCLEO DE ÁRBITROS DE FUTEBOL MARQUES BOM • COIMBRA',245,65);ctx.font='700 62px Arial';ctx.fillText('NOMEAÇÃO',245,145);
  ctx.fillStyle='#e7b63d';ctx.font='700 28px Arial';wrap(ctx,game.competition,60,260,960,38,3);
  ctx.fillStyle='#f5f7f8';ctx.font='700 30px Arial';wrap(ctx,game.home,70,420,400,38,2);wrap(ctx,game.away,610,420,400,38,2);
  ctx.textAlign='center';ctx.fillStyle='#e7b63d';ctx.font='700 38px Arial';ctx.fillText('VS',540,450);ctx.textAlign='left';
  drawContain(ctx,state.assets.get('s:'+compact(game.home))||null,130,485,270,230);drawContain(ctx,state.assets.get('s:'+compact(game.away))||null,680,485,270,230);
  drawOfficialLayout(ctx,game.officials);
  ctx.textAlign='center';ctx.fillStyle='#f5f7f8';ctx.font='700 21px Arial';ctx.fillText('TRABALHO, COMPETÊNCIA E DEDICAÇÃO',540,1840);ctx.fillStyle='#e7b63d';ctx.font='700 15px Arial';ctx.fillText('#MARQUESBOM  #ARBITRAGEM  #NOMEAÇÕES',540,1875);ctx.textAlign='left';return canvas;
}

function showGames(){ $('results').innerHTML=state.games.map(g=>`<div class="result"><b>${escapeHtml(g.home)}</b><span>vs</span><b>${escapeHtml(g.away)}</b><small>${escapeHtml(g.competition)}</small><p>${g.officials.map(o=>escapeHtml(o.name)+' — '+escapeHtml(o.role)).join('<br>')}</p></div>`).join(''); }
async function checkAssets(games){
  await loadIdentity();const missing=[];if(!state.assets.has('logo'))missing.push({type:'logo',key:'logo'});const people=[...new Map(games.flatMap(g=>g.officials.map(o=>[compact(o.name),o.name]))).values()];
  for(const name of people)if(!await personImage(name))missing.push({type:'foto',key:name});
  for(const g of games){if(!state.assets.has('s:'+compact(g.home)))missing.push({type:'escudo',key:g.home});if(!state.assets.has('s:'+compact(g.away)))missing.push({type:'escudo',key:g.away});}
  const unique=[...new Map(missing.map(x=>[x.type+':'+compact(x.key),x])).values()],blocking=unique.filter(x=>x.type!=='escudo');if(blocking.length){renderMissing(blocking);return false;}if(unique.length)renderMissing(unique);else $('missingAssets').hidden=true;return true;
}
function renderMissing(items){const unique=[...new Map(items.map(x=>[x.type+':'+compact(x.key),x])).values()];$('missingAssets').hidden=false;$('missingAssets').innerHTML=`<div class="missingBox"><h3>Faltam ficheiros antes de gerar</h3><p>O gerador bloqueia a criação para não sair uma publicação incompleta.</p>${unique.map(x=>`<div class="missingRow"><span><b>${x.type==='foto'?'Fotografia':x.type==='escudo'?'Escudo':'Logo'}</b>: ${escapeHtml(x.key)}</span><input type="file" accept="image/png,image/jpeg,image/webp" data-key="${escapeHtml(x.type+'|'+x.key)}"></div>`).join('')}<button id="useMissing" class="secondary">Usar ficheiros nesta sessão</button></div>`;$('useMissing').onclick=async()=>{for(const input of $('missingAssets').querySelectorAll('input[type=file]')){if(!input.files[0])continue;const [type,key]=input.dataset.key.split('|');const uploaded=await fileToImage(input.files[0]);state.assets.set(type==='foto'?'p:'+compact(key):type==='escudo'?'s:'+compact(key):'logo',type==='foto'?await processAndCachePerson(key,uploaded):uploaded);}setStatus('Ficheiros carregados. Podes gerar novamente.');};}
function fileToImage(file){return new Promise((resolve,reject)=>{const u=URL.createObjectURL(file),img=new Image();img.onload=()=>{URL.revokeObjectURL(u);resolve(img);};img.onerror=reject;img.src=u;});}

async function analyze(){const file=$('pdfFile').files[0];if(!file)return setError('Escolhe primeiro o PDF da FPF.');const names=$('names').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!names.length)return setError('Coloca pelo menos um nome na lista.');state.names=new Map(names.map(n=>[compact(n),n]));state.assets.clear();setStatus('A ler o PDF e a reconstruir as nomeações...');try{const data=await extractPDF(file);state.pages=data.pages;state.games=parsePages(data.pages);if(!state.games.length)return setError(`PDF lido (${data.numPages} páginas), mas não foi encontrado nenhum jogo com os nomes indicados.`);showGames();await loadIdentity();const people=[...new Map(state.games.flatMap(g=>g.officials.map(o=>[compact(o.name),o.name]))).values()];await Promise.all(people.map(personImage));const warmup=prefetchShields(state.games),limit=new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),12000)),result=await Promise.race([warmup,limit]);$('generateBtn').disabled=false;if(result?.timeout)setStatus('Pronto. A pesquisa de escudos demorou mais de 12 s; a aplicação não fica bloqueada.');else setStatus(`Pronto: ${state.games.length} jogo(s), ${result.found}/${result.total} escudos preparados em ${result.seconds.toFixed(1)} s. A geração dos JPG não faz pesquisas.`);}catch(e){console.error(e);setError('Erro ao ler o PDF: '+(e?.message||e));}}
async function generateAll(){if(!state.games.length)return;const started=performance.now();if(!await checkAssets(state.games))return;setStatus('A gerar os JPG — sem pesquisas externas...');const zip=new JSZip(),batchSize=4;for(let i=0;i<state.games.length;i+=batchSize){const batch=state.games.slice(i,i+batchSize),blobs=await Promise.all(batch.map(async g=>({g,blob:await new Promise(r=>render(g).toBlob(r,'image/jpeg',.92))})));for(const {g,blob} of blobs)zip.file(safeFile(`${String(state.games.indexOf(g)+1).padStart(2,'0')} - ${g.home} - ${g.away}.jpg`).slice(0,150),blob,{compression:'STORE'});setStatus(`A gerar JPG ${Math.min(i+batchSize,state.games.length)}/${state.games.length}... ${((performance.now()-started)/1000).toFixed(1)} s`);}const out=await zip.generateAsync({type:'blob',compression:'STORE'});download(out,'Nomeacoes_Marques_Bom.zip');setStatus(`Concluído: ${state.games.length} JPG(s) gerados em ${((performance.now()-started)/1000).toFixed(1)} s.`);}
async function generateManual(){const home=$('mHome').value.trim(),away=$('mAway').value.trim(),competition=$('mCompetition').value.trim();if(!home||!away||!competition)return setError('Preenche competição e as duas equipas.');const officials=[...document.querySelectorAll('.manualOfficial')].map(r=>({name:r.querySelector('.mName').value.trim(),role:r.querySelector('.mRole').value.trim()||'Árbitro'})).filter(x=>x.name);if(!officials.length)return setError('Adiciona pelo menos um oficial.');const g={home,away,competition,officials,date:$('mDate').value.trim()};await loadIdentity();await Promise.all(officials.map(o=>personImage(o.name)));await Promise.race([prefetchShields([g]),new Promise(resolve=>setTimeout(resolve,12000))]);if(!await checkAssets([g]))return;const blob=await new Promise(r=>render(g).toBlob(r,'image/jpeg',.92));download(blob,safeFile(`${home} - ${away}.jpg`));setStatus('Nomeação manual gerada.');}
function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500);}
function addManualOfficial(role='Árbitro'){const row=document.createElement('div');row.className='manualOfficial';row.innerHTML=`<input class="mName" placeholder="Nome"><input class="mRole" value="${escapeHtml(role)}"><button type="button">×</button>`;row.querySelector('button').onclick=()=>row.remove();$('manualOfficials').appendChild(row);}
function route(){const manual=location.hash==='#manual';$('pdfSection').hidden=manual;$('manualSection').hidden=!manual;$('pdfBtn').classList.toggle('active',!manual);$('manualBtn').classList.toggle('active',manual);}
async function init(){await loadIdentity();$('analyzeBtn').onclick=analyze;$('generateBtn').onclick=generateAll;$('pdfFile').onchange=e=>{$('fileName').textContent=e.target.files[0]?.name||'';};$('manualBtn').onclick=()=>{location.hash='#manual';};$('pdfBtn').onclick=()=>{location.hash='#pdf';};$('addOfficial').onclick=()=>addManualOfficial();$('manualGenerate').onclick=generateManual;addManualOfficial();window.onhashchange=route;route();}
init();
