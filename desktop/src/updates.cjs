const { EventEmitter } = require('node:events');
const { updateUrl } = require('./policy.cjs');

class Updates extends EventEmitter {
  constructor({ updater, platform, arch, version, packaged, isBusy, quitAndInstall, openExternal, feed }) {
    super();
    Object.assign(this, { updater, platform, arch, packaged, isBusy, quitAndInstall, openExternal });
    this.feed = feed ?? updateUrl(platform, arch);
    this.manual = platform === 'darwin'; // Закрытый пилот: Developer ID и нотарификация отложены.
    this.state = { status: packaged ? 'idle' : 'disabled', currentVersion: version, manual: this.manual };
    this.inFlight = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.setFeedURL({ provider: 'generic', url: this.feed });
    updater.on('update-available', info => this.set({ status: 'available', version: info.version }));
    updater.on('update-not-available', () => this.set({ status: 'up-to-date', version: undefined, progress: undefined }));
    updater.on('download-progress', info => this.set({ status: 'downloading', progress: Math.round(info.percent) }));
    updater.on('update-downloaded', info => this.set({ status: 'downloaded', version: info.version, progress: 100 }));
    updater.on('error', () => this.failed());
  }
  set(patch) { this.state = { ...this.state, message: undefined, ...patch }; this.emit('state', this.state); }
  failed() { this.set({ status: 'error', message: 'Не удалось получить обновление. Текущей версией можно продолжать пользоваться.' }); }
  check() {
    if (!this.packaged || this.state.status === 'downloaded') return Promise.resolve(this.state);
    if (this.inFlight) return this.inFlight;
    this.set({ status: 'checking', progress: undefined });
    this.inFlight = Promise.resolve().then(async () => {
      try {
        await this.updater.checkForUpdates();
        if (this.state.status === 'available' && !this.manual) {
          this.set({ status: 'downloading', progress: 0 });
          await this.updater.downloadUpdate();
        }
      } catch { this.failed(); }
      finally { this.inFlight = null; }
      return this.state;
    });
    return this.inFlight;
  }
  async install() {
    if (this.isBusy()) return { ok: false, reason: 'Сначала завершите звонок или выйдите из комнаты.' };
    if (this.manual && this.state.status === 'available' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(this.state.version)) {
      await this.openExternal(`${this.feed}Quazar-${this.state.version}-mac-${this.arch}.dmg`);
      return { ok: true };
    }
    if (this.state.status !== 'downloaded' || this.manual) return { ok: false, reason: 'Обновление ещё не готово к установке.' };
    try {
      this.quitAndInstall();
      return this.state.status === 'error' ? { ok: false, reason: 'Не удалось запустить установщик. Повторите попытку.' } : { ok: true };
    } catch { this.failed(); return { ok: false, reason: 'Не удалось запустить установщик. Повторите попытку.' }; }
  }
}
module.exports = { Updates };
