const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createServer}=require('node:http');
const root=path.resolve(__dirname,'..'),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const buyer='11111111-1111-4111-8111-111111111111',orderId='22222222-2222-4222-8222-222222222222',productId='33333333-3333-4333-8333-333333333333';
const pending={buyerId:buyer,orderId,deliveryAddress:'Montería Calle 1',deliveryLatitude:8.75,deliveryLongitude:-75.88,items:[{productId,quantity:1,estimatedUnitPrice:1200}],idempotencyKey:'browser-wompi-test'};
const order={id:orderId,buyerId:buyer,status:'pending',deliveryAddress:pending.deliveryAddress,items:[{productId,quantity:1,unitPrice:1200}]};
let browser;const errors=[];
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<button id="cart">Abrir carrito</button><div id="avisos"></div><script type="module">import {instalarCarrito} from "/js/carrito.js";instalarCarrito(document.querySelector("button"),()=>{});</script>');return;}
 const file=path.resolve(root,'frontend/public','.'+req.url.split('?')[0]);if(!file.startsWith(path.join(root,'frontend/public'))||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({buyer,pending})=>{sessionStorage.setItem('ftt_user',buyer);sessionStorage.setItem('ftt_token','local-test');sessionStorage.setItem('ftt_roles','["buyer"]');sessionStorage.setItem('ftt_checkout_pendiente_'+buyer,JSON.stringify(pending));},{buyer,pending});
 await page.route('**/api/**',route=>{const url=new URL(route.request().url());let data={};
  if(url.pathname.includes('/wompi/config'))data={configured:true};
  else if(url.pathname.includes('/wompi/checkout/'))data={checkoutUrl:'https://checkout.wompi.co/p/?reference=browser-test'};
  else if(url.pathname.includes('/orders/checkout'))data={order};
  else if(url.pathname.includes('/orders/'+orderId))data=order;
  else if(url.pathname.includes('/products/'))data={name:'Naranja',price:1200};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});});
 await page.route('https://checkout.wompi.co/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<h1>Wompi checkout interceptado en prueba local</h1>'}));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'Abrir carrito'}).click();await page.getByText('Pago exclusivo por Wompi Sandbox').waitFor();assert.equal(await page.locator('#carrito-tarjeta').count(),0);
 await page.getByRole('button',{name:'Reintentar confirmación'}).click();await page.waitForURL('https://checkout.wompi.co/**');assert.deepEqual(errors,[]);console.log('Carrito verificado en navegador: sin tarjetas simuladas, conserva pedido y redirige exclusivamente al checkout de Wompi. APIs controladas, sin transacción externa.');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();server.close();});
