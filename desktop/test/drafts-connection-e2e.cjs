// Local API, disposable DB/profile, synthetic microphone and muted audio. No real notifications.
const {app,BrowserWindow,session,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.PAIR_TEST_URL, bootstrap=JSON.parse(fs.readFileSync(process.env.PAIR_TEST_BOOTSTRAP,'utf8'));
app.setPath('userData',process.env.PAIR_TEST_PROFILE);app.on('window-all-closed',()=>{});
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('mute-audio');
let win,slow=false,fail=false;const notifications=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=code=>win.webContents.executeJavaScript(code);
async function reload(){const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.reload();await loaded;}
async function until(work,title,ms=20000){const at=Date.now();while(Date.now()-at<ms){try{const value=await work();if(value)return value}catch{}await pause(100)}throw Error('Timeout: '+title)}
async function click(text){await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button,[role="button"]')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length&&!n.disabled);if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true})()`),'button '+text)}
async function chat(name){await click('Чат');await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button,[role="button"]')].find(n=>n.textContent.includes(${JSON.stringify(name)})&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'chat '+name);await until(()=>run(`!!document.querySelector('textarea[aria-label="Сообщение"]:not(:disabled)')`),'draft ready')}
async function input(value,label='Сообщение'){await until(()=>run(`!!document.querySelector('textarea[aria-label=${JSON.stringify(label)}]:not(:disabled)')`),'input enabled');await run(`(()=>{const el=document.querySelector('textarea[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
async function value(label='Сообщение'){return run(`document.querySelector('textarea[aria-label=${JSON.stringify(label)}]')?.value`)}
async function openThread(){await until(()=>run(`(()=>{const el=[...document.querySelectorAll('[data-mid="${bootstrap.fixtures.thread}"] button')].find(n=>n.textContent.includes('1 ответ'));if(!el)return false;el.click();return true})()`),'thread summary')}
async function star(){await click('Созвездие');await until(()=>run(`(()=>{const el=[...document.querySelectorAll('[title],button')].find(n=>(n.title==='Тест черновиков'||n.getAttribute('aria-label')==='Тест черновиков')&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'star');await until(()=>run(`(()=>{const el=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('Спутник черновиков')&&n.getClientRects().length);if(!el)return false;el.click();return true})()`),'satellite');await until(()=>run(`!!document.querySelector('textarea[aria-label="Сообщение"]:not(:disabled)')`),'satellite draft')}
const deadline=setTimeout(()=>{console.error('Draft/connection browser test timed out');app.exit(1)},140000);
app.whenReady().then(async()=>{
 ipcMain.handle('desktop:update-state',()=>({status:'disabled',currentVersion:'1.0.0'}));ipcMain.handle('desktop:auth-return',()=>null);
 ipcMain.handle('desktop:notification',(_event,options)=>{notifications.push(options);return true});
 const ses=session.fromPartition('persist:drafts-connection');
 ses.setPermissionRequestHandler((_contents,permission,reply)=>reply(['media','notifications'].includes(permission)));
 ses.setPermissionCheckHandler((_contents,permission)=>['media','notifications'].includes(permission));
 ses.webRequest.onBeforeRequest((details,reply)=>{
  const url=new URL(details.url),local=new URL(base);if(!['data:','blob:'].includes(url.protocol)&&!(url.host===local.host)){reply({cancel:true});return}
  if(details.method==='POST'&&url.pathname.endsWith('/messages')){if(fail){fail=false;reply({cancel:true});return}if(slow){slow=false;setTimeout(()=>reply({cancel:false}),700);return}}
  reply({cancel:false});
 });
 win=new BrowserWindow({show:false,width:1080,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,
  preload:path.resolve(__dirname,'../src/preload.cjs'),additionalArguments:['--quazar-version=1.0.0','--quazar-server='+base]}});
 await win.loadURL(base+'/auth');await run(`localStorage.setItem('quazar-auth',JSON.stringify({state:${JSON.stringify({token:bootstrap.token,user:bootstrap.user})},version:0}));localStorage.setItem('quazar_e2e_backup_hint_dismissed','1')`);
 await win.loadURL(base+'/');
 await chat('Первый черновик');await input('Черновик первого чата');await chat('Второй черновик');assert.equal(await value(),'');await input('Черновик второго чата');
 await chat('Первый черновик');await until(async()=>await value()==='Черновик первого чата','first restored');
 await pause(250);await reload();await chat('Первый черновик');await until(async()=>await value()==='Черновик первого чата','reload restore');
 await run(`document.querySelector('[data-mid="${bootstrap.fixtures.edit_message}"] [aria-label="Действия с сообщением"]').click()`);await click('Изменить');
 await until(async()=>await value()==='Сообщение для правки','editing');await input('Исправленное сообщение');
 await run(`document.querySelector('[aria-label="Сохранить"]').click()`);await until(async()=>await value()==='Черновик первого чата','draft survives editing');
 slow=true;await run(`document.querySelector('form [aria-label="Отправить"]').click()`);await until(()=>run(`document.querySelector('form [aria-label="Отправить"]')?.disabled`),'send pending');
 await input('Новый текст во время отправки');await until(()=>run(`!document.querySelector('form [aria-label="Отправить"]')?.disabled`),'send accepted');assert.equal(await value(),'Новый текст во время отправки');
 fail=true;await run(`document.querySelector('form [aria-label="Отправить"]').click()`);await pause(300);assert.equal(await value(),'Новый текст во время отправки');
 await run(`document.querySelector('form [aria-label="Отправить"]').click()`);await until(async()=>await value()==='','successful send clears');
 await reload();await chat('Первый черновик');assert.equal(await value(),'');await chat('Второй черновик');await until(async()=>await value()==='Черновик второго чата','second persists');
 console.log('DRAFT_CHAT_OK: switching, reload, editing, in-flight typing, failure and confirmed clearing');
 await star();await input('Черновик Спутника');await openThread();await input('Черновик ветки','Ответ в ветке');
 await run(`document.querySelector('[aria-label="Ветка"] [aria-label="Закрыть ветку"]').click()`);await until(async()=>await value()==='Черновик Спутника','satellite preserved');
 await openThread();await until(async()=>await value('Ответ в ветке')==='Черновик ветки','thread restored');
 console.log('DRAFT_STAR_THREAD_OK: separate satellite and thread drafts');
 await click('Настройки');await click('Проверить связь');await click('Отправить тестовое уведомление');
 await until(()=>run(`document.body.textContent.includes('Устройство подтвердило передачу уведомления системе')`),'server notification receipt');
 assert.equal(notifications.filter(n=>n.tag.startsWith('quazar-test-')).length,1);
 await click('Уведомление пришло');await click('Послушать звонок');await click('Слышу звук');
 console.log('SERVER_RECEIPT_OK: targeted notification confirmed through actual API and WebSocket');
 await run(`window.testTracks=[];window.originalMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await window.originalMedia(...args);window.testTracks.push(...stream.getTracks());return stream};true`);
 await click('Проверить микрофон');await until(()=>run(`!!document.querySelector('progress[aria-label="Уровень микрофона"]')`),'microphone started');
 await click('Закрыть проверку связи');await until(()=>run(`window.testTracks.length>0&&window.testTracks.every(track=>track.readyState==='ended')`),'microphone released');
 console.log('CONNECTION_CHECK_OK: real server/WS receipt, native bridge, local fake mic lifecycle and ringtone UI');
 clearTimeout(deadline);win.destroy();app.quit();
}).catch(async error=>{console.error(error.stack||error);if(win){try{fs.writeFileSync(path.join(process.env.PAIR_TEST_PROFILE,'failure-drafts.png'),(await win.webContents.capturePage()).toPNG())}catch{}}
 console.error('::error title=Draft and connection integration::'+String(error.stack||error).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));clearTimeout(deadline);app.exit(1)});
