"""Seekable video inputs backed by a local file or S3-compatible storage.

The public entry point is :func:`open_video_source`::

    with open_video_source(uri, client=r2_client) as source:
        container = av.open(source)

For local URIs, ``source`` is a :class:`pathlib.Path`.  For ``s3://`` and
``r2://`` URIs, it is a seekable binary reader that translates reads into
HTTP byte-range requests through an injected boto3-compatible client.
"""

from __future__ import annotations

import io
import ipaddress
import os
import re
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass
from operator import index as integer_index
from pathlib import Path
from threading import RLock
from typing import Any, BinaryIO, Literal
from urllib.parse import SplitResult, unquote, urlsplit


DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
DEFAULT_CACHE_CHUNKS = 4
DEFAULT_MAX_RETRIES = 2
_WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_SAFE_BUCKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
_SAFE_FILE_AUTHORITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")


class VideoSourceError(ValueError):
    """Raised when a video URI or its backing object cannot be opened."""


def validate_endpoint_url(endpoint_url: str) -> str:
    """Validate a credential-free S3-compatible service endpoint.

    Production endpoints must use HTTPS. Plain HTTP is accepted only for an
    explicit localhost or loopback endpoint used by local S3 emulators.
    """

    if not isinstance(endpoint_url, str) or not endpoint_url:
        raise VideoSourceError("Object-storage endpoint must be a non-empty URL")
    if any(character.isspace() for character in endpoint_url) or "\x00" in endpoint_url:
        raise VideoSourceError("Object-storage endpoint contains invalid characters")
    try:
        parts = urlsplit(endpoint_url)
    except ValueError:
        raise VideoSourceError("Object-storage endpoint is malformed") from None
    if parts.scheme not in {"http", "https"} or not parts.netloc or parts.hostname is None:
        raise VideoSourceError("Object-storage endpoint must be an absolute HTTP(S) URL")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise VideoSourceError("Credentials must not be embedded in an object-storage endpoint")
    if "?" in endpoint_url or "#" in endpoint_url:
        raise VideoSourceError("Object-storage endpoint must not contain a query or fragment")
    try:
        parts.port
    except ValueError:
        raise VideoSourceError("Object-storage endpoint has an invalid port") from None

    if parts.scheme == "http":
        hostname = parts.hostname.lower()
        is_loopback = hostname == "localhost"
        if not is_loopback:
            try:
                is_loopback = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                is_loopback = False
        if not is_loopback:
            raise VideoSourceError(
                "Plain HTTP object-storage endpoints are allowed only on localhost/loopback"
            )
    return endpoint_url


@dataclass(frozen=True)
class ParsedVideoURI:
    """A credential-free, normalized description of a video location."""

    scheme: Literal["local", "s3", "r2"]
    path: Path | None = None
    bucket: str | None = None
    key: str | None = None


def _safe_unquote(value: str, field_name: str) -> str:
    if _INVALID_PERCENT_ESCAPE.search(value):
        raise VideoSourceError(f"Invalid percent escape in {field_name}")
    decoded = unquote(value)
    if "\x00" in decoded:
        raise VideoSourceError(f"NUL bytes are not allowed in {field_name}")
    return decoded


def _reject_uri_extras(parts: SplitResult) -> None:
    if parts.query or parts.fragment:
        raise VideoSourceError("Video storage URIs must not contain a query or fragment")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise VideoSourceError(
            "Credentials must not be embedded in a video URI; configure the client separately"
        )


