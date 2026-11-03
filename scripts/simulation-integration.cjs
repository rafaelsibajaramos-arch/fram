// Isolated PostgreSQL, real Nest HTTP/JWT, OSRM roads and real payment locks.
// No .env, Neon data, real purchase or email is used by this test.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createServer}=require('node:http');
const root=path.resolve(__dirname,'..');
const source=s=>fs.existsSync(path.join(root,'repositorios',s,'node_modules/@prisma/client'))?path.join(root,'repositorios',s):path.join(root,s);
const base=source('logistics-service'),payments=source('payment-service');
const dep=n=>require(require.resolve(n,{paths:[base]}));dep('reflect-metadata');
const uuid=()=>crypto.randomUUID(),container='ftt-simulation-e2e-'+Date.now();
const adminId=uuid(),buyerId=uuid(),producerUser=uuid(),producerId=uuid(),otherUser=uuid(),otherProducer=uuid();
let app,db,paymentDb,backend,web,browser;
cp.execFileSync('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_USER=simulation_test','-e','POSTGRES_PASSWORD=simulation_local_only','-e','POSTGRES_DB=logistics_simulation','-p','127.0.0.1::5432','postgres:16-alpine'],{stdio:'pipe'});
process.on('exit',()=>{try{cp.execFileSync('docker',['stop',container],{stdio:'pipe',timeout:20000})}catch{}});
const inspect=JSON.parse(cp.execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];const pgPort=inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort;
const connection=name=>`postgresql://simulation_test:simulation_local_only@127.0.0.1:${pgPort}/${name}`;
process.env.DATABASE_URL=connection('logistics_simulation');process.env.DIRECT_URL=process.env.DATABASE_URL;process.env.INTERNAL_API_KEY=crypto.randomBytes(24).toString('hex');process.env.OSRM_URL='http://127.0.0.1:5500';delete process.env.RABBITMQ_URL;
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});process.env.JWT_PUBLIC_KEY=pair.publicKey;
const {PrismaService}=require(path.join(base,'dist/prisma.service')),{LogisticsService}=require(path.join(base,'dist/logistics.service')),{OperationsService}=require(path.join(base,'dist/operations.service')),{SimulationService}=require(path.join(base,'dist/simulation.service')),{LogisticsAccessService}=require(path.join(base,'dist/logistics-access.service')),{LogisticsController}=require(path.join(base,'dist/logistics.controller')),{AuthGuard}=require(path.join(base,'dist/auth.guard')),{DatabaseConflictFilter}=require(path.join(base,'dist/database-conflict.filter'));
const common=dep('@nestjs/common'),{NestFactory,APP_GUARD,APP_FILTER}=dep('@nestjs/core'),{JwtModule,JwtService}=dep('@nestjs/jwt');
class TestModule{}common.Module({imports:[JwtModule.register({})],controllers:[LogisticsController],providers:[PrismaService,LogisticsAccessService,LogisticsService,OperationsService,SimulationService,{provide:APP_GUARD,useClass:AuthGuard},{provide:APP_FILTER,useClass:DatabaseConflictFilter}]})(TestModule);
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const token=(id,roles)=>new JwtService().sign({sub:id,roles},{privateKey:pair.privateKey,algorithm:'RS256',issuer:'farmtotable-identity',audience:'farmtotable-api',expiresIn:'1h'});
const tokens={admin:token(adminId,['admin']),buyer:token(buyerId,['buyer']),producer:token(producerUser,['producer']),other:token(otherUser,['producer'])};
let port;
async function api(method,p,role='admin',body,status){const r=await fetch(`http://127.0.0.1:${port}/api/v1/${p}`,{method,headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json','x-operation-id':uuid()},...(body?{body:JSON.stringify(body)}:{})});const t=await r.text();const value=t?JSON.parse(t):null;if(status)assert.equal(r.status,status,t);else assert.ok(r.ok,method+' '+p+' '+r.status+' '+t);return value;}
function migrate(dir,name){cp.execFileSync('node',[path.join(dir,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(dir,'prisma/schema.prisma')],{env:{...process.env,DATABASE_URL:connection(name),DIRECT_URL:connection(name)},stdio:'pipe'});}
(async()=>{
 for(let i=0;i<30;i++){try{cp.execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','simulation_test'],{stdio:'pipe'});break}catch{await new Promise(r=>setTimeout(r,500))}}
 cp.execFileSync('docker',['exec',container,'createdb','-U','simulation_test','payment_simulation']);migrate(base,'logistics_simulation');migrate(payments,'payment_simulation');
 const {PrismaClient}=require(path.join(payments,'node_modules/@prisma/client'));paymentDb=new PrismaClient({datasourceUrl:connection('payment_simulation')});const {PaymentsService}=require(path.join(payments,'dist/payments.service'));const money=new PaymentsService(paymentDb);
 backend=createServer(async(req,res)=>{try{
  if(req.headers['x-internal-api-key']!==process.env.INTERNAL_API_KEY){res.writeHead(403).end('{}');return;}
  if(req.url.startsWith('/internal/users/')){const id=req.url.split('/')[3];res.setHeader('content-type','application/json');res.end(JSON.stringify({producer_id:id===producerUser?producerId:id===otherUser?otherProducer:null}));return;}
  const match=req.url.match(/\/payments\/([^/]+)\/fulfillment-(un)?lock/);if(!match){res.writeHead(404).end('{}');return;}let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);const value=await money[match[2]?'unlockForFulfillment':'lockForFulfillment'](match[1],data.routeId);res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
 }catch(e){res.writeHead(e.getStatus?.()??500).end(JSON.stringify({message:e.message}));}});
 const upstream=await listen(backend);process.env.PRODUCER_SERVICE_URL=`http://127.0.0.1:${upstream}`;process.env.PAYMENT_SERVICE_URL=process.env.PRODUCER_SERVICE_URL;
 app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix('api/v1');app.useGlobalPipes(new common.ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;db=app.get(PrismaService);const logistics=app.get(LogisticsService),simulations=app.get(SimulationService);simulations.onModuleDestroy();
 await api('POST','logistics/zones','admin',{code:'SIM',name:'Zona de prueba Monteria'});
 const driver=await api('POST','drivers','admin',{baseCity:'Monteria',baseDepartment:'Cordoba',simulated:true,fullName:'Repartidor de prueba local',phone:'3000000000',licenseNumber:'LOCAL-'+Date.now(),preparationMinutes:15});assert.equal(driver.simulated,true);
 await api('POST','drivers','producer',{baseCity:'Monteria',baseDepartment:'Cordoba',simulated:true,fullName:'No autorizado',phone:'3000000000',licenseNumber:'DENIED'},403);
 await api('POST','vehicles','producer',{baseCity:'Monteria',baseDepartment:'Cordoba',baseAddress:'Base de prueba Monteria',baseLatitude:8.750,baseLongitude:-75.880,plate:'DENIED',capacityKg:50},403);
 const vehicle=await api('POST','vehicles','admin',{baseCity:'Monteria',baseDepartment:'Cordoba',baseAddress:'Base de prueba Monteria',baseLatitude:8.750,baseLongitude:-75.880,plate:'LOCAL-SIM',capacityKg:50,minimumLoadKg:5,kind:'motorcycle',brand:'Prueba',model:'Moto de carga'});
 const start=new Date(Date.now()+20*60000),end=new Date(start.getTime()+3*3600000);
 const created=[];
 for(let i=0;i<2;i++){
  const orderId=uuid(),paymentId=uuid(),itemId=uuid();await paymentDb.payment.create({data:{id:paymentId,orderId,buyerId,amount:10000,currency:'COP',provider:'wompi',providerStatus:'APPROVED',providerTransactionId:'fixture-'+i,status:'authorized'}});
  const sourceEvent={event_id:uuid(),event_type:'order.confirmed',source_service:'order-service',entity_id:orderId,entity_version:1,schema_version:1,correlation_id:uuid(),occurred_at:new Date().toISOString(),payload:{paymentId}};
  const plan=await logistics.createPlan({orderId,buyerId,deliveries:[{deliveryAddress:'Destino local de prueba '+i,latitude:i?8.758:8.755,longitude:i?-75.884:-75.882,windowStart:start.toISOString(),windowEnd:end.toISOString(),lots:[{reservationId:uuid(),orderItemId:itemId,producerId,harvestBatchId:uuid(),farmId:uuid(),quantityKg:10,unitPrice:1000,pickupAddress:'Finca de prueba local',pickupLatitude:8.752,pickupLongitude:-75.881}]}]},uuid(),sourceEvent);
  const delivery=plan.deliveries[0];await api('PATCH',`deliveries/${delivery.id}/location`,'producer',{latitude:delivery.latitude,longitude:delivery.longitude,zoneCode:'SIM',pickupReadyAt:start.toISOString(),pickupDeadlineAt:end.toISOString()});created.push({delivery,orderId,paymentId,itemId});
 }
 const ids=created.map(c=>c.delivery.id);await api('GET',`deliveries/${ids[0]}/tracking`,'other',null,403);
 const request={driverId:driver.id,vehicleId:vehicle.id,zoneCode:'SIM',scheduledDate:start.toISOString(),scheduledEnd:end.toISOString(),deliveryIds:ids,originLatitude:8.750,originLongitude:-75.880,serviceMinutes:1};
 await api('POST','routes/preview','other',request,403);
 await api('POST','routes/preview','producer',{...request,scheduledDate:new Date(Date.now()+60000).toISOString()},409);
 await api('PATCH',`deliveries/${ids[0]}/location`,'producer',{latitude:8.755,longitude:-75.882,zoneCode:'SIM',pickupDeadlineAt:new Date(start.getTime()-1000).toISOString()},400);
 await db.vehicle.update({where:{id:vehicle.id},data:{minimumLoadKg:30}});
 await api('POST','routes/preview','producer',request,409);
 await db.vehicle.update({where:{id:vehicle.id},data:{minimumLoadKg:5}});
 await api('POST','routes/auto-plan','other',{deliveryIds:ids},403);
 await db.delivery.updateMany({where:{id:{in:ids}},data:{zoneCode:null,locationConfirmedAt:null}});
 await db.driver.update({where:{id:driver.id},data:{baseCity:'Medellin',baseDepartment:'Antioquia'}});
 await api('POST','routes/auto-plan','producer',{deliveryIds:ids},409);
 await db.driver.update({where:{id:driver.id},data:{baseCity:'Monteria',baseDepartment:'Cordoba'}});
 await api('POST','drivers','admin',{baseCity:'Medellin',baseDepartment:'Antioquia',simulated:true,fullName:'Distante de prueba',phone:'0000000000',licenseNumber:'LOCAL-FAR',preparationMinutes:15});
 await api('POST','vehicles','admin',{baseCity:'Medellin',baseDepartment:'Antioquia',baseAddress:'Base distante de prueba',baseLatitude:6.25,baseLongitude:-75.56,plate:'LOCAL-FAR',capacityKg:25,minimumLoadKg:5,kind:'motorcycle'});
 const preview=await api('POST','routes/auto-plan','producer',{deliveryIds:ids});assert.equal(preview.automatic,true);assert.equal(preview.selection.vehicle,vehicle.plate);assert.equal(preview.origin.latitude,8.750);assert.equal(preview.selection.baseCity,'Monteria');assert.equal(preview.dto.zoneCode,'AUTO');assert.equal(preview.geometry.type,'LineString');assert.ok(preview.peakLoadKg<=50);
 const route=await api('POST','routes/confirm','producer',{proposalId:preview.proposalId,roadRestrictionsReviewed:true});assert.equal(route.deliveries.length,2);
 await api('POST','routes/preview','producer',request,409);
 assert.equal(await db.outboxEvent.count({where:{eventType:'delivery.scheduled'}}),2);
 await api('POST',`routes/${route.id}/simulation`,'buyer',{action:'start',speed:120},403);
 await paymentDb.payment.update({where:{id:created[0].paymentId},data:{providerStatus:'PENDING'}});
 await api('POST',`routes/${route.id}/simulation`,'producer',{action:'start',speed:120,confirmationDelaySeconds:10},409);
 assert.equal((await db.route.findUniqueOrThrow({where:{id:route.id}})).status,'planned');
 await api('POST',`routes/${route.id}/simulation`,'producer',{action:'resume'},409);
 await paymentDb.payment.update({where:{id:created[0].paymentId},data:{providerStatus:'APPROVED'}});
 await api('POST',`routes/${route.id}/simulation`,'producer',{action:'start',speed:120,confirmationDelaySeconds:10});
 assert.equal(await paymentDb.paymentRouteLock.count({where:{routeId:route.id}}),2);
 // One paid order can have independently assigned producer shipments.
 const extraRoute=uuid();await money.lockForFulfillment(created[0].paymentId,extraRoute);await money.unlockForFulfillment(created[0].paymentId,extraRoute);assert.equal(await paymentDb.paymentRouteLock.count({where:{paymentId:created[0].paymentId}}),1);
 await api('POST',`routes/${route.id}/simulation`,'producer',{action:'pause'});const paused=await db.routeSimulation.findUniqueOrThrow({where:{routeId:route.id}});const elapsed=paused.elapsedSeconds;await simulations.tick();assert.equal((await db.routeSimulation.findUniqueOrThrow({where:{routeId:route.id}})).elapsedSeconds,elapsed);
 await api('POST',`routes/${route.id}/simulation`,'producer',{action:'resume',speed:60});
 const sim=await db.routeSimulation.findUniqueOrThrow({where:{routeId:route.id}});const timeline=sim.timeline;
 await db.routeSimulation.update({where:{id:sim.id},data:{elapsedSeconds:timeline.preparationSeconds+30,anchorAt:new Date()}});const recoveredWorker=new SimulationService(db,logistics,app.get(LogisticsAccessService));await recoveredWorker.tick();
 const tracking=await api('GET',`deliveries/${ids[0]}/tracking`,'buyer');assert.equal(tracking.simulated,true);assert.ok(tracking.position);assert.ok(tracking.geometry);assert.ok(tracking.driver.fullName);assert.ok(!tracking.stops.some(s=>s.deliveryId&&s.deliveryId!==ids[0]));
 if(process.env.PLAYWRIGHT_MODULE_PATH){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);browser=await chromium.launch({channel:'msedge',headless:true});
  web=createServer(async(req,res)=>{if(req.url.startsWith('/api/v1/')){const r=await fetch(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json','x-operation-id':req.headers['x-operation-id']??uuid()},...(['GET','HEAD'].includes(req.method)?{}:{body:await new Promise(resolve=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>resolve(b))})})});res.writeHead(r.status,{'content-type':'application/json'}).end(await r.text());return;}if(req.url==='/'||req.url==='/operations'){res.setHeader('content-type','text/html');res.end((req.url==='/operations'?'<script type="module">import {vistaCentroLogistico} from "/js/views/operations.js";window.addEventListener("DOMContentLoaded",()=>vistaCentroLogistico(document.querySelector("#ops")));</script><div id="ops"></div>':'')+'<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/operations.css"><link rel="stylesheet" href="/delivery-live.css"><div id="root"></div><div id="avisos"></div><script type="module">import {vistaEntregas} from "/js/views/delivery-live.js";if(location.pathname!=="/operations")vistaEntregas(document.querySelector("#root"));</script>');return;}const p=path.resolve(root,'frontend/public','.'+req.url.split('?')[0]);if(!p.startsWith(path.join(root,'frontend/public'))||!fs.existsSync(p)){res.writeHead(404).end();return;}res.setHeader('content-type',p.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(p));});const webPort=await listen(web);const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({id,token})=>{sessionStorage.setItem('ftt_user',id);sessionStorage.setItem('ftt_token',token);sessionStorage.setItem('ftt_roles','["buyer"]')},{id:buyerId,token:tokens.buyer});await page.goto(`http://127.0.0.1:${webPort}`);await page.getByText(/RECORRIDO SIMULADO/).first().waitFor();await page.locator('progress').first().waitFor();await page.waitForTimeout(1000);assert.deepEqual(errors,[]);fs.mkdirSync(path.join(root,'.local-logistics/evidence'),{recursive:true});await page.screenshot({path:path.join(root,'.local-logistics/evidence/simulation-buyer.png'),fullPage:true});await checkOperationsBrowser(browser,webPort,tokens);await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'.local-logistics/evidence/simulation-mobile.png'),fullPage:true});
 }
 await db.routeSimulation.update({where:{id:sim.id},data:{elapsedSeconds:timeline.duration+1,anchorAt:new Date()}});await simulations.tick();
 const arrived=await db.delivery.findUniqueOrThrow({where:{id:ids[0]},include:{lots:true}});assert.ok(arrived.transportCompletedAt);assert.equal(arrived.status,'in_transit');
 await api('PATCH',`deliveries/${ids[0]}/confirm`,'buyer',{status:'completed',receivedByName:'Comprador de prueba',acceptedLots:arrived.lots.map(l=>({reservationId:l.reservationId,acceptedQuantityKg:Number(l.quantityKg)}))});
 await db.delivery.updateMany({where:{id:ids[1]},data:{transportCompletedAt:new Date(Date.now()-11000)}});await simulations.tick();await simulations.tick();
 const final=await db.delivery.findMany({where:{id:{in:ids}}});assert.equal(final.find(d=>d.id===ids[0]).completionSource,'buyer');assert.equal(final.find(d=>d.id===ids[1]).completionSource,'simulation');
 const before=await db.outboxEvent.count({where:{eventType:'order.fulfillment_closed'}});assert.equal(before,2);
 await api('POST',`deliveries/${ids[1]}/acknowledge`,'buyer',{receivedByName:'Comprador de prueba'});await api('POST',`deliveries/${ids[1]}/acknowledge`,'buyer',{receivedByName:'Comprador de prueba'});assert.equal(await db.outboxEvent.count({where:{eventType:'order.fulfillment_closed'}}),before);
 assert.ok((await db.delivery.findUniqueOrThrow({where:{id:ids[1]}})).buyerConfirmedAt);
 assert.equal((await db.route.findUniqueOrThrow({where:{id:route.id}})).status,'completed');assert.equal((await db.routeSimulation.findUniqueOrThrow({where:{id:sim.id}})).status,'completed');
 console.log('PASS: admin-only fleet, producer ownership, pickup preparation, two deliveries per driver, OSRM, durable pause/resume, live buyer tracking, real payment-route locks, manual and automatic receipt, no repeated settlement.');
})().catch(e=>{console.error(e.stack??e.message);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(web)web.close();if(app)await app.close();if(paymentDb)await paymentDb.$disconnect();if(backend)backend.close();});

async function checkOperationsBrowser(browser,port,tokens){
 for(const role of ['producer','admin']){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({role,token})=>{sessionStorage.setItem('ftt_token',token);sessionStorage.setItem('ftt_roles',JSON.stringify([role]));sessionStorage.setItem('ftt_user','browser-fixture')},{role,token:tokens[role]});
  let autoCalls=0,dispatchCalls=0;
  if(role==='producer'){
   const rows=await api('GET','deliveries','producer');const sample=await db.route.findFirst({include:{driver:true,vehicle:true}});const plan=sample.roadPlan;
   await page.route('**/api/v1/deliveries',r=>r.fulfill({json:rows.map(d=>({...d,status:'scheduled',routeId:null}))}));
   await page.route('**/api/v1/routes/auto-plan',r=>{autoCalls++;assert.equal(r.request().postDataJSON().deliveryIds.length,1);return r.fulfill({json:{...plan,proposalId:'browser-proposal',warnings:[],selection:{driver:sample.driver.fullName,vehicle:sample.vehicle.plate,kind:sample.vehicle.kind,totalKg:10,baseCity:'Monteria',baseDepartment:'Cordoba',originAddress:'Base de prueba'}}})});
   await page.route('**/api/v1/routes/confirm',r=>r.fulfill({json:{id:sample.id}}));
   await page.route('**/api/v1/routes/*/simulation',r=>{dispatchCalls++;return r.fulfill({json:{status:'running'}})});
  }
  await page.goto('http://127.0.0.1:'+port+'/operations');
  if(role==='producer'){
   await page.getByRole('checkbox').first().check();
   await page.getByRole('button',{name:'Organizar entregas autom'+String.fromCharCode(225)+'ticamente',exact:true}).click();
   await page.getByRole('dialog').waitFor();assert.equal(autoCalls,1);
   await page.getByRole('dialog').getByRole('checkbox').check();
   await page.getByRole('button',{name:'Asignar e iniciar simulaci'+String.fromCharCode(243)+'n',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(dispatchCalls,1);
  }
  await page.getByRole('button',{name:role==='admin'?'Conductores':'Rutas y seguimiento',exact:true}).click();
  if(role==='admin'){
   await page.getByRole('button',{name:'Registrar conductor',exact:true}).click();
   await page.getByRole('dialog').waitFor();
   assert.equal(await page.getByLabel('Repartidor simulado',{exact:true}).isChecked(),true);
   await page.getByLabel('Ciudad base del repartidor',{exact:true}).fill('Monteria');await page.getByLabel('Departamento base del repartidor',{exact:true}).fill('Cordoba');
   await page.getByLabel('Nombre completo',{exact:true}).fill('Perfil navegador local');
   await page.getByLabel('Tel'+String.fromCharCode(233)+'fono',{exact:true}).fill('3000000001');
   await page.getByLabel('N'+String.fromCharCode(250)+'mero de licencia / identificaci'+String.fromCharCode(243)+'n de prueba',{exact:true}).fill('BROWSER-LOCAL');
   await page.getByRole('dialog').getByRole('button',{name:'Guardar repartidor',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'detached'});
   await page.getByText('Perfil navegador local',{exact:true}).waitFor();
  }else{
   assert.equal(await page.getByRole('button',{name:'Conductores',exact:true}).count(),0);
   await page.getByRole('button',{name:'Abrir operaci'+String.fromCharCode(243)+'n',exact:true}).first().click();
   await page.getByRole('dialog').waitFor();
   await page.getByText(/SIMULADO/).first().waitFor();
  }
  assert.deepEqual(errors,[]);await page.close();
 }
}
