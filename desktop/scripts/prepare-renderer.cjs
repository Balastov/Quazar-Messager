const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const web = path.resolve(desktop, '../web');
const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
// Единственный источник версии — web/package.json; отдельного десктопного номера нет.
const own = path.join(desktop, 'package.json');
const metadata = JSON.parse(fs.readFileSync(own, 'utf8'));
if (metadata.version !== pkg.version) {
  metadata.version = pkg.version;
  fs.writeFileSync(own, JSON.stringify(metadata, null, 2) + '\n');
  const lockFile = path.join(desktop, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = pkg.version;
  if (lock.packages?.['']) lock.packages[''].version = pkg.version;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}
const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: web, stdio: 'inherit', shell: process.platform === 'win32' });
if (built.status !== 0) process.exit(built.status ?? 1);
fs.rmSync(path.join(desktop, 'renderer'), { recursive: true, force: true });
fs.cpSync(path.join(web, 'dist'), path.join(desktop, 'renderer'), { recursive: true });
console.log(`Shared renderer ${pkg.version} prepared.`);
