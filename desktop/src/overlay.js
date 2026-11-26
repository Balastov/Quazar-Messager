// Оверлей: только рисует то, что прислал main-процесс (overlay.cjs уже проверил поля).
const SVG = 'http://www.w3.org/2000/svg';
// Перечёркнутый микрофон и перечёркнутые наушники.
const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M4 4l16 16',
  deaf: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3zM4 4l16 16',
};
function icon(name, title) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const t = document.createElementNS(SVG, 'title'); t.textContent = title; svg.append(t);
  const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', ICONS[name]); svg.append(p);
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
setInterval(renderRecording, 1000);
function render(state) {
  current = state;
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
