const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { build, Platform, Arch } = require('electron-builder');
if (process.platform !== 'win32') throw new Error('This installed-update test requires a disposable Windows runner');
const root = path.resolve('release/.windows-upgrade');
const appDir = path.join(root, 'app');
const installed = path.join(root, 'installed');
const resultFile = path.join(root, 'result.json');
const outputs = [path.join(root, 'v1'), path.join(root, 'v2')];
fs.mkdirSync(appDir, { recursive: true });
const server = http.createServer((request, response) => {
  const name = path.basename(new URL(request.url, 'http://fixture').pathname);
  const file = [outputs[1], outputs[0]].map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
  if (!file) { response.writeHead(404).end(); return; }
  const size = fs.statSync(file).size;
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
  fs.createReadStream(file).pipe(response);
});
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Installer exited ${code}`)));
  });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const feed = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(appDir, 'fixture.json'), JSON.stringify({ feed, profile: path.join(root, 'profile'), result: resultFile }));
  fs.copyFileSync(path.resolve('test/update-fixture.cjs'), path.join(appDir, 'main.cjs'));
  for (const file of ['updates.cjs', 'startup.cjs', 'policy.cjs']) fs.copyFileSync(path.resolve('src', file), path.join(appDir, file));
  const lock = require('../package-lock.json');
  for (const [name, metadata] of Object.entries(lock.packages)) {
    if (!name.startsWith('node_modules/') || metadata.dev || metadata.devOptional) continue;
    fs.cpSync(path.resolve(name), path.join(appDir, name), { recursive: true });
  }
  for (const [index, version] of ['0.0.1', '0.0.2'].entries()) {
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'quazar-update-fixture', version, main: 'main.cjs',
      description: 'Disposable installed-update test', author: 'Quazar tests', dependencies: { 'electron-updater': require('../package.json').dependencies['electron-updater'] } }));
    await build({ projectDir: appDir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config: {
      appId: 'ru.quazar.update-fixture', productName: 'QuazarUpdateFixture', electronVersion: require('electron/package.json').version,
      npmRebuild: false,
      directories: { app: appDir, output: outputs[index] }, files: ['*.cjs', '*.json'],
      artifactName: 'Fixture-${version}.${ext}', publish: [{ provider: 'generic', url: feed }],
      win: { signAndEditExecutable: false }, nsis: { oneClick: true, perMachine: false, runAfterFinish: false, deleteAppDataOnUninstall: false },
    }, publish: 'never' });
  }
  await run(path.join(outputs[0], 'Fixture-0.0.1.exe'), ['/S', `/D=${installed}`]);
  const appProcess = spawn(path.join(installed, 'QuazarUpdateFixture.exe'), [], { stdio: 'ignore' });
  appProcess.on('error', error => fs.writeFileSync(resultFile, JSON.stringify({ error: error.message })));
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(fs.existsSync(resultFile), 'Updated application did not restart');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.version, '0.0.2'); assert.equal(result.profilePreserved, true);
  console.log('INSTALLED_WINDOWS_UPGRADE_OK: 0.0.1 -> 0.0.2, automatic restart and retained profile');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