def _parse_file_uri(parts: SplitResult) -> Path:
    _reject_uri_extras(parts)
    authority = _safe_unquote(parts.netloc, "file URI authority")
    if (
        authority
        and authority.lower() != "localhost"
        and not _SAFE_FILE_AUTHORITY.fullmatch(authority)
    ):
        raise VideoSourceError("file:// URI contains an invalid authority")
    raw_path = _safe_unquote(parts.path, "file URI path")
    if not raw_path:
        raise VideoSourceError("file:// URI must contain a path")

    is_local_authority = not authority or authority.lower() == "localhost"
    if os.name == "nt":
        windows_path = raw_path.replace("/", "\\")
        if is_local_authority:
            # file:///C:/video.mp4 is represented by urlsplit as /C:/video.mp4.
            if re.match(r"^\\[A-Za-z]:", windows_path):
                windows_path = windows_path[1:]
        else:
            windows_path = f"\\\\{authority}{windows_path}"
        return Path(windows_path)

    if not is_local_authority:
        raw_path = f"//{authority}{raw_path}"
    return Path(raw_path)


def parse_video_uri(uri: str | os.PathLike[str]) -> ParsedVideoURI:
    """Parse a local path, ``file://``, ``s3://``, or ``r2://`` video URI.

    Authentication data in a URI is deliberately rejected so source objects,
    logs, and exceptions cannot accidentally expose credentials.
    """

    if isinstance(uri, os.PathLike):
        path = Path(uri)
        if "\x00" in os.fspath(path):
            raise VideoSourceError("NUL bytes are not allowed in a local path")
        return ParsedVideoURI(scheme="local", path=path)
    if not isinstance(uri, str):
        raise TypeError("uri must be a string or path-like object")
    if not uri:
        raise VideoSourceError("Video URI must not be empty")
    if "\x00" in uri:
        raise VideoSourceError("NUL bytes are not allowed in a video URI")

    # urlsplit treats a Windows drive letter as a URI scheme.
    if _WINDOWS_DRIVE_PATH.match(uri) or uri.startswith("\\\\"):
        return ParsedVideoURI(scheme="local", path=Path(uri))

    try:
        parts = urlsplit(uri)
    except ValueError:
        raise VideoSourceError("Video URI is malformed") from None
    scheme = parts.scheme.lower()
    if not scheme:
        return ParsedVideoURI(scheme="local", path=Path(uri))
    if scheme == "file":
        if "?" in uri or "#" in uri:
            raise VideoSourceError("Video storage URIs must not contain a query or fragment")
        return ParsedVideoURI(scheme="local", path=_parse_file_uri(parts))
    if scheme not in {"s3", "r2"}:
        raise VideoSourceError(f"Unsupported video URI scheme: {scheme!r}")

    if "?" in uri or "#" in uri:
        raise VideoSourceError("Video storage URIs must not contain a query or fragment")

    _reject_uri_extras(parts)
    bucket = parts.netloc
    if not bucket or not _SAFE_BUCKET.fullmatch(bucket):
        raise VideoSourceError("S3-compatible URI must contain a valid bucket name")
    if not parts.path.startswith("/"):
        raise VideoSourceError("S3-compatible URI must contain an object key")
    key = _safe_unquote(parts.path[1:], "object key")
    if not key:
        raise VideoSourceError("S3-compatible URI must contain an object key")

    return ParsedVideoURI(scheme=scheme, bucket=bucket, key=key)


class VideoSource(ABC):
    """Context-managed input that yields a value accepted by ``av.open``."""

    def __init__(self) -> None:
        self._active: Path | BinaryIO | None = None

    @abstractmethod
    def open(self) -> Path | BinaryIO:
        """Open and return a local path or a seekable binary stream."""

    def __enter__(self) -> Path | BinaryIO:
        if self._active is not None:
            raise RuntimeError("Video source context is already open")
        self._active = self.open()
        return self._active

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        active, self._active = self._active, None
        close = getattr(active, "close", None)
        if callable(close):
            close()


