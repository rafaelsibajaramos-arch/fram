// Browser-only address UX test with a controlled geocoder; no personal data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createServer}=require('node:http');
const root=path.resolve(__dirname,'../frontend/public');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
let browser;
const server=createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<div id="root"></div><div id="toasts"></div><script type="module">import {locationPicker} from "/js/address-picker.js";window.picker=locationPicker();document.querySelector("#root").append(window.picker);</script>');return;}
  const file=path.resolve(root,'.'+req.url.split('?')[0]);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('content-type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://cdnjs.cloudflare.com/**',r=>r.abort());let calls=0;
  await page.route('**/api/v1/locations/search?**',r=>{calls++;return r.fulfill({json:{results:[{label:'Calle 22, Las Acacias, Monteria',latitude:8.75,longitude:-75.88},{label:'Otra calle 22, Monteria',latitude:8.76,longitude:-75.87}]}});});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'Buscar dirección',exact:true}).waitFor();
  assert.equal(await page.getByRole('spinbutton').count(),0);
  await page.getByLabel('Dirección, calle, carrera o manzana',{exact:true}).fill('Calle 22 # 9-15');await page.getByLabel('Ciudad o municipio',{exact:true}).fill('Montería, Córdoba');await page.getByLabel('Barrio o vereda',{exact:true}).fill('Las Acacias');assert.equal(calls,0);
  await page.getByRole('button',{name:'Buscar dirección',exact:true}).click();await page.getByRole('button',{name:'Calle 22, Las Acacias, Monteria',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.picker.value()),null);
  await page.getByRole('button',{name:'Calle 22, Las Acacias, Monteria',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.picker.value()),{latitude:8.75,longitude:-75.88});
  await page.getByLabel('Complemento y referencias',{exact:true}).fill('Manzana T, lote 9');assert.match(await page.evaluate(()=>window.picker.addressValue()),/Manzana T, lote 9/);assert.ok(await page.evaluate(()=>window.picker.value()));
  await page.getByLabel('Ciudad o municipio',{exact:true}).fill('Otra ciudad');assert.equal(await page.evaluate(()=>window.picker.value()),null);assert.equal(calls,1);assert.deepEqual(errors,[]);
  console.log('PASS: address/city/neighborhood search, no visible coordinates or autocomplete, explicit result choice, private delivery references, stale location invalidation and usable search without map CDN.');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
