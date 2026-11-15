// Гостевая ссылка под своим аккаунтом в настоящем окне: посетитель и участник без доступа к этажу.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.PAIR_TEST_URL,bootstrap=JSON.parse(fs.readFileSync(process.env.PAIR_TEST_BOOTSTRAP,'utf8'));
const {star,link,code}=bootstrap.fixtures,shots=process.env.GUEST_SHOTS;
fs.mkdirSync(process.env.PAIR_TEST_PROFILE,{recursive:true});app.setPath('userData',process.env.PAIR_TEST_PROFILE);app.on('window-all-closed',()=>{});
let win;const pause=ms=>new Promise(r=>setTimeout(r,ms)),run=code=>win.webContents.executeJavaScript(code);
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return}catch{}await pause(100)}throw Error('Timeout '+label+'\n'+(await run('document.body.innerText').catch(()=>'')).slice(0,1500))}
const text=()=>run('document.body.innerText');
// Скрытое окно рисует лениво: просим свежий кадр, иначе снимок отстаёт от страницы.
async function shot(name){if(!shots)return;fs.mkdirSync(shots,{recursive:true});win.webContents.invalidate();await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await pause(400);fs.writeFileSync(path.join(shots,name+'.png'),(await win.webContents.capturePage()).toPNG())}
async function clickText(selector,label){await until(()=>run(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.includes(${JSON.stringify(label)})&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'click '+label)}
async function openAs(name){
 const ses=session.fromPartition('persist:guest-'+name);
 ses.webRequest.onBeforeRequest((d,reply)=>{const url=new URL(d.url);reply({cancel:!['data:','blob:'].includes(url.protocol)&&url.host!==new URL(base).host})});
 win=new BrowserWindow({show:false,width:1280,height:820,useContentSize:true,webPreferences:{session:ses,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const account=bootstrap.accounts[name];
 await win.loadURL(base+'/auth');
 await run(`localStorage.setItem('quazar-auth',JSON.stringify({state:${JSON.stringify(account)},version:0}));localStorage.setItem('quazar_e2e_backup_hint_dismissed','1');localStorage.setItem('quazar-contacts-asked','1');localStorage.setItem('quazar-notify-prefs',JSON.stringify({enabled:false,sound:false,promptDismissed:true}))`);
 // Ссылку открывают как обычно — из письма или чата.
 await win.loadURL(base+'/guest/'+code);
 await until(async()=>new URL(await run('location.href')).pathname==='/','redirect into the app');
}
async function api(method,url,token){const r=await fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error(method+' '+url+' → '+r.status);return r.status===204?null:r.json()}
const deadline=setTimeout(()=>{console.error('Guest pass test timed out');app.exit(1)},110000);
app.whenReady().then(async()=>{
 // 1. Не участник Звезды: Звезда появляется, в ней — только Комната из ссылки.
 await openAs('guest_carol');
 await until(async()=>(await text()).includes('Гость по ссылке'),'visitor star');
 await until(async()=>(await text()).includes('Сейф'),'linked room');
 let page=await text();
 assert.ok(page.includes('Офис Альфа'),'star name');
 for(const hidden of ['Касса','Переговорка','Спутники','общий','Файлы'])assert.ok(!page.includes(hidden),'visitor must not see '+hidden);
 assert.ok(page.includes('Бухгалтерия'),'floor of the linked room');
 assert.ok(!page.includes('1 этаж'),'other floors stay hidden');
 await until(async()=>(await text()).includes('открыта по гостевой ссылке до'),'notice about the link');
 await shot('1-visitor-map');
 await clickText('button[aria-label^="Открыть «"]','⋯');
 await until(async()=>(await text()).includes('Вас пригласили гостевой ссылкой'),'pass hint in the room');
 page=await text();
 assert.ok(page.includes('Войти в Комнату'),'enter button without knocking');
 assert.ok(!page.includes('Постучаться'),'no knocking with a link');
 await shot('2-visitor-room');
 const listed=await api('GET','/stars',bootstrap.accounts.guest_carol.token);
 assert.deepEqual(listed.map(s=>[s.id,s.my_role]),[[star,'visitor']]);
 win.destroy();
 console.log('GUEST_VISITOR_OK: star with one room, no members, no satellites, enters without knocking');

 // 2. Участник без доступа к этажу: этаж появляется, но только с этой Комнатой.
 await openAs('guest_alice');
 await until(async()=>(await text()).includes('Бухгалтерия'),'closed floor with the linked room');
 await until(async()=>(await text()).includes('Сейф'),'linked room for member');
 page=await text();
 assert.ok(!page.includes('Касса'),'other rooms of the closed floor stay hidden');
 assert.ok(page.includes('общий')&&page.includes('Переговорка'),'regular member view stays');
 await shot('3-member-floor');
 // Ссылку отозвали — этаж пропадает сразу, без перезагрузки.
 await api('DELETE',`/stars/${star}/guest-links/${link}`,bootstrap.accounts.guest_owner.token);
 await until(async()=>!(await text()).includes('Бухгалтерия'),'floor disappears after revoke');
 // Название остаётся только в уведомлении о ссылке — ни в списке, ни на карте Комнаты нет.
 await until(async()=>!(await run(`[...document.querySelectorAll('button,[role="button"]')].some(n=>n.textContent.includes('Сейф'))`)),'room disappears after revoke');
 await pause(1000);assert.ok(!(await text()).includes('Бухгалтерия'),'floor stays hidden');
 await shot('4-member-after-revoke');
 console.log('GUEST_MEMBER_OK: floor shows only the linked room and disappears when the link is revoked');
 clearTimeout(deadline);win.destroy();app.quit();
}).catch(async error=>{const detail=String(error.stack||error);console.error(detail);if(win)try{fs.writeFileSync(path.join(process.env.PAIR_TEST_PROFILE,'failure-guest-pass.png'),(await win.webContents.capturePage()).toPNG())}catch{}
 console.error('::error title=Guest pass::'+detail.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));clearTimeout(deadline);app.exit(1)});
