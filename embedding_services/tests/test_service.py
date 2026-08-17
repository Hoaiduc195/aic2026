import math
import unittest

from fastapi.testclient import TestClient

from embedding_services.app.config import ServiceSettings
from embedding_services.app.main import create_app


class FakeEncoder:
    model_name = "test-clip"
    model_version = "test-v1"
    dimensions = 1024
    device = "cpu"

    def __init__(self) -> None:
        self.last_text: str | None = None

    def embed_text(self, text: str) -> list[float]:
        self.last_text = text
        return [1.0 / math.sqrt(self.dimensions)] * self.dimensions


class WrongDimensionEncoder(FakeEncoder):
    def embed_text(self, text: str) -> list[float]:
        self.last_text = text
        return [0.0]


class EmbeddingServiceTests(unittest.TestCase):
    def test_health_and_embed_contract_require_bearer_token(self) -> None:
        encoder = FakeEncoder()
        client = TestClient(create_app(
            settings=ServiceSettings(token="service-secret"),
            encoder=encoder,
        ))

        health = client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")
        self.assertTrue(health.json()["ready"])

        unauthorized = client.post("/embed", json={"text": "a red car"})
        self.assertEqual(unauthorized.status_code, 401)

        response = client.post(
            "/embed",
            headers={"authorization": "Bearer service-secret"},
            json={"text": "  a red car  "},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload), {"embedding"})
        self.assertEqual(len(payload["embedding"]), 1024)
        self.assertEqual(encoder.last_text, "a red car")

    def test_rejects_invalid_text_and_wrong_encoder_dimension(self) -> None:
        client = TestClient(create_app(
            settings=ServiceSettings(max_text_chars=8),
            encoder=FakeEncoder(),
        ))
        self.assertEqual(client.post("/embed", json={"text": "   "}).status_code, 422)
        self.assertEqual(client.post("/embed", json={"text": "too long text"}).status_code, 422)

        wrong_client = TestClient(create_app(encoder=WrongDimensionEncoder()))
        response = wrong_client.post("/embed", json={"text": "query"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "embedding inference failed"})


if __name__ == "__main__":
    unittest.main()
