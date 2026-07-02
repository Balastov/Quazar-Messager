import json
from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    """
    Хранит активные WebSocket-соединения.
    user_connections: user_id -> список WebSocket (мультиустройства)
    chat_members: chat_id -> set user_id  (in-memory кэш, заполняется при подключении)
    """

    def __init__(self):
        self.user_connections: dict[str, list[WebSocket]] = defaultdict(list)

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.user_connections[user_id].append(websocket)

    def disconnect(self, websocket: WebSocket, user_id: str):
        conns = self.user_connections.get(user_id, [])
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            self.user_connections.pop(user_id, None)

    async def send_to_user(self, user_id: str, event: dict):
        for ws in list(self.user_connections.get(user_id, [])):
            try:
                await ws.send_text(json.dumps(event))
            except Exception:
                pass

    async def broadcast_to_chat(self, chat_id: str, event: dict, exclude_user: str | None = None):
        """
        Рассылает событие всем онлайн-участникам чата.
        Список участников берётся из БД в момент вызова (через аргумент user_ids).
        """
        # user_ids передаются снаружи через broadcast_to_users
        pass

    async def broadcast_to_users(self, user_ids: list[str], event: dict, exclude_user: str | None = None):
        for uid in user_ids:
            if uid == exclude_user:
                continue
            await self.send_to_user(uid, event)


manager = ConnectionManager()
