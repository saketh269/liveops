"""s3_files connector against moto running as a real S3-compatible HTTP server
(random local port) with IAM signature checks turned on."""

from __future__ import annotations

import io
import json
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import boto3
import pytest
from botocore.config import Config
from openpyxl import Workbook

from app.connectors.base import Connector, ConnectorError
from app.connectors.files import S3FilesConnector
from tests.contract.kit import SEED_ROWS, ConnectorContract

moto_server = pytest.importorskip("moto.server")
moto_settings = pytest.importorskip("moto.settings")

READ_ONLY_POLICY = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetObject"], "Resource": "*"}],
}
WRITE_POLICY = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}]}


class S3Env:
    def __init__(self) -> None:
        self.server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
        self.server.start()
        host, port = self.server.get_host_and_port()
        self.url = f"http://{host}:{port}"
        self.bucket = f"liveops-{uuid.uuid4().hex[:8]}"
        iam = self._client("iam", "setup", "setup")
        self.keys: dict[str, dict[str, str]] = {}
        for user, policy in (("reader", READ_ONLY_POLICY), ("writer", WRITE_POLICY)):
            iam.create_user(UserName=user)
            iam.put_user_policy(UserName=user, PolicyName="p", PolicyDocument=json.dumps(policy))
            k = iam.create_access_key(UserName=user)["AccessKey"]
            self.keys[user] = {"access_key_id": k["AccessKeyId"], "secret_access_key": k["SecretAccessKey"]}
        self._client("s3", "setup", "setup").create_bucket(Bucket=self.bucket)
        self._saved = moto_settings.INITIAL_NO_AUTH_ACTION_COUNT
        moto_settings.INITIAL_NO_AUTH_ACTION_COUNT = 0  # from now on every request is signature-checked
        self.writer = self._client("s3", **self.keys["writer"])

    def _client(self, service: str, access_key_id: str, secret_access_key: str) -> Any:
        return boto3.client(
            service,
            endpoint_url=self.url,
            region_name="us-east-1",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=Config(s3={"addressing_style": "path"}),
        )

    def put(self, key: str, data: bytes) -> None:
        self.writer.put_object(Bucket=self.bucket, Key=key, Body=data)

    def settings(self, **over: Any) -> dict[str, Any]:
        return {
            "bucket": self.bucket,
            # moto's signature check mis-handles "/" in query strings (real S3 is fine), so test
            # prefixes have no trailing slash; "exports" still matches "exports/..." keys.
            "prefix": "exports",
            "endpoint_url": self.url,
            "encryption": "off",  # local moto server speaks plain HTTP
            "allow_private_network": True,  # moto listens on 127.0.0.1
            **over,
        }

    def stop(self) -> None:
        moto_settings.INITIAL_NO_AUTH_ACTION_COUNT = self._saved
        self.server.stop()


@pytest.fixture(scope="module")
def s3env() -> Iterator[S3Env]:
    env = S3Env()
    try:
        yield env
    finally:
        env.stop()


def jsonl(rows: list[dict[str, Any]]) -> bytes:
    return b"".join(json.dumps(r).encode() + b"\n" for r in rows)


class S3Driver:
    def __init__(self, env: S3Env) -> None:
        self.env = env
        self.dataset = f"exports/assets-{uuid.uuid4().hex[:6]}.jsonl"
        self.rows = {r["id"]: {**r, "updated_at": "2026-10-06T10:00:00Z", "amount": 1.5} for r in SEED_ROWS}
        self._write()

    def _write(self) -> None:
        self.env.put(self.dataset, jsonl(list(self.rows.values())))

    async def insert(self, row: dict[str, Any]) -> None:
        self.rows[row["id"]] = dict(row)
        self._write()

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        self.rows[key].update(changes)
        self._write()

    async def delete(self, key: str) -> None:
        del self.rows[key]
        self._write()

    async def insert_null_key(self, row: dict[str, Any]) -> None:
        self.rows["~nokey"] = {**row, "id": None}
        self._write()


class TestS3Contract(ConnectorContract):
    latency_budget_s = 3.0

    @pytest.fixture
    async def driver(self, s3env: S3Env) -> AsyncIterator[S3Driver]:
        yield S3Driver(s3env)

    def make_connector(self, driver: S3Driver) -> Connector:  # type: ignore[override]
        return S3FilesConnector(driver.env.settings(), dict(driver.env.keys["reader"]))

    def make_bad_connector(self, driver: S3Driver) -> Connector:  # type: ignore[override]
        k = driver.env.keys["reader"]
        return S3FilesConnector(
            driver.env.settings(), {"access_key_id": k["access_key_id"], "secret_access_key": "wrong-secret-key-1"}
        )


# -- focused tests -----------------------------------------------------------


async def test_csv_and_xlsx_objects_and_prefix_filter(s3env: S3Env) -> None:
    prefix = f"p-{uuid.uuid4().hex[:6]}"
    s3env.put(prefix + "/beds.csv", b"id,status\nB1,free\nB2,in_use\n")
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(["id", "count"])
    ws.append(["T1", 4])
    buf = io.BytesIO()
    wb.save(buf)
    s3env.put(prefix + "/trucks.xlsx", buf.getvalue())
    s3env.put(prefix + "/readme.txt", b"ignored")
    s3env.put("elsewhere/other.csv", b"id\nX\n")
    c = S3FilesConnector(s3env.settings(prefix=prefix), dict(s3env.keys["reader"]))
    try:
        names = sorted(d.name for d in await c.discover())
        assert names == [prefix + "/beds.csv", prefix + "/trucks.xlsx"]
        assert await c.snapshot(prefix + "/trucks.xlsx") == [{"id": "T1", "count": 4}]
        with pytest.raises(ConnectorError):
            await c.snapshot("elsewhere/other.csv")
    finally:
        await c.close()


