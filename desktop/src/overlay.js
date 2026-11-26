// Оверлей: только рисует то, что прислал main-процесс (overlay.cjs уже проверил поля).
const SVG = 'http://www.w3.org/2000/svg';
// Перечёркнутый микрофон и перечёркнутые наушники.
const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M4 4l16 16',
  deaf: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3zM4 4l16 16',
  // Монитор — показывает экран; часы — «Орбита фокуса».
  screen: 'M3 4h18v12H3zM8 20h8M12 16v4',
  timer: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z',
};
function icon(name, title, className = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const t = document.createElementNS(SVG, 'title'); t.textContent = title; svg.append(t);
  const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', ICONS[name]); svg.append(p);
  if (className) svg.setAttribute('class', className);
  return svg;
}
// Сколько идёт запись: «0:07», «12:34», «1:02:03» — как в окне Quazar.
function elapsed(since, now = Date.now()) {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
let current = null;
function renderRecording() {
  const rec = current?.recording;
  document.getElementById('rec').hidden = !rec;
  if (!rec) return;
  document.getElementById('rec-text').textContent = ['Запись', rec.by, rec.since != null ? elapsed(rec.since) : ''].filter(Boolean).join(' · ');
}
// «Орбита фокуса»: «Фокус · 12:34», «Перерыв · 3:10», на паузе — «· пауза».
function renderFocus() {
  const focus = current?.focus;
  const line = document.getElementById('focus');
  line.hidden = !focus;
  if (!focus) return;
  const left = focus.running && focus.endsAt != null ? Math.max(0, Math.ceil((focus.endsAt - Date.now()) / 1000)) : focus.remaining;
  const text = `${focus.phase === 'work' ? 'Фокус' : 'Перерыв'} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${focus.running ? '' : ' · пауза'}`;
  line.replaceChildren(icon('timer', 'Орбита фокуса'), document.createTextNode(text));
}
setInterval(() => { renderRecording(); renderFocus(); }, 1000);
function render(state) {
  current = state;
  renderFocus();
  // Размер — масштабом всей панели (окно main-процесс уже подогнал), фон — своей непрозрачностью.
  const panel = document.getElementById('panel');
  panel.style.zoom = String(state.scale);
  panel.style.setProperty('--bg', String(state.opacity / 100));
  renderRecording();
  const room = document.getElementById('room');
  room.textContent = state.reconnecting ? 'Переподключение…' : state.room || 'Комната';
  room.classList.toggle('lost', state.reconnecting);
  const list = document.getElementById('peers');
  list.replaceChildren(...state.peers.map(peer => {
    const row = document.createElement('div');
    row.className = 'peer' + (peer.speaking ? ' speaking' : '');
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = [...peer.name][0]?.toUpperCase() ?? '?';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = peer.isLocal ? `${peer.name} (вы)` : peer.name;
    const marks = document.createElement('span'); marks.className = 'state';
    if (peer.sharing) marks.append(icon('screen', 'Показывает экран', 'screen'));
    if (!peer.micOn) marks.append(icon('mic', 'Микрофон выключен'));
    if (peer.deafened) marks.append(icon('deaf', 'Звук собеседников выключен'));
    row.append(avatar, name, marks);
    return row;
  }));
  const more = document.getElementById('more');
  more.hidden = !state.more;
  more.textContent = state.more ? `и ещё ${state.more}` : '';
}
window.quazarOverlay.onState(render);
