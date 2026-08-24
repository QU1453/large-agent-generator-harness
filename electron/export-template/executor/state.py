# 会话存储：data/sessions/<id>.json（简单 JSON 落盘）
import json
import os
import time
import uuid

class SessionStore:
    def __init__(self, data_dir):
        self.dir = os.path.join(data_dir, 'sessions')
        os.makedirs(self.dir, exist_ok=True)

    def create(self, agent_id=None):
        sid = uuid.uuid4().hex[:12]
        s = {'id': sid, 'agentId': agent_id, 'messages': [], 'ts': time.time()}
        self.save(s)
        return s

    def get(self, sid):
        if not sid:
            return None
        fp = os.path.join(self.dir, sid + '.json')
        if not os.path.exists(fp):
            return None
        try:
            with open(fp, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None

    def save(self, s):
        fp = os.path.join(self.dir, (s.get('id') or 'session') + '.json')
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(s, f, ensure_ascii=False)
