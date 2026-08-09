import io
import tempfile
import unittest
from pathlib import Path

from pipelines.preprocessing.video_source import (
    LocalVideoSource,
    R2RangeReader,
    S3CompatibleVideoSource,
    VideoSourceError,
    open_video_source,
    parse_video_uri,
    validate_endpoint_url,
)


class FakeS3Client:
    def __init__(self, data: bytes, *, etag='"fake-etag"', version_id=None):
        self.data = data
        self.etag = etag
        self.version_id = version_id
        self.head_calls = []
        self.head_requests = []
        self.range_calls = []
        self.object_requests = []

    def head_object(self, *, Bucket, Key, VersionId=None):
        self.head_calls.append((Bucket, Key))
        self.head_requests.append({"Bucket": Bucket, "Key": Key, "VersionId": VersionId})
        response = {"ContentLength": len(self.data)}
        if self.etag is not None:
            response["ETag"] = self.etag
        if self.version_id is not None:
            response["VersionId"] = self.version_id
        return response

    def get_object(self, *, Bucket, Key, Range, IfMatch=None, VersionId=None):
        self.asserted_if_match = IfMatch
        self.range_calls.append((Bucket, Key, Range))
        self.object_requests.append({
            "Bucket": Bucket,
            "Key": Key,
            "Range": Range,
            "IfMatch": IfMatch,
            "VersionId": VersionId,
        })
        prefix, interval = Range.split("=", 1)
        assert prefix == "bytes"
        start_text, end_text = interval.split("-", 1)
        start, end = int(start_text), int(end_text)
        response = {
            "Body": io.BytesIO(self.data[start : end + 1]),
            "ContentRange": f"bytes {start}-{end}/{len(self.data)}",
        }
        if self.etag is not None:
            response["ETag"] = self.etag
        if self.version_id is not None:
            response["VersionId"] = self.version_id
        return response


