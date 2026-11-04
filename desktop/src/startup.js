const headings = { checking: 'Проверяем обновления…', downloading: 'Загружаем обновление…', installing: 'Устанавливаем обновление…', error: 'Не удалось обновить Quazar', ready: 'Открываем Quazar…' };
const messages = { checking: 'Это займёт немного времени.', downloading: 'Новая версия будет установлена до запуска приложения.', installing: 'Приложение автоматически перезапустится.', ready: 'Подготавливаем приложение.' };
let received = false;
function render(state) {
  document.getElementById('heading').textContent = headings[state.phase] ?? headings.checking;
  document.getElementById('message').textContent = state.message && state.phase === 'error' ? state.message : messages[state.phase] ?? '';
  document.getElementById('version').textContent = state.version ? `${state.currentVersion} → ${state.version}` : `Версия ${state.currentVersion}`;
  const progress = document.getElementById('progress');
  progress.hidden = state.phase === 'error';
  if (state.phase === 'downloading' || state.phase === 'installing') { progress.max = 100; progress.value = state.progress ?? 0; }
  else progress.removeAttribute('value');
  document.getElementById('retry').hidden = state.phase !== 'error';
  document.getElementById('continue').hidden = state.phase !== 'error' || !state.canContinue;
  document.getElementById('retry').disabled = false;
}
window.quazarStartup.onState(state => { received = true; render(state); });
window.quazarStartup.state().then(state => { if (!received) render(state); });
document.getElementById('retry').onclick = () => { document.getElementById('retry').disabled = true; void window.quazarStartup.retry(); };
document.getElementById('continue').onclick = () => { void window.quazarStartup.continueWithoutCheck(); };
document.getElementById('quit').onclick = () => window.quazarStartup.quit();
