from __future__ import annotations

from pipelines.feature_extraction.embedding import upload_r2_artifacts


def test_bridge_r2_credentials_maps_names_without_logging(monkeypatch) -> None:
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access-test")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret-test")
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

    upload_r2_artifacts._bridge_r2_credentials()

    assert upload_r2_artifacts.os.environ["AWS_ACCESS_KEY_ID"] == "access-test"
    assert upload_r2_artifacts.os.environ["AWS_SECRET_ACCESS_KEY"] == "secret-test"
