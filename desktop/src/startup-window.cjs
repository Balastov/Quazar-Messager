/** Keep the splash visible until the main page has loaded and painted. No minimum delay. */
async function waitForMainWindow(window, url) {
  let painted, closed;
  const ready = new Promise((resolve, reject) => {
    painted = resolve;
    closed = () => reject(new Error('Main window closed during startup'));
    window.once('ready-to-show', painted);
    window.once('closed', closed);
  });
  try {
    await Promise.all([window.loadURL(url), ready]);
    return !window.isDestroyed();
  } finally {
    window.removeListener('ready-to-show', painted);
    window.removeListener('closed', closed);
  }
}
module.exports = { waitForMainWindow };