class VideoURIParsingTest(unittest.TestCase):
    def test_parses_local_path_and_file_uri(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip with spaces.mp4"
            path.write_bytes(b"video")

            plain = parse_video_uri(path)
            encoded = parse_video_uri(path.resolve().as_uri())

            self.assertEqual(plain.scheme, "local")
            self.assertEqual(plain.path, path)
            self.assertEqual(encoded.scheme, "local")
            self.assertEqual(encoded.path, path.resolve())

    def test_parses_s3_compatible_uri(self):
        parsed = parse_video_uri("r2://raw-videos/folder/clip%201.mp4")

        self.assertEqual(parsed.scheme, "r2")
        self.assertEqual(parsed.bucket, "raw-videos")
        self.assertEqual(parsed.key, "folder/clip 1.mp4")

    def test_rejects_unsafe_or_incomplete_remote_uris(self):
        invalid = [
            "r2://access:secret@bucket/video.mp4",
            "s3://bucket",
            "r2://bucket/video.mp4?token=secret",
            "r2://bucket/video.mp4?",
            "file:///D:/video.mp4#",
            "https://example.com/video.mp4",
            "s3://bucket/bad%ZZname.mp4",
        ]
        for uri in invalid:
            with self.subTest(uri=uri), self.assertRaises(VideoSourceError):
                parse_video_uri(uri)

    def test_validates_credential_free_tls_endpoints(self):
        self.assertEqual(
            validate_endpoint_url("https://account.r2.cloudflarestorage.com"),
            "https://account.r2.cloudflarestorage.com",
        )
        self.assertEqual(
            validate_endpoint_url("http://127.0.0.1:9000"),
            "http://127.0.0.1:9000",
        )
        for endpoint in (
            "http://storage.example.com",
            "https://user:secret@storage.example.com",
            "https://storage.example.com?token=secret",
            "https://storage.example.com?",
            "https://storage.example.com/#fragment",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(VideoSourceError):
                validate_endpoint_url(endpoint)


class LocalVideoSourceTest(unittest.TestCase):
    def test_factory_context_yields_existing_local_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"fake video bytes")

            source = open_video_source(path)
            self.assertIsInstance(source, LocalVideoSource)
            with source as opened:
                self.assertEqual(opened, path)
                self.assertEqual(opened.read_bytes(), b"fake video bytes")

    def test_missing_local_video_fails_when_opened(self):
        source = open_video_source(Path("definitely-missing-video.mp4"))

        with self.assertRaisesRegex(VideoSourceError, "does not exist"):
            with source:
                pass


class R2RangeReaderTest(unittest.TestCase):
    def setUp(self):
        self.data = b"abcdefghijklmnopqrstuvwxyz"
        self.client = FakeS3Client(self.data)

    def test_read_crosses_ranges_and_uses_chunk_cache(self):
        reader = R2RangeReader(
            self.client, "bucket", "clip.mp4", chunk_size=8, max_cached_chunks=2
        )

        self.assertEqual(reader.read(10), b"abcdefghij")
        self.assertEqual(self.client.asserted_if_match, '"fake-etag"')
        self.assertEqual(
            [call[2] for call in self.client.range_calls],
            ["bytes=0-7", "bytes=8-15"],
        )

        reader.seek(2)
        self.assertEqual(reader.read(4), b"cdef")
        self.assertEqual(len(self.client.range_calls), 2, "first chunk should be cached")

    def test_seek_modes_eof_and_readinto(self):
        reader = R2RangeReader(
            self.client, "bucket", "clip.mp4", chunk_size=5, max_cached_chunks=1
        )

        self.assertEqual(reader.seek(-3, io.SEEK_END), 23)
        self.assertEqual(reader.read(), b"xyz")
        self.assertEqual(reader.seek(5), 5)
        target = bytearray(4)
        self.assertEqual(reader.readinto(target), 4)
        self.assertEqual(bytes(target), b"fghi")
        self.assertEqual(reader.seek(100), 100)
        self.assertEqual(reader.read(1), b"")
        with self.assertRaises(ValueError):
            reader.seek(-1)

    def test_empty_object_never_requests_a_range(self):
        client = FakeS3Client(b"")
        reader = R2RangeReader(client, "bucket", "empty.mp4", chunk_size=4)

        self.assertEqual(reader.size, 0)
        self.assertEqual(reader.read(), b"")
        self.assertEqual(client.range_calls, [])

    def test_close_disables_io(self):
        reader = R2RangeReader(self.client, "bucket", "clip.mp4", chunk_size=8)
        reader.close()

        with self.assertRaises(ValueError):
            reader.read(1)
        with self.assertRaises(ValueError):
            reader.seek(0)

    def test_rejects_unversioned_or_wrong_range_responses(self):
        class Unversioned(FakeS3Client):
            def head_object(self, *, Bucket, Key):
                return {"ContentLength": len(self.data)}

        with self.assertRaisesRegex(VideoSourceError, "ETag or VersionId"):
            R2RangeReader(Unversioned(self.data), "bucket", "clip.mp4")

        class WrongRange(FakeS3Client):
            def get_object(self, **kwargs):
                response = super().get_object(**kwargs)
                response["ContentRange"] = "bytes 1-8/26"
                return response

        reader = R2RangeReader(WrongRange(self.data), "bucket", "clip.mp4", chunk_size=8)
        with self.assertRaisesRegex(VideoSourceError, "ContentRange"):
            reader.read(1)

    def test_expected_identity_pins_head_and_versioned_ranges(self):
        client = FakeS3Client(self.data, etag='"v1-etag"', version_id="version-1")
        reader = R2RangeReader(
            client,
            "bucket",
            "clip.mp4",
            chunk_size=8,
            expected_etag='"v1-etag"',
            expected_version_id="version-1",
        )

        self.assertEqual(client.head_requests[0]["VersionId"], "version-1")
        self.assertEqual(reader.read(2), b"ab")
        self.assertEqual(client.object_requests[0]["VersionId"], "version-1")
        self.assertEqual(client.object_requests[0]["IfMatch"], '"v1-etag"')

    def test_rejects_expected_or_response_identity_mismatch(self):
        with self.assertRaisesRegex(VideoSourceError, "ETag does not match"):
            R2RangeReader(
                FakeS3Client(self.data, etag='"actual"'),
                "bucket",
                "clip.mp4",
                expected_etag='"expected"',
            )

        with self.assertRaisesRegex(VideoSourceError, "VersionId does not match"):
            R2RangeReader(
                FakeS3Client(self.data, version_id="actual-version"),
                "bucket",
                "clip.mp4",
                expected_version_id="expected-version",
            )

        class ChangedETag(FakeS3Client):
            def get_object(self, **kwargs):
                response = super().get_object(**kwargs)
                response["ETag"] = '"changed"'
                return response

        reader = R2RangeReader(ChangedETag(self.data), "bucket", "clip.mp4", chunk_size=8)
        with self.assertRaisesRegex(VideoSourceError, "changed"):
            reader.read(1)

    def test_retries_transient_range_failure(self):
        class FlakyClient(FakeS3Client):
            def __init__(self, data):
                super().__init__(data)
                self.attempts = 0

            def get_object(self, **kwargs):
                self.attempts += 1
                if self.attempts == 1:
                    raise OSError("transient body failure")
                return super().get_object(**kwargs)

        client = FlakyClient(self.data)
        reader = R2RangeReader(client, "bucket", "clip.mp4", chunk_size=8, max_retries=1)

        self.assertEqual(reader.read(1), b"a")
        self.assertEqual(client.attempts, 2)


class RemoteVideoSourceFactoryTest(unittest.TestCase):
    def test_factory_uses_injected_client_and_closes_reader(self):
        client = FakeS3Client(b"0123456789")
        source = open_video_source(
            "r2://videos/a/b.mp4", client=client, chunk_size=4
        )

        self.assertIsInstance(source, S3CompatibleVideoSource)
        with source as opened:
            self.assertTrue(opened.seekable())
            self.assertEqual(opened.read(6), b"012345")
            reader = opened

        self.assertTrue(reader.closed)
        self.assertEqual(client.head_calls, [("videos", "a/b.mp4")])

    def test_factory_forwards_expected_remote_identity(self):
        client = FakeS3Client(b"0123", etag='"manifest-etag"', version_id="manifest-v1")
        source = open_video_source(
            "s3://videos/clip.mp4",
            client=client,
            expected_etag='"manifest-etag"',
            expected_version_id="manifest-v1",
        )

        with source as opened:
            self.assertEqual(opened.etag, '"manifest-etag"')
            self.assertEqual(opened.version_id, "manifest-v1")

    def test_r2_without_client_requires_endpoint(self):
        with self.assertRaisesRegex(VideoSourceError, "endpoint_url"):
            open_video_source("r2://videos/clip.mp4")


if __name__ == "__main__":
    unittest.main()
