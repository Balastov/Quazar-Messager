import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pilot_route', Path(__file__).with_name('ensure-pilot-route.py'))
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


class PilotRouteTest(unittest.TestCase):
    def test_addition_preserves_existing_routes_and_is_idempotent(self):
        before = 'server {\n    server_name quazar-msg.ru;\n    location /api/ {\n        proxy_pass http://127.0.0.1:8002/;\n    }\n}\n'
        after = route.render(before)
        self.assertEqual(after.replace(route.BLOCK + '\n', ''), before)
        self.assertEqual(route.render(after), after)
        self.assertIn('127.0.0.1:18084/', after)

    def test_unknown_vhost_and_unknown_existing_pilot_route_are_rejected(self):
        for text in ['server { server_name other.test; }',
                     'location ^~ /bitrix24-pilot/ { proxy_pass http://other; }']:
            with self.assertRaises(ValueError): route.render(text)
