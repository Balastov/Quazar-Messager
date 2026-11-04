const { EventEmitter } = require('node:events');

/** Основное окно открывается только после проверки и, на Windows, установки найденного обновления. */
class Startup extends EventEmitter {
  constructor(updates) {
    super(); this.updates = updates; this.requiredVersion = null; this.inFlight = null;
    this.state = { phase: 'checking', currentVersion: updates.state.currentVersion, canContinue: false };
    this.listener = state => {
      if (this.state.phase === 'ready') return;
      if (state.version && ['available', 'downloading', 'downloaded'].includes(state.status)) this.requiredVersion = state.version;
      if (state.status === 'checking') this.set({ phase: 'checking', progress: undefined });
      if (state.status === 'downloading' || state.status === 'downloaded') this.set({ phase: 'downloading', progress: state.progress ?? 0, version: state.version });
      if (state.status === 'error') this.error();
    };
    updates.on('state', this.listener);
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }
  error(reason) {
    this.set({ phase: 'error', version: this.requiredVersion ?? undefined, canContinue: !this.requiredVersion,
      message: reason ?? (this.requiredVersion ? 'Обновление не удалось установить. Повторите попытку или завершите приложение.'
        : 'Не удалось проверить обновления. Проверьте подключение к интернету.') });
  }
  start() {
    if (this.inFlight) return this.inFlight;
    if (this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve(this.state);
    this.set({ phase: 'checking', canContinue: false });
    this.inFlight = Promise.resolve().then(async () => {
      try {
        const state = await this.updates.check();
        if (state.version && ['available', 'downloading', 'downloaded'].includes(state.status)) this.requiredVersion = state.version;
        if (state.status === 'up-to-date' || state.status === 'disabled' || state.manual) {
          this.requiredVersion = null;
          this.set({ phase: 'ready', canContinue: false });
        } else if (state.status === 'downloaded') {
          this.set({ phase: 'installing', version: state.version, progress: 100, canContinue: false });
          const result = await this.updates.install();
          if (!result.ok) this.error(result.reason);
        } else this.error();
      } catch { this.error(); }
      finally { this.inFlight = null; }
      return this.state;
    });
    return this.inFlight;
  }
  continueWithoutCheck() {
    if (this.state.phase !== 'error' || !this.state.canContinue || this.requiredVersion || this.inFlight) return false;
    this.set({ phase: 'ready', canContinue: false }); return true;
  }
  dispose() { this.updates.off('state', this.listener); }
}
module.exports = { Startup };
