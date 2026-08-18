import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AUTOMATION_NAMES, AUTOMATION_EMAIL } from './names.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const stateFile = path.join(dir, 'last-processed.json');
const tmp = path.join(root, '.automation-tmp');
const FPF_URL = 'https://www.fpf.pt/Institucional/Arbitragem/Nomea%C3%A7%C3%B5es-n%C3%A3o-profissionais';
const APP_URL = process.env.APP_URL;
const FROM = process.env.EMAIL_FROM;
const KEY = process.env.RESEND_API_KEY;
const TO = process.env.EMAIL_TO || AUTOMATION_EMAIL;
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

if (!APP_URL || !FROM || !KEY) throw new Error('Faltam APP_URL, EMAIL_FROM ou RESEND_API_KEY.');

const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
}).formatToParts().filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
const date = `${parts.year}-${parts.month}-${parts.day}`;
const displayDate = `${parts.day}/${parts.month}/${parts.year}`;
if (!manual && parts.hour !== '20') process.exit(0);

await fs.rm(tmp,{recursive:true,force:true}); await fs.mkdir(tmp,{recursive:true});

const norm = s => String(s??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,' ').trim().toLowerCase();
const abs = s => { try{return new URL(s,'https://www.fpf.pt').href}catch{return null} };
const isPdf = s => typeof s==='string' && /\.pdf(?:[?#].*)?$/i.test(s);
const isNI = s => /\bni\b/i.test(norm(s));
const dateTokens = [date,`${parts.day}/${parts.month}/${parts.year}`,`${parts.day}-${parts.month}-${parts.year}`,`${parts.year}/${parts.month}/${parts.day}`].map(norm);
const hasDate = s => dateTokens.some(t=>norm(s).includes(t));

async function setDate(page){
  const inputs=page.locator('input'); let el=null;
  for(let i=0;i<await inputs.count();i++){
    const x=inputs.nth(i), meta=norm([await x.getAttribute('name'),await x.getAttribute('id'),await x.getAttribute('placeholder'),await x.getAttribute('aria-label')].filter(Boolean).join(' '));
    if((await x.getAttribute('type'))==='date'||meta.includes('data')||meta.includes('date')){el=x;break;}
  }
  if(!el)return false;
  if((await el.getAttribute('type'))==='date') await el.fill(date);
  else {try{await el.fill(`${parts.day}/${parts.month}/${parts.year}`)}catch{await el.fill(date)}}
  return true;
}
async function inputNI(page){
  const inputs=page.locator('input');
  for(let i=0;i<await inputs.count();i++){
    const x=inputs.nth(i), meta=norm([await x.getAttribute('name'),await x.getAttribute('id'),await x.getAttribute('placeholder'),await x.getAttribute('aria-label')].filter(Boolean).join(' '));
    if(meta.includes('content')||meta.includes('pesquisa')||meta.includes('search')){await x.fill('NI');return;}
  }
}
async function findPdf(page, api){
  const nodes=page.locator('a[href], [data-href], [data-url]'), out=[];
  for(let i=0;i<await nodes.count();i++){
    const x=nodes.nth(i), text=await x.innerText().catch(()=>''), attrs=[await x.getAttribute('href'),await x.getAttribute('data-href'),await x.getAttribute('data-url'),await x.getAttribute('title')].filter(Boolean);
    for(const raw of attrs){const u=abs(raw);if(u&&isPdf(u)&&isNI(`${u} ${text} ${attrs.join(' ')}`))out.push({u,c:`${u} ${text} ${attrs.join(' ')}`});}
  }
  const dated=out.filter(x=>hasDate(x.c)); if(dated.length)return dated[0].u;
  const apiText=JSON.stringify(api);
  const urls=[...new Set((apiText.match(/https?:[^"\\\s]+\.pdf(?:\?[^"\\\s]*)?/gi)||[]).map(abs).filter(Boolean))];
  const ni=urls.filter(u=>isNI(u));
  const datedApi=ni.filter(u=>hasDate(`${u} ${apiText}`));
  return datedApi[0]||null;
}

const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const api=[];
  page.on('response',async r=>{if(r.url().includes('/GetDocuments')){try{api.push(await r.json())}catch{}}});
  await page.goto(FPF_URL,{waitUntil:'domcontentloaded',timeout:60000});
  for(const label of ['Aceitar todos','Aceitar','Concordo']){const b=page.getByRole('button',{name:new RegExp(`^${label}$`,'i')}).first();if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});break;}}
  await setDate(page); await inputNI(page);
  await page.getByRole('button',{name:/Procurar/i}).first().click();
  await page.waitForTimeout(3000);
  const niUrl=await findPdf(page,api);
  if(!niUrl){await page.screenshot({path:path.join(tmp,'fpf-sem-ni-confirmado.png'),fullPage:true}).catch(()=>{});throw new Error(`Não foi possível confirmar um NI da data ${displayDate}; nenhum email será enviado.`);}
  const r=await fetch(niUrl,{headers:{'User-Agent':'Mozilla/5.0',Referer:FPF_URL,Accept:'application/pdf,*/*'}});
  if(!r.ok)throw new Error(`PDF HTTP ${r.status}`);
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.subarray(0,4).toString()!=='%PDF')throw new Error('O documento encontrado não é um PDF válido.');
  const sha=crypto.createHash('sha256').update(buf).digest('hex');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8').catch(()=> '{}'));
  if(state.sha256===sha){console.log('NI já processado.');process.exit(0);}
  const pdf=path.join(tmp,'NI.pdf');await fs.writeFile(pdf,buf);
  await page.goto(APP_URL,{waitUntil:'networkidle',timeout:60000});
  await page.locator('#names').fill(AUTOMATION_NAMES.join('\n'));
  await page.locator('#pdfFile').setInputFiles(pdf);await page.locator('#analyzeBtn').click();
  await page.waitForFunction(()=>!document.querySelector('#generateBtn')?.disabled||document.querySelector('#error')?.textContent,{timeout:120000});
  const err=(await page.locator('#error').textContent().catch(()=>''))?.trim();if(err)throw new Error(err);
  const text=norm(await page.locator('#results').innerText().catch(()=>''));
  const found=AUTOMATION_NAMES.filter(n=>text.includes(norm(n)));
  if(!found.length){console.log('Nenhum nome configurado encontrado.');process.exit(0);}
  const dl=page.waitForEvent('download',{timeout:120000});await page.locator('#generateBtn').click();const d=await dl;
  const zip=path.join(tmp,'nomeacoes.zip');await d.saveAs(zip);
  const content=(await fs.readFile(zip)).toString('base64');
  const email=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},body:JSON.stringify({
    from:FROM,to:[TO],subject:`Nomeações FPF — ${displayDate}`,
    html:`<p>Nomeações FPF — <b>${displayDate}</b></p><p>Encontradas ${found.length} nomeações.</p><ul>${found.map(n=>`<li>${n}</li>`).join('')}</ul>`,
    attachments:[{filename:`Nomeacoes_FPF_${date}.zip`,content}]
  })});
  if(!email.ok)throw new Error(`Resend ${email.status}: ${await email.text()}`);
  await fs.writeFile(stateFile,JSON.stringify({url:niUrl,sha256:sha,date,names:found},null,2)+'\n');
  console.log(`Email enviado para ${TO}.`);
}finally{await browser.close();await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});}
