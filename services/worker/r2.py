from __future__ import annotations

import mimetypes
from pathlib import Path


class R2Uploader:
    def __init__(self, endpoint: str | None, access_key: str | None, secret_key: str | None, bucket: str | None):
        self.enabled = bool(endpoint and access_key and secret_key and bucket)
        self.bucket = bucket
        if self.enabled:
            try:
                import boto3
            except ImportError as error:
                raise RuntimeError("boto3 is required when R2 is configured") from error
            self.client = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=access_key, aws_secret_access_key=secret_key)

    def upload_tree(self, root: Path, prefix: str) -> list[str]:
        if not self.enabled:
            raise RuntimeError("R2 is not configured")
        uploaded = []
        for path in root.rglob("*"):
            if not path.is_file() or path.name.endswith(".json.tmp"):
                continue
            key = f"{prefix.strip('/')}/{path.relative_to(root).as_posix()}"
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.client.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": content_type})
            uploaded.append(key)
        return uploaded

