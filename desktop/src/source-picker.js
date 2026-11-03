window.capturePicker.list().then(result => {
  const audio = document.getElementById('audio');
  document.getElementById('audio-label').hidden = !result.audioRequested;
  audio.checked = result.audioRequested;
  for (const source of result.sources) {
    const button = document.createElement('button');
    const image = document.createElement('img'); image.src = source.thumbnail; image.alt = '';
    const name = document.createElement('span'); name.textContent = source.name;
    button.append(image, name); button.onclick = () => window.capturePicker.select(source.id, audio.checked);
    document.getElementById('sources').append(button);
  }
  if (!result.sources.length) document.getElementById('error').textContent = 'Нет доступных источников. Проверьте разрешение на запись экрана в настройках системы.';
}).catch(() => { document.getElementById('error').textContent = 'Не удалось получить список экранов. Закройте окно и повторите попытку.'; });
