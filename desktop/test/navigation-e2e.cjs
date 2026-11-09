// Native touch input against real mobile screens and a disposable local API/profile.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.PAIR_TEST_URL,bootstrap=JSON.parse(fs.readFileSync(process.env.PAIR_TEST_BOOTSTRAP,'utf8'));
fs.mkdirSync(process.env.PAIR_TEST_PROFILE,{recursive:true});app.setPath('userData',process.env.PAIR_TEST_PROFILE);app.on('window-all-closed',()=>{});
let win;const pause=ms=>new Promise(r=>setTimeout(r,ms)),run=code=>win.webContents.executeJavaScript(code);
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return}catch{}await pause(100)}throw Error('Timeout '+label)}
async function click(text){await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length&&!n.disabled);if(!el)return false;el.click();return true})()`),'button '+text)}
const overlays=()=>run(`document.querySelectorAll('[data-swipe-back]').length`);
async function swipe(x1,y1,x2,y2){
 await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x1,y:y1,id:0}]});
 for(let i=1;i<=5;i++){await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x1+(x2-x1)*i/5,y:y1+(y2-y1)*i/5,id:0}]});await pause(20)}
 await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(200);
}
async function chat(){await click('Чат');await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button,[role="button"]')].find(n=>n.textContent.includes('Первый черновик')&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'chat row');await until(async()=>await overlays()===1,'chat overlay')}
const deadline=setTimeout(()=>{console.error('Navigation test timed out');app.exit(1)},100000);
app.whenReady().then(async()=>{
 const ses=session.fromPartition('persist:navigation');
 ses.webRequest.onBeforeRequest((d,reply)=>{const url=new URL(d.url);reply({cancel:!['data:','blob:'].includes(url.protocol)&&url.host!==new URL(base).host})});
 win=new BrowserWindow({show:false,width:390,height:760,useContentSize:true,webPreferences:{session:ses,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1');
 await win.loadURL(base+'/auth');await run(`localStorage.setItem('quazar-auth',JSON.stringify({state:${JSON.stringify({token:bootstrap.token,user:bootstrap.user})},version:0}));localStorage.setItem('quazar_e2e_backup_hint_dismissed','1');localStorage.setItem('quazar-contacts-asked','1');localStorage.setItem('quazar-notify-prefs',JSON.stringify({enabled:false,sound:false,promptDismissed:true}))`);
 await win.loadURL(base+'/');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await chat();await swipe(70,330,108,335);assert.equal(await overlays(),1,'short swipe must stay');
 await swipe(70,220,80,350);assert.equal(await overlays(),1,'vertical scrolling must stay');
 const input=await run(`(()=>{const el=[...document.querySelectorAll('textarea')].find(n=>n.getClientRects().length);const r=el.getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2}})()`);
 await swipe(input.x,input.y,input.x+130,input.y);assert.equal(await overlays(),1,'text editing must stay');
 await swipe(65,330,245,337);await until(async()=>await overlays()===0,'chat swipe back');
 await chat();await run(`[...document.querySelectorAll('button[aria-label="Назад"]')].find(n=>n.getClientRects().length).click()`);await until(async()=>await overlays()===0,'back arrow');
 console.log('MOBILE_CHAT_SWIPE_OK: right swipe, preserved arrow, vertical scroll and text controls');
 await click('Созвездие');await until(()=>run(`(()=>{const el=document.querySelector('[title="Тест черновиков"]');if(!el)return false;el.click();return true})()`),'star');
 await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('Спутник черновиков')&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'satellite');
 await until(async()=>await overlays()===1,'channel overlay');
 await until(()=>run(`(()=>{const el=[...document.querySelectorAll('[data-mid="${bootstrap.fixtures.thread}"] button')].find(n=>n.textContent.includes('1 ответ')&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'thread summary');
 await until(async()=>await overlays()===2,'thread overlay');
 await swipe(65,350,245,357);await until(async()=>await overlays()===1,'thread-only swipe back');
 await swipe(65,350,245,357);await until(async()=>await overlays()===0,'channel swipe back');
 console.log('MOBILE_STAR_SWIPE_OK: topmost thread first, then channel list');
 win.webContents.debugger.detach();clearTimeout(deadline);win.destroy();app.quit();
}).catch(async error=>{console.error(error.stack||error);if(win)try{fs.writeFileSync(path.join(process.env.PAIR_TEST_PROFILE,'failure-navigation.png'),(await win.webContents.capturePage()).toPNG())}catch{}
 console.error('::error title=Mobile navigation::'+String(error.stack||error).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));clearTimeout(deadline);app.exit(1)});
