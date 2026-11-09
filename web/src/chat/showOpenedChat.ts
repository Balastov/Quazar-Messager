import { useUiStore } from "../store/ui";

/**
 * Открыть чат и показать его. Открытие асинхронное (сообщения, ключи) и на медленной сети
 * длится секунды: если за это время человек ушёл на другую вкладку, назад его не возвращаем.
 */
export async function showOpenedChat(open: () => Promise<unknown>): Promise<void> {
  const tabAtClick = useUiStore.getState().tab;
  await open();
  const ui = useUiStore.getState();
  if (ui.tab !== tabAtClick) return;
  ui.setTab("chats");
  ui.setMobileChatOpen(true);
}