async def test_rereads_only_on_etag_change(s3env: S3Env) -> None:
    d = S3Driver(s3env)
    c = S3FilesConnector(s3env.settings(), dict(s3env.keys["reader"]))
    try:
        first = await c.snapshot(d.dataset)
        assert await c.snapshot(d.dataset) is first
        await d.update("A1", {"status": "occupied"})
        assert {r["id"]: r["status"] for r in await c.snapshot(d.dataset)}["A1"] == "occupied"
    finally:
        await c.close()


async def test_http_endpoint_needs_encryption_off(s3env: S3Env) -> None:
    c = S3FilesConnector(s3env.settings(encryption="required"), dict(s3env.keys["reader"]))
    report = await c.test()
    await c.close()
    assert not report.ok
    assert "Encryption to Off" in report.steps[0].hint


async def test_bad_secret_hint_and_no_leak(s3env: S3Env) -> None:
    k = s3env.keys["reader"]
    c = S3FilesConnector(s3env.settings(), {"access_key_id": k["access_key_id"], "secret_access_key": "zzz-wrong"})
    report = await c.test()
    await c.close()
    assert not report.ok
    assert "access key" in report.steps[-1].hint
    assert "zzz-wrong" not in report.model_dump_json()


async def test_missing_bucket_hint(s3env: S3Env) -> None:
    c = S3FilesConnector(s3env.settings(bucket="no-such-bucket-lo"), dict(s3env.keys["reader"]))
    report = await c.test()
    await c.close()
    assert not report.ok and "bucket" in report.steps[-1].hint.lower()


# -- LIVEOPS-16: never use the server's ambient AWS credentials -------------------


@pytest.fixture
def ambient_aws(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIASERVERROLEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "server-secret-should-never-be-used")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "server-session-token")


@pytest.mark.parametrize("secrets", [{}, {"access_key_id": ""}, {"access_key_id": "AKIAX", "secret_access_key": ""}])
async def test_blank_keys_never_fall_back_to_ambient(s3env: S3Env, ambient_aws: None, secrets: dict[str, str]) -> None:
    c = S3FilesConnector(s3env.settings(), secrets)
    report = await c.test()
    assert not report.ok
    assert "Enter an access key" in report.steps[0].detail
    assert c._client is None, "no S3 client may be built without the source's own keys"
    assert "AKIASERVERROLEXAMPLE" not in report.model_dump_json()
    with pytest.raises(ConnectorError, match="access key"):
        await c.discover()
    await c.close()


async def test_explicit_keys_ignore_ambient_session_token(s3env: S3Env, ambient_aws: None) -> None:
    c = S3FilesConnector(s3env.settings(), dict(s3env.keys["reader"]))
    try:
        creds = (await c._run(c._s3))._request_signer._credentials
        assert creds.access_key == s3env.keys["reader"]["access_key_id"]
        assert creds.token is None
        assert (await c.test()).ok
    finally:
        await c.close()


async def test_instance_role_needs_admin_flag(s3env: S3Env, ambient_aws: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    c = S3FilesConnector(s3env.settings(use_instance_role=True), {})
    report = await c.test()
    assert not report.ok and "LIVEOPS_S3_ALLOW_INSTANCE_ROLE" in report.steps[0].hint
    monkeypatch.setenv("LIVEOPS_S3_ALLOW_INSTANCE_ROLE", "true")
    get_settings.cache_clear()
    try:
        assert c._credentials() == {}  # admin allowed it and the source opted in: default chain
    finally:
        monkeypatch.delenv("LIVEOPS_S3_ALLOW_INSTANCE_ROLE")
        get_settings.cache_clear()


# -- LIVEOPS-21: endpoint network policy -----------------------------------------


async def test_private_endpoint_needs_opt_in(s3env: S3Env) -> None:
    c = S3FilesConnector(s3env.settings(allow_private_network=False), dict(s3env.keys["reader"]))
    report = await c.test()
    await c.close()
    assert not report.ok and "Allow private network" in report.steps[-1].hint


async def test_metadata_endpoint_always_refused(s3env: S3Env) -> None:
    c = S3FilesConnector(
        s3env.settings(endpoint_url="http://169.254.169.254", allow_private_network=True), dict(s3env.keys["reader"])
    )
    with pytest.raises(ConnectorError, match="blocked"):
        await c.discover()
    await c.close()


# -- LIVEOPS-19 via S3: bombs are refused the same way -----------------------------


async def test_xlsx_bomb_object_refused(s3env: S3Env) -> None:
    from tests.contract.test_files_contract import _bomb

    prefix = f"bomb-{uuid.uuid4().hex[:6]}"
    s3env.put(prefix + "/b.xlsx", _bomb(20 * 1024 * 1024))
    c = S3FilesConnector(s3env.settings(prefix=prefix), dict(s3env.keys["reader"]))
    try:
        with pytest.raises(ConnectorError, match="too much data"):
            await c.snapshot(prefix + "/b.xlsx")
    finally:
        await c.close()