class LocalVideoSource(VideoSource):
    """A validated path to a video on the local filesystem."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        super().__init__()
        self.path = Path(path)

    def open(self) -> Path:
        if not self.path.exists():
            raise VideoSourceError(f"Local video does not exist: {self.path}")
        if not self.path.is_file():
            raise VideoSourceError(f"Local video path is not a file: {self.path}")
        return self.path

    def __repr__(self) -> str:
        return f"LocalVideoSource(path={self.path!r})"


def _positive_integer(value: int, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a positive integer")
    try:
        parsed = integer_index(value)
    except TypeError:
        raise ValueError(f"{name} must be a positive integer") from None
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


class R2RangeReader(io.RawIOBase):
    """Seekable S3-compatible object reader backed by cached byte ranges."""

    def __init__(
        self,
        client: Any,
        bucket: str,
        key: str,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        max_cached_chunks: int = DEFAULT_CACHE_CHUNKS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        expected_etag: str | None = None,
        expected_version_id: str | None = None,
    ) -> None:
        super().__init__()
        self._client = client
        self._bucket = bucket
        self._key = key
        self._chunk_size = _positive_integer(chunk_size, "chunk_size")
        self._max_cached_chunks = _positive_integer(
            max_cached_chunks, "max_cached_chunks"
        )
        if isinstance(max_retries, bool):
            raise ValueError("max_retries must be a non-negative integer")
        try:
            self._max_retries = integer_index(max_retries)
        except TypeError:
            raise ValueError("max_retries must be a non-negative integer") from None
        if self._max_retries < 0:
            raise ValueError("max_retries must be a non-negative integer")
        for value, name in (
            (expected_etag, "expected_etag"),
            (expected_version_id, "expected_version_id"),
        ):
            if value is not None and (not isinstance(value, str) or not value):
                raise ValueError(f"{name} must be a non-empty string or None")
        self._expected_etag = expected_etag
        self._expected_version_id = expected_version_id
        self._position = 0
        self._cache: OrderedDict[int, bytes] = OrderedDict()
        self._lock = RLock()
        self._size, self._etag, self._version_id = self._load_metadata()

    def _load_metadata(self) -> tuple[int, str | None, str | None]:
        request = {"Bucket": self._bucket, "Key": self._key}
        if self._expected_version_id is not None:
            request["VersionId"] = self._expected_version_id
        try:
            response = self._client.head_object(**request)
        except Exception as exc:
            raise VideoSourceError(
                "Could not read remote video metadata "
                f"({type(exc).__name__}); check the object URI and client permissions"
            ) from None
        size = response.get("ContentLength") if isinstance(response, dict) else None
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise VideoSourceError("Remote video metadata has an invalid ContentLength")
        etag = response.get("ETag") if isinstance(response, dict) else None
        version_id = response.get("VersionId") if isinstance(response, dict) else None
        if etag is not None and (not isinstance(etag, str) or not etag):
            raise VideoSourceError("Remote video metadata has an invalid ETag")
        if version_id is not None and (not isinstance(version_id, str) or not version_id):
            raise VideoSourceError("Remote video metadata has an invalid VersionId")
        if self._expected_etag is not None and etag != self._expected_etag:
            raise VideoSourceError("Remote video ETag does not match the video manifest")
        if self._expected_version_id is not None and version_id != self._expected_version_id:
            raise VideoSourceError("Remote video VersionId does not match the video manifest")
        if etag is None and version_id is None:
            raise VideoSourceError(
                "Remote video metadata needs ETag or VersionId for immutable range reads"
            )
        return size, etag, version_id

    @property
    def size(self) -> int:
        return self._size

    @property
    def etag(self) -> str | None:
        return self._etag

    @property
    def version_id(self) -> str | None:
        return self._version_id

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def tell(self) -> int:
        if self.closed:
            raise ValueError("I/O operation on closed video source")
        with self._lock:
            return self._position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if self.closed:
            raise ValueError("I/O operation on closed video source")
        try:
            offset = integer_index(offset)
        except TypeError:
            raise TypeError("seek offset must be an integer") from None
        with self._lock:
            if whence == io.SEEK_SET:
                position = offset
            elif whence == io.SEEK_CUR:
                position = self._position + offset
            elif whence == io.SEEK_END:
                position = self._size + offset
            else:
                raise ValueError(f"Invalid whence value: {whence}")
            if position < 0:
                raise ValueError("Cannot seek to a negative position")
            self._position = position
            return position

    def _get_chunk(self, chunk_index: int) -> bytes:
        cached = self._cache.get(chunk_index)
        if cached is not None:
            self._cache.move_to_end(chunk_index)
            return cached

        start = chunk_index * self._chunk_size
        if start >= self._size:
            return b""
        end = min(start + self._chunk_size, self._size) - 1
        request: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": self._key,
            "Range": f"bytes={start}-{end}",
        }
        if self._version_id is not None:
            request["VersionId"] = self._version_id
        if self._etag is not None:
            request["IfMatch"] = self._etag

        response = None
        payload = None
        last_error: Exception | None = None
        for _attempt in range(self._max_retries + 1):
            try:
                response = self._client.get_object(**request)
                body = response["Body"]
                try:
                    payload = body.read() if hasattr(body, "read") else body
                finally:
                    close = getattr(body, "close", None)
                    if callable(close):
                        close()
                break
            except Exception as exc:
                last_error = exc
        else:
            assert last_error is not None
            raise VideoSourceError(
                "Could not read a remote video byte range "
                f"({type(last_error).__name__}); check object immutability and permissions"
            ) from None

        assert isinstance(response, dict)
        response_etag = response.get("ETag")
        if self._etag is not None and response_etag is not None and response_etag != self._etag:
            raise VideoSourceError("Remote video changed while it was being decoded")
        response_version_id = response.get("VersionId")
        if (
            self._version_id is not None
            and response_version_id is not None
            and response_version_id != self._version_id
        ):
            raise VideoSourceError("Remote video version changed while it was being decoded")
        content_range = response.get("ContentRange")
        expected_content_range = f"bytes {start}-{end}/{self._size}"
        if content_range != expected_content_range:
            raise VideoSourceError(
                f"Remote object returned an invalid ContentRange for bytes {start}-{end}"
            )

        if not isinstance(payload, (bytes, bytearray, memoryview)):
            raise VideoSourceError("Remote object returned a non-binary response body")
        chunk = bytes(payload)
        expected_size = end - start + 1
        if len(chunk) != expected_size:
            raise VideoSourceError(
                f"Remote object returned {len(chunk)} bytes for a {expected_size}-byte range"
            )

        self._cache[chunk_index] = chunk
        self._cache.move_to_end(chunk_index)
        while len(self._cache) > self._max_cached_chunks:
            self._cache.popitem(last=False)
        return chunk

    def read(self, size: int = -1) -> bytes:
        if self.closed:
            raise ValueError("I/O operation on closed video source")
        if size is None:
            size = -1
        try:
            size = integer_index(size)
        except TypeError:
            raise TypeError("read size must be an integer or None") from None

        with self._lock:
            if self._position >= self._size or size == 0:
                return b""
            stop = self._size if size < 0 else min(self._position + size, self._size)
            parts: list[bytes] = []
            while self._position < stop:
                chunk_index = self._position // self._chunk_size
                chunk = self._get_chunk(chunk_index)
                chunk_offset = self._position % self._chunk_size
                take = min(len(chunk) - chunk_offset, stop - self._position)
                if take <= 0:
                    raise VideoSourceError("Remote byte-range reader made no forward progress")
                parts.append(chunk[chunk_offset : chunk_offset + take])
                self._position += take
            return b"".join(parts)

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        data = self.read(len(view))
        view[: len(data)] = data
        return len(data)

    def close(self) -> None:
        with self._lock:
            self._cache.clear()
        super().close()

    def __repr__(self) -> str:
        return (
            f"R2RangeReader(bucket={self._bucket!r}, key={self._key!r}, "
            f"size={self._size})"
        )


class S3CompatibleVideoSource(VideoSource):
    """A remote video object exposed as a seekable byte-range reader."""

    def __init__(
        self,
        *,
        scheme: Literal["s3", "r2"],
        bucket: str,
        key: str,
        client: Any,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        max_cached_chunks: int = DEFAULT_CACHE_CHUNKS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        expected_etag: str | None = None,
        expected_version_id: str | None = None,
    ) -> None:
        super().__init__()
        self.scheme = scheme
        self.bucket = bucket
        self.key = key
        self.client = client
        self.chunk_size = chunk_size
        self.max_cached_chunks = max_cached_chunks
        self.max_retries = max_retries
        self.expected_etag = expected_etag
        self.expected_version_id = expected_version_id

    def open(self) -> R2RangeReader:
        return R2RangeReader(
            self.client,
            self.bucket,
            self.key,
            chunk_size=self.chunk_size,
            max_cached_chunks=self.max_cached_chunks,
            max_retries=self.max_retries,
            expected_etag=self.expected_etag,
            expected_version_id=self.expected_version_id,
        )

    def __repr__(self) -> str:
        return (
            f"S3CompatibleVideoSource(scheme={self.scheme!r}, "
            f"bucket={self.bucket!r}, key={self.key!r})"
        )


def _make_s3_client(
    scheme: Literal["s3", "r2"],
    endpoint_url: str | None,
    region_name: str | None,
) -> Any:
    if scheme == "r2" and not endpoint_url:
        raise VideoSourceError(
            "endpoint_url is required for r2:// URIs when no client is injected"
        )
    try:
        import boto3  # type: ignore[import-not-found]
    except ImportError:
        raise VideoSourceError(
            "Opening a remote video requires optional dependency 'boto3' "
            "or an injected S3-compatible client"
        ) from None

    options: dict[str, str] = {}
    if endpoint_url:
        options["endpoint_url"] = validate_endpoint_url(endpoint_url)
    effective_region = region_name or ("auto" if scheme == "r2" else None)
    if effective_region:
        options["region_name"] = effective_region
    try:
        return boto3.client("s3", **options)
    except Exception as exc:
        raise VideoSourceError(
            f"Could not create an S3-compatible client ({type(exc).__name__})"
        ) from None


def open_video_source(
    uri: str | os.PathLike[str],
    *,
    client: Any | None = None,
    endpoint_url: str | None = None,
    region_name: str | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    max_cached_chunks: int = DEFAULT_CACHE_CHUNKS,
    max_retries: int = DEFAULT_MAX_RETRIES,
    expected_etag: str | None = None,
    expected_version_id: str | None = None,
) -> VideoSource:
    """Build a context-managed video source for a local or remote URI.

    ``client`` may be any boto3-compatible S3 client.  Injecting it is the
    preferred R2 path because credentials remain outside this module.  If it
    is omitted, boto3 is imported lazily and uses its normal credential chain.
    """

    parsed = parse_video_uri(uri)
    if parsed.scheme == "local":
        if (
            client is not None
            or endpoint_url is not None
            or region_name is not None
            or expected_etag is not None
            or expected_version_id is not None
        ):
            raise VideoSourceError("Remote client options cannot be used with a local video")
        assert parsed.path is not None
        return LocalVideoSource(parsed.path)

    assert parsed.bucket is not None and parsed.key is not None
    if endpoint_url is not None:
        validate_endpoint_url(endpoint_url)
    remote_client = (
        client
        if client is not None
        else _make_s3_client(
            parsed.scheme, endpoint_url=endpoint_url, region_name=region_name
        )
    )
    return S3CompatibleVideoSource(
        scheme=parsed.scheme,
        bucket=parsed.bucket,
        key=parsed.key,
        client=remote_client,
        chunk_size=chunk_size,
        max_cached_chunks=max_cached_chunks,
        max_retries=max_retries,
        expected_etag=expected_etag,
        expected_version_id=expected_version_id,
    )


__all__ = [
    "DEFAULT_CACHE_CHUNKS",
    "DEFAULT_CHUNK_SIZE",
    "DEFAULT_MAX_RETRIES",
    "LocalVideoSource",
    "ParsedVideoURI",
    "R2RangeReader",
    "S3CompatibleVideoSource",
    "VideoSource",
    "VideoSourceError",
    "open_video_source",
    "parse_video_uri",
    "validate_endpoint_url",
]
