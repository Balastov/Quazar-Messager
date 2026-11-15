const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const candidate = JSON.parse(fs.readFileSync('.github/desktop-release.json', 'utf8'));
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? '';
if (!/^\d+\.\d+\.\d+$/.test(candidate.version) || !/^[a-f0-9]{40}$/.test(candidate.source_sha) || !Number.isSafeInteger(candidate.run_id)) throw new Error('Invalid desktop release candidate');
const prefix = `desktop-v${candidate.version}-pilot.`;
if (!tag.startsWith(prefix) || !/^[1-9]\d*$/.test(tag.slice(prefix.length))) throw new Error('Tag must be desktop-v<version>-pilot.<number>');
// Приложение для Android входит в выпуск, когда в кандидате стоит "android": true.
const withAndroid = candidate.android === true;
for (const folder of withAndroid ? ['web', 'desktop', 'android'] : ['web', 'desktop']) {
  if (JSON.parse(fs.readFileSync(`${folder}/package.json`, 'utf8')).version !== candidate.version) throw new Error('Release version does not match shared client version');
}
// Инструкции публикации могут измениться; код приложений должен совпадать с проверенным CI.
execFileSync('git', ['diff', '--quiet', candidate.source_sha, 'HEAD', '--', 'web', 'desktop', 'android', 'backend', 'deploy', 'docker-compose.prod.yml']);

/** Код версии Android: 1.3.0 → 10300 (так же считает android/native/app/build.gradle). */
function androidVersionCode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major * 10000 + minor * 100 + patch;
}

