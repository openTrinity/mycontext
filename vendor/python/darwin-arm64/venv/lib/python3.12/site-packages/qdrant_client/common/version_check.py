import logging
from typing import Any
from collections import namedtuple

import httpx

from qdrant_client.auth import BearerAuth

Version = namedtuple("Version", ["major", "minor", "rest"])


def get_server_version(
    rest_uri: str, rest_headers: dict[str, Any], auth_provider: BearerAuth | None, timeout: int
) -> str | None:
    response = httpx.get(rest_uri, headers=rest_headers, auth=auth_provider, timeout=timeout)

    if response.status_code == 200:
        version_info = response.json().get("version", None)
        if not version_info:
            logging.debug(
                f"Unable to parse response from server: {response}, server version defaults to None"
            )
        return version_info
    else:
        logging.debug(
            f"Unexpected response from server: {response}, server version defaults to None"
        )
    return None


def parse_version(version: str) -> Version:
    if not version:
        raise ValueError("Version is None")
    try:
        major, minor, *rest = version.split(".")
        return Version(int(major), int(minor), rest)
    except ValueError as er:
        raise ValueError(
            f"Unable to parse version, expected format: x.y.z, found: {version}"
        ) from er


def is_compatible(client_version: str | None, server_version: str | None) -> bool:
    if not client_version:
        logging.debug(f"Unable to compare with client version {client_version}")
        return False

    if not server_version:
        logging.debug(f"Unable to compare with server version {server_version}")
        return False

    if client_version == server_version:
        return True

    try:
        parsed_server_version = parse_version(server_version)
        parsed_client_version = parse_version(client_version)
    except ValueError as er:
        logging.debug(f"Unable to compare versions: {er}")
        return False

    major_dif = abs(parsed_server_version.major - parsed_client_version.major)
    if major_dif >= 1:
        return False
    return abs(parsed_server_version.minor - parsed_client_version.minor) <= 1
