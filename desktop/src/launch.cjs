/** A web launch opens the app and updates it using the verified native updater. */
class DesktopLauncher {
  constructor({ updates, show, isStarting, onState, onBlocked }) {
    Object.assign(this, { updates, show, isStarting, onState, onBlocked });
    this.pending = false; this.inFlight = null;
  }
  run(alreadyChecked = false) {
    this.show();
    if (this.isStarting()) { this.pending = true; return Promise.resolve(); }
    if (this.inFlight) return this.inFlight;
    this.pending = false;
    this.inFlight = Promise.resolve().then(async () => {
      try {
        const state = alreadyChecked ? this.updates.state : await this.updates.check();
        this.onState({ ...state, requested: true });
        if (state.status === 'downloaded' || (state.manual && state.status === 'available')) {
          const result = await this.updates.install();
          if (!result.ok) await this.onBlocked(result.reason ?? 'Не удалось установить обновление.');
        } else if (state.status === 'error') await this.onBlocked(state.message ?? 'Не удалось проверить обновления.');
      } catch { await this.onBlocked('Не удалось начать обновление. Повторите попытку в приложении.'); }
      finally { this.inFlight = null; }
    });
    return this.inFlight;
  }
  ready() { return this.pending ? this.run(true) : Promise.resolve(); }
}
module.exports = { DesktopLauncher };