async function prepare() {
  const root = path.resolve('desktop-release-assets');
  const files = [
    ['win-x64', `Quazar-${candidate.version}-win-x64.exe`],
    ['mac-arm64', `Quazar-${candidate.version}-mac-arm64.dmg`],
    ['mac-x64', `Quazar-${candidate.version}-mac-x64.dmg`],
  ];
  const hashes = [];
  for (const [platform, name] of files) {
    const file = path.join(root, `quazar-desktop-${platform}`, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 10_000_000) throw new Error(`Invalid installer: ${name}`);
    const handle = fs.openSync(file, 'r');
    try {
      const magic = Buffer.alloc(4);
      fs.readSync(handle, magic, 0, 4, name.endsWith('.exe') ? 0 : stat.size - 512);
      if (name.endsWith('.exe') ? magic.subarray(0, 2).toString() !== 'MZ' : magic.toString() !== 'koly') throw new Error(`Unexpected installer format: ${name}`);
    } finally { fs.closeSync(handle); }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    hashes.push(`${hash.digest('hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
  const plan = files.map(([platform, name], index) => ({ name, path: `desktop-release-assets/quazar-desktop-${platform}/${name}`,
    sha256: hashes[index].split(' ')[0], size: fs.statSync(path.join(root, `quazar-desktop-${platform}`, name)).size }));
  const checksumFile = fs.readFileSync(path.join(root, 'SHA256SUMS.txt'));
  plan.push({ name: 'SHA256SUMS.txt', path: 'desktop-release-assets/SHA256SUMS.txt', sha256: crypto.createHash('sha256').update(checksumFile).digest('hex'), size: checksumFile.length });
  const androidName = `Quazar-${candidate.version}-android.apk`;
  const androidFolder = path.join(root, 'quazar-desktop-android');
  if (withAndroid) {
    const file = path.join(androidFolder, androidName);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_000_000) throw new Error(`Invalid Android package: ${androidName}`);
    const handle = fs.openSync(file, 'r');
    try {
      const magic = Buffer.alloc(4);
      fs.readSync(handle, magic, 0, 4, 0);
      if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('Unexpected Android package format');
    } finally { fs.closeSync(handle); }
    const content = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    hashes.push(`${sha256}  ${androidName}`);
    fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
    // Файл обновлений для приложения: оно скачает APK отсюда и сверит контрольную сумму.
    const feed = { version: candidate.version, versionCode: androidVersionCode(candidate.version),
      url: `https://quazar-msg.ru/desktop-updates/android/${androidName}`, sha256 };
    fs.writeFileSync(path.join(androidFolder, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');
    plan.splice(files.length, 0, { name: androidName, path: path.relative(process.cwd(), file), sha256, size: content.length });
    const sums = fs.readFileSync(path.join(root, 'SHA256SUMS.txt'));
    const sumsEntry = plan.find(item => item.name === 'SHA256SUMS.txt');
    sumsEntry.sha256 = crypto.createHash('sha256').update(sums).digest('hex'); sumsEntry.size = sums.length;
  }
  const yaml = require('../../desktop/node_modules/js-yaml');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid repository');
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const publication = { version: candidate.version, download_base: base, channels: {} };
  for (const channel of ['win-x64', 'mac-arm64', 'mac-x64']) {
    const folder = path.join(root, `quazar-desktop-${channel}`);
    const metadata = channel === 'win-x64' ? 'latest.yml' : 'latest-mac.yml';
    const data = yaml.load(fs.readFileSync(path.join(folder, metadata), 'utf8'));
    if (data.version !== candidate.version || !Array.isArray(data.files) || !data.files.length) throw new Error('Invalid update feed');
    const required = new Set([metadata]);
    for (const file of data.files) {
      const stem = `Quazar-${candidate.version}-${channel}`;
      if (typeof file.url !== 'string' || ![`${stem}.exe`, `${stem}.dmg`, `${stem}.zip`].includes(file.url)) throw new Error('Unexpected update URL');
      const content = fs.readFileSync(path.join(folder, file.url));
      if (crypto.createHash('sha512').update(content).digest('base64') !== file.sha512 || content.length !== file.size) throw new Error('Update checksum mismatch');
      required.add(file.url);
      if (fs.existsSync(path.join(folder, file.url + '.blockmap'))) required.add(file.url + '.blockmap');
    }
    publication.channels[channel] = [];
    for (const name of required) {
      const content = fs.readFileSync(path.join(folder, name));
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const asset = name === metadata ? `latest-${channel}.yml` : name;
      let source = path.join(folder, name);
      if (name === metadata) {
        const metadataRoot = path.join(root, 'updater-metadata'); fs.mkdirSync(metadataRoot, { recursive: true });
        source = path.join(metadataRoot, asset); fs.copyFileSync(path.join(folder, name), source);
      }
      publication.channels[channel].push({ name, asset, sha256, size: content.length });
      if (!plan.some(item => item.name === asset)) plan.push({ name: asset, path: path.relative(process.cwd(), source), sha256, size: content.length });
    }
  }
  if (withAndroid) {
    publication.channels.android = [];
    for (const name of [androidName, 'latest.json']) {
      const content = fs.readFileSync(path.join(androidFolder, name));
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const asset = name === 'latest.json' ? 'latest-android.json' : name;
      publication.channels.android.push({ name, asset, sha256, size: content.length });
      if (name === 'latest.json') {
        const metadataRoot = path.join(root, 'updater-metadata'); fs.mkdirSync(metadataRoot, { recursive: true });
        const source = path.join(metadataRoot, asset); fs.copyFileSync(path.join(androidFolder, name), source);
        plan.push({ name: asset, path: path.relative(process.cwd(), source), sha256, size: content.length });
      }
    }
  }
  fs.writeFileSync(path.join(root, 'release-plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(root, 'publication.json'), JSON.stringify(publication));
  fs.copyFileSync('.github/scripts/publish-desktop-updates.py', path.join(root, 'publish-desktop-updates.py'));
  const androidLink = withAndroid ? `- [Android — APK](${base}/${androidName})\n` : '';
  const notes = `Тестовая версия Quazar ${candidate.version} для ${withAndroid ? 'Windows, macOS и Android' : 'Windows и macOS'}.

${Array.isArray(candidate.highlights) ? candidate.highlights.map(item => `- ${item}`).join('\n') + '\n' : ''}

Скачивание доступно без входа в GitHub:

- [Windows x64 — установщик EXE](${base}/${files[0][1]})
- [macOS Apple Silicon (M1 и новее) — DMG](${base}/${files[1][1]})
- [macOS Intel — DMG](${base}/${files[2][1]})
${androidLink}
На Windows запустите EXE. На Mac откройте DMG и перенесите Quazar в «Программы».${withAndroid ? ' На Android откройте APK и разрешите установку; дальше приложение обновляется само.' : ''}

Крестик скрывает окно; приложение продолжает работать в трее/строке меню. Для полного выхода выберите «Завершить Quazar».

На Windows новая версия устанавливается до открытия основного окна приложения. Во время работы обновление скачивается в фоне и предлагается перезапуск; активный разговор не прерывается. На Mac приложение проверяет версию и предлагает скачать DMG для ручной установки.

Сертификаты издателя и нотарификация пока не настроены: операционная система может показывать предупреждение при первом запуске. Проверка реальных звонков и демонстрации со звуком продолжается.

Контрольные суммы установщиков опубликованы в SHA256SUMS.txt.

Проверенная сборка: https://github.com/${repo}/actions/runs/${candidate.run_id}
Исходный коммит приложений: ${candidate.source_sha}
`;
  fs.writeFileSync(path.join(root, 'release-notes.md'), notes);
  console.log(`Validated installers prepared for the pilot release${withAndroid ? ' (with Android)' : ''}.`);
}
if (process.argv[2] === 'prepare') prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
else console.log(`Validated desktop release ${tag}, CI run ${candidate.run_id}.`);
