import sharp from "sharp";

const UA="Mozilla/5.0 (compatible; NAF-Marques-Bom/1.0)";
const ZZ="https://www.zerozero.pt";
const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[ºª°]/g,"").replace(/["'.,/()\-]/g," ").replace(/\s+/g," ").trim();
const clean=s=>String(s||"").trim().replace(/(?:\s+|\/)(?:OAF\s+SDUQ|SAD|SDUQ|OAF)\s*$/i,"").replace(/\s+/g," ").trim();
const safe=s=>clean(s).replace(/[<>:"/\\|?*\u0000-\u001F]/g,"").trim();
const score=(a,b)=>{a=norm(a);b=norm(b);if(!a||!b)return-1;if(a===b)return1000;if(a.includes(b)||b.includes(a))return700-Math.abs(a.length-b.length);const A=new Set(a.split(" ")),B=new Set(b.split(" "));return[...A].filter(x=>B.has(x)).length*50-Math.abs(a.length-b.length)};
const gh=()=>({token:process.env.GITHUB_TOKEN,repo:process.env.GITHUB_REPO,branch:process.env.GITHUB_BRANCH||"main"});

async function buf(url){try{const r=await fetch(url,{headers:{"User-Agent":UA,Accept:"image/*,*/*;q=0.8"}});if(!r.ok||!(r.headers.get("content-type")||"").toLowerCase().startsWith("image/"))return null;return Buffer.from(await r.arrayBuffer())}catch{return null}}
async function data(b){const m=await sharp(b,{failOn:"none"}).metadata().catch(()=>({}));const t=m.format==="jpeg"||m.format==="jpg"?"image/jpeg":m.format==="webp"?"image/webp":"image/png";return`data:${t};base64,${b.toString("base64")}`}

async function cache(team){
 const {token,repo,branch}=gh();if(!token||!repo)return null;
 try{
  const h={Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"};
  const r=await fetch(`https://api.github.com/repos/${repo}/contents/public/escudos?ref=${encodeURIComponent(branch)}`,{headers:h});if(!r.ok)return null;
  const w=norm(safe(team)),f=(await r.json()).find(x=>x.type==="file"&&norm(x.name.replace(/\.(png|jpe?g|webp)$/i,""))===w);if(!f)return null;
  const b=await buf(f.download_url);return b?{url:f.download_url,imageDataUrl:await data(b),source:"GitHub cache",team,cached:true}:null;
 }catch{return null}
}

async function sourceTeams(name){
 const out=[];
 try{const r=await fetch(`https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=${encodeURIComponent(name)}`,{headers:{"User-Agent":UA}});if(r.ok)out.push(...((await r.json()).teams||[]).filter(x=>x.strBadge).map(x=>({score:score(name,x.strTeam),team:x.strTeam,url:x.strBadge,source:"TheSportsDB"})))}catch{}
 try{const r=await fetch(`https://www.sofascore.com/api/v1/search/all?q=${encodeURIComponent(name)}`,{headers:{"User-Agent":UA}});if(r.ok)out.push(...((await r.json()).results||[]).filter(x=>x?.entity?.type==="team"&&x.entity.id).map(x=>({score:score(name,x.entity.name),team:x.entity.name,url:`https://api.sofascore.com/api/v1/team/${x.entity.id}/image`,source:"SofaScore"})))}catch{}
 try{
  const r=await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=pt&format=json&limit=8`,{headers:{"User-Agent":UA}});
  if(r.ok){const ids=((await r.json()).search||[]).map(x=>x.id);if(ids.length){const e=await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=claims|labels&languages=pt|en&format=json`,{headers:{"User-Agent":UA}});if(e.ok){const es=(await e.json()).entities||{};for(const id of ids){const z=es[id],f=z?.claims?.P154?.[0]?.mainsnak?.datavalue?.value,l=z?.labels?.pt?.value||z?.labels?.en?.value||"";if(f)out.push({score:score(name,l),team:l,url:"https://commons.wikimedia.org/wiki/Special:FilePath/"+encodeURIComponent(String(f).replace(/^File:/i,"")),source:"Wikidata/Wikimedia Commons"})}}}}
 }catch{}
 for(const lang of ["pt","en"])try{const r=await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(name)}&gsrnamespace=0&prop=pageimages&piprop=original|thumbnail&pithumbsize=800&format=json`,{headers:{"User-Agent":UA}});if(r.ok)for(const x of Object.values((await r.json())?.query?.pages||{}))if(x.original?.source||x.thumbnail?.source)out.push({score:score(name,x.title),team:x.title,url:x.original?.source||x.thumbnail.source,source:`Wikipedia ${lang.toUpperCase()}`})}catch{}
 const seen=new Set();return out.sort((a,b)=>b.score-a.score).filter(x=>x.url&&!seen.has(x.url)&&(seen.add(x.url),true))
}

async function zero(name){
 try{
  const r=await fetch(`${ZZ}/search.php?search_string=${encodeURIComponent(clean(name))}`,{headers:{"User-Agent":UA,Accept:"text/html"}});if(!r.ok)return null;
  const h=await r.text(),a=[],re=/<a[^>]+href=["']([^"']*\/equipa\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
  while(m=re.exec(h)){const t=m[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(),s=score(name,t);if(s>=500)a.push({href:m[1],text:t,score:s})}
  if(!a.length)return null;a.sort((x,y)=>y.score-x.score);const page=new URL(a[0].href,ZZ).href,p=await fetch(page,{headers:{"User-Agent":UA}});if(!p.ok)return null;
  const b=await p.text(),abs=b.match(/https?:\/\/www\.zerozero\.pt\/img\/logos\/equipas\/[^"'<>\\s]+/i),rel=b.match(/(?:src|data-src)=["']([^"']*\/img\/logos\/equipas\/[^"']+)["']/i);let u=abs?.[0]||"";if(!u&&rel?.[1])u=new URL(rel[1].replace(/\\\//g,"/"),ZZ).href;return u?{team:a[0].text,url:u,page}:null
 }catch{return null}
}

async function pixels(b){return sharp(b,{failOn:"none"}).ensureAlpha().trim({background:{r:0,g:0,b:0,alpha:0}}).resize(96,96,{fit:"contain",background:{r:255,g:255,b:255,alpha:0}}).flatten({background:{r:255,g:255,b:255}}).removeAlpha().raw().toBuffer()}
async function similarity(a,b){try{const[x,y]=await Promise.all([pixels(a),pixels(b)]);if(x.length!==y.length)return 0;let d=0,c=0,n=x.length/3;for(let i=0;i<x.length;i+=3){const q=(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2]))/3;d+=q;if(q<=28)c++}return Math.max(0,Math.min(1,(1-d/n/255)*.65+c/n*.35))}catch{return 0}}

async function save(team,d){
 const {token,repo,branch}=gh();if(!token||!repo)return{ok:false,error:"GITHUB_TOKEN ou GITHUB_REPO não configurado."};
 const m=String(d).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);if(!m)return{ok:false,error:"Imagem inválida."};
 const ext=m[1].toLowerCase()==="jpeg"?"jpg":m[1].toLowerCase(),path=`public/escudos/${safe(team)}.${ext}`,u=`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g,"/")}`,h={Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"};
 try{const q=await fetch(`${u}?ref=${encodeURIComponent(branch)}`,{headers:h}),sha=q.ok?(await q.json()).sha:undefined;if(!q.ok&&q.status!==404)return{ok:false,error:`GitHub GET ${q.status}`};const r=await fetch(u,{method:"PUT",headers:h,body:JSON.stringify({message:`Adicionar escudo: ${safe(team)}`,content:m[2],branch,...sha?{sha}:{}})}),j=await r.json().catch(()=>({}));return r.ok?{ok:true,path}:{ok:false,error:j?.message||`GitHub PUT ${r.status}`}}catch(e){return{ok:false,error:e.message}}
}

const body=req=>{if(req.body&&typeof req.body==="object")return req.body;try{return JSON.parse(req.body||"{}")}catch{return{}}};

export default async function handler(req,res){
 if(req.method==="POST"){const{team,dataUrl}=body(req);if(!team||!dataUrl)return res.status(400).json({error:"team e dataUrl são obrigatórios."});const s=await save(team,dataUrl);return s.ok?res.status(200).json(s):res.status(500).json({error:s.error})}
 if(req.method!=="GET")return res.status(405).json({error:"Method not allowed"});
 const team=String(req.query?.team||"").trim();if(!team)return res.status(400).json({error:"team obrigatório"});
 try{
  const c=await cache(team);if(c)return res.status(200).json(c);
  const z=await zero(team),list=await sourceTeams(team);
  if(z){const ref=await buf(z.url);if(ref){for(const x of list){const b=await buf(x.url);if(!b)continue;const sim=await similarity(ref,b);if(sim<.88)continue;const d=await data(b),s=await save(team,d);return res.status(200).json({...x,imageDataUrl:d,verified:true,verificationSource:"ZeroZero",similarity:sim,zeroZeroTeam:z.team,zeroZeroPage:z.page,saved:s.ok,savedPath:s.path||null,saveError:s.ok?null:s.error})}return res.status(404).json({error:"Não foi encontrado um escudo visualmente igual ao do ZeroZero.",zeroZeroTeam:z.team,zeroZeroPage:z.page})}}
  const x=list[0];if(!x)return res.status(404).json({error:"Escudo não encontrado."});const b=await buf(x.url);if(!b)return res.status(404).json({error:"Imagem do escudo indisponível."});const d=await data(b),s=await save(team,d);return res.status(200).json({...x,imageDataUrl:d,verified:false,saved:s.ok,savedPath:s.path||null,saveError:s.ok?null:s.error})
 }catch(e){console.error(e);return res.status(500).json({error:e?.message||"Erro na pesquisa do escudo."})}
}
