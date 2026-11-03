const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const candidate = JSON.parse(fs.readFileSync('.github/desktop-release.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME ?? process.env.RELEASE_TAG ?? '';
if (!/^\d+\.\d+\.\d+$/.test(candidate.version) || !/^[a-f0-9]{40}$/.test(candidate.source_sha) || !Number.isSafeInteger(candidate.run_id)) throw new Error('Invalid desktop release candidate');
const prefix = `desktop-v${candidate.version}-pilot.`;
if (!tag.startsWith(prefix) || !/^[1-9]\d*$/.test(tag.slice(prefix.length))) throw new Error('Tag must be desktop-v<version>-pilot.<number>');
for (const folder of ['web', 'desktop']) {
  if (JSON.parse(fs.readFileSync(`${folder}/package.json`, 'utf8')).version !== candidate.version) throw new Error('Release version does not match shared client version');
}
// Инструкции публикации могут измениться; код приложений должен совпадать с проверенным CI.
execFileSync('git', ['diff', '--quiet', candidate.source_sha, 'HEAD', '--', 'web', 'desktop', 'backend', 'deploy', 'docker-compose.prod.yml']);

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
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid repository');
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const notes = `Тестовая версия Quazar Desktop ${candidate.version} для Windows и macOS.

Скачивание доступно без входа в GitHub:

- [Windows x64 — установщик EXE](${base}/${files[0][1]})
- [macOS Apple Silicon (M1 и новее) — DMG](${base}/${files[1][1]})
- [macOS Intel — DMG](${base}/${files[2][1]})

На Windows запустите EXE. На Mac откройте DMG и перенесите Quazar в «Программы».

Крестик скрывает окно; приложение продолжает работать в трее/строке меню. Для полного выхода выберите «Завершить Quazar».

Сертификаты издателя и нотарификация пока не настроены: операционная система может показывать предупреждение при первом запуске. На Mac обновления пока устанавливаются вручную. Проверка реальных звонков и демонстрации со звуком продолжается.

Контрольные суммы установщиков опубликованы в SHA256SUMS.txt.

Проверенная сборка: https://github.com/${repo}/actions/runs/${candidate.run_id}
Исходный коммит приложений: ${candidate.source_sha}
`;
  fs.writeFileSync(path.join(root, 'release-notes.md'), notes);
  console.log('Three validated desktop installers prepared for the pilot release.');
}
if (process.argv[2] === 'prepare') prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
else console.log(`Validated desktop release ${tag}, CI run ${candidate.run_id}.`);
