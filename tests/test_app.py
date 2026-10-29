"""Проверки серверной части Cogniflux, которые не требуют запущенного LM Studio.

Запуск из папки проекта:  python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as cogniflux  # noqa: E402


class ServerValidationTests(unittest.TestCase):
    def setUp(self):
        cogniflux.app.config["TESTING"] = True
        self.client = cogniflux.app.test_client()
        self.client.environ_base["HTTP_X_COGNIFLUX"] = "1"

    def test_config_endpoint(self):
        res = self.client.get("/api/config")
        self.assertEqual(res.status_code, 200)
        self.assertIn("default_base_url", res.get_json())

    def test_index_served(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Cogniflux", res.data)

    def test_models_rejects_bad_url(self):
        res = self.client.post("/api/models", json={"base_url": "ftp://x", "api_key": ""})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["code"], "bad_url")

    def test_chat_requires_model(self):
        res = self.client.post(
            "/api/chat",
            json={"base_url": "http://localhost:1234/v1", "model": "", "messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["code"], "no_model")

    def test_chat_rejects_unknown_role(self):
        res = self.client.post(
            "/api/chat",
            json={
                "base_url": "http://localhost:1234/v1",
                "model": "m",
                "messages": [{"role": "hacker", "content": "hi"}],
            },
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["code"], "bad_message")

    def test_chat_rejects_out_of_range_param(self):
        res = self.client.post(
            "/api/chat",
            json={
                "base_url": "http://localhost:1234/v1",
                "model": "m",
                "messages": [{"role": "user", "content": "hi"}],
                "params": {"temperature": 99},
            },
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["code"], "bad_param")

    def test_unreachable_server_gives_clear_message(self):
        # Порт 1 почти наверняка закрыт: ожидаем понятную ошибку подключения, а не «подключено».
        res = self.client.post("/api/models", json={"base_url": "http://127.0.0.1:1/v1", "api_key": ""})
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.get_json()["error"]["code"], "unreachable")


class LocalApiGuardTests(unittest.TestCase):
    def setUp(self):
        cogniflux.app.config["TESTING"] = True
        self.client = cogniflux.app.test_client()

    def test_post_without_header_is_forbidden(self):
        res = self.client.post("/api/tools/run", json={"name": "list_files", "arguments": {}, "chat_id": "x"})
        self.assertEqual(res.status_code, 403)

    def test_foreign_origin_is_forbidden(self):
        res = self.client.post(
            "/api/tools/run",
            json={"name": "list_files", "arguments": {}, "chat_id": "x"},
            headers={"X-Cogniflux": "1", "Origin": "https://evil.example"},
        )
        self.assertEqual(res.status_code, 403)

    def test_foreign_host_is_forbidden(self):
        res = self.client.get("/api/config", headers={"Host": "evil.example:8080"})
        self.assertEqual(res.status_code, 403)

    def test_get_config_without_header_is_allowed(self):
        self.assertEqual(self.client.get("/api/config").status_code, 200)

    def test_local_origin_with_header_is_allowed(self):
        res = self.client.post(
            "/api/tools/run",
            json={"name": "list_files", "arguments": {}, "chat_id": "_guard_probe"},
            headers={"X-Cogniflux": "1", "Origin": "http://127.0.0.1:8080"},
        )
        self.assertEqual(res.status_code, 200)
        cogniflux.delete_chat_folder("_guard_probe")


if __name__ == "__main__":
    unittest.main()
