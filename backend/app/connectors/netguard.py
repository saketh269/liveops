"""Outbound network policy for connectors that call user-supplied URLs (SSRF guard).

The policy is applied to the *resolved* IP addresses, at connect time, on
every request (``GuardedTransport``), and the connection is pinned to the IP
that was checked, so DNS rebinding can't swap in an internal address between
the check and the connect.

- Always refused: link-local (169.254.0.0/16, fe80::/10, which includes the
  cloud metadata service 169.254.169.254), known metadata addresses and host
  names, multicast, unspecified (0.0.0.0, ::) and reserved addresses.
- Refused unless the source opts in with ``allow_private_network``: loopback,
  private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), CGNAT 100.64/10 and
  anything else that isn't a public internet address. On-prem APIs need this
  opt-in; the API shows a warning when it is on.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket

import httpx

from app.connectors.base import ConnectorError

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

METADATA_HOSTS = {"metadata.google.internal", "metadata", "metadata.azure.internal", "instance-data"}
METADATA_IPS = {
    ipaddress.ip_address("169.254.169.254"),  # AWS, GCP, Azure, OpenStack
    ipaddress.ip_address("fd00:ec2::254"),  # AWS IPv6 IMDS
    ipaddress.ip_address("100.100.100.200"),  # Alibaba Cloud
    ipaddress.ip_address("169.254.170.2"),  # ECS task credentials
}
DNS_TIMEOUT_S = 5.0


def check_ip(ip: IPAddress, allow_private: bool) -> None:
    """Raise ``ConnectorError`` if the policy refuses ``ip``."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if (
        ip in METADATA_IPS
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or (ip.is_reserved and not ip.is_private)
    ):
        raise ConnectorError(
            "This address is blocked: it is a link-local or cloud metadata address",
            hint="Live Ops never calls link-local or metadata addresses. Use the API's real host name.",
        )
    if not ip.is_global and not allow_private:
        raise ConnectorError(
            "This address is on a private or local network",
            hint="For an API inside your company network, turn on 'Allow private network addresses'. "
            "Only do this for APIs you trust.",
        )


def check_host_name(host: str) -> None:
    if host.lower().rstrip(".") in METADATA_HOSTS:
        raise ConnectorError(
            "This host name is a cloud metadata service and is blocked",
            hint="Use the API's real host name.",
        )


def _literal(host: str) -> IPAddress | None:
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def resolve_sync(host: str, port: int) -> list[IPAddress]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [ipaddress.ip_address(str(i[4][0]).split("%", 1)[0]) for i in infos]


async def resolve(host: str, port: int) -> list[IPAddress]:
    loop = asyncio.get_running_loop()
    try:
        async with asyncio.timeout(DNS_TIMEOUT_S):
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, TimeoutError):
        raise ConnectorError(
            "Couldn't look up the host name", hint="Check the host name and the server's DNS settings."
        ) from None
    return [ipaddress.ip_address(str(i[4][0]).split("%", 1)[0]) for i in infos]


async def checked_ip(host: str, port: int, allow_private: bool) -> IPAddress:
    """Resolve ``host`` and check *every* address; return the one to connect to."""
    check_host_name(host)
    lit = _literal(host)
    ips = [lit] if lit is not None else await resolve(host, port)
    if not ips:
        raise ConnectorError("The host name has no addresses", hint="Check the host name.")
    for ip in ips:
        check_ip(ip, allow_private)
    return ips[0]


def check_host_sync(host: str, port: int, allow_private: bool) -> None:
    """Blocking variant for clients we can't pin (boto3). Call from a worker thread."""
    check_host_name(host)
    lit = _literal(host)
    try:
        ips = [lit] if lit is not None else resolve_sync(host, port)
    except OSError:
        raise ConnectorError(
            "Couldn't look up the host name", hint="Check the host name and the server's DNS settings."
        ) from None
    for ip in ips:
        check_ip(ip, allow_private)


class GuardedTransport(httpx.AsyncBaseTransport):
    """httpx transport that applies the policy per request and pins the checked IP.

    The request URL's host is replaced by the checked IP; the ``Host`` header
    keeps the original name and TLS uses it for SNI and certificate checks.
    """

    def __init__(self, allow_private: bool) -> None:
        self.allow_private = allow_private
        self._inner = httpx.AsyncHTTPTransport(trust_env=False)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        ip = await checked_ip(host, port, self.allow_private)
        if _literal(host) is None:
            request.url = request.url.copy_with(host=str(ip))
            if request.url.scheme == "https":
                request.extensions = {**request.extensions, "sni_hostname": host}
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()
