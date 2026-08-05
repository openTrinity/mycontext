# Copyright 2026 The HuggingFace Team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Keyless CI/CD authentication via OIDC token exchange ("Trusted Publishers").

A CI job proves its identity to the Hub with a short-lived OIDC id token minted by its CI
provider (e.g. GitHub Actions), then exchanges it at ``POST {ENDPOINT}/oauth/token`` (RFC 8693)
for a short-lived Hugging Face token — no long-lived ``HF_TOKEN`` secret to store.

This module is self-contained: it only handles minting the provider id token and the exchange.
It deliberately does not register a public API or a CLI verb; the integration point is the token
resolution in ``utils/_auth.py`` (see ``_get_token_from_oidc``).

Docs: https://huggingface.co/docs/hub/trusted-publishers
"""

import os
from enum import Enum

from . import constants
from .errors import OIDCError
from .utils import get_session, hf_raise_for_status


# RFC 8693 token-exchange grant + id-token subject type (see trusted-publishers docs).
_TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
_ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token"


class Provider(str, Enum):
    """CI providers that can mint an OIDC id token natively. GitHub Actions only for now."""

    GITHUB = "github"


def detect_provider() -> Provider | None:
    """Detect the CI provider able to mint an OIDC id token, or `None` if not in a supported CI."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return Provider.GITHUB
    return None


def _get_github_oidc_token(audience: str) -> str:
    """Mint an OIDC id token from the GitHub Actions runtime.

    Relies on the `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` env vars,
    which GitHub only injects when the job declares `permissions: id-token: write`.
    """
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise OIDCError(
            "Cannot request an OIDC id token from GitHub Actions. Make sure the workflow job sets "
            "`permissions: id-token: write`. See "
            "https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect"
        )
    response = get_session().get(
        request_url,
        params={"audience": audience},
        headers={"Authorization": f"Bearer {request_token}"},
    )
    hf_raise_for_status(response)
    return response.json()["value"]


def get_oidc_token(*, provider: Provider | str | None = None, audience: str | None = None) -> str:
    """Mint a raw OIDC id token (JWT) from the current CI provider.

    Args:
        provider (`str`, *optional*):
            CI provider to use. Auto-detected from the environment when omitted.
        audience (`str`, *optional*):
            The `aud` claim to request. Defaults to `constants.ENDPOINT` so it matches the endpoint
            that validates it (respects `HF_ENDPOINT`/staging).

    Returns:
        `str`: The raw id token (JWT) to pass to [`exchange_oidc_token`].
    """
    audience = audience or constants.ENDPOINT
    provider = provider or detect_provider()
    supported = ", ".join(p.value for p in Provider)
    if provider is None:
        raise OIDCError(f"No supported CI OIDC provider detected. Trusted Publishers currently supports: {supported}.")
    if provider == Provider.GITHUB:
        return _get_github_oidc_token(audience)
    raise NotImplementedError(f"OIDC provider '{provider}' is not supported yet. Supported: {supported}.")


def exchange_oidc_token(*, subject_token: str, resource: str, endpoint: str | None = None) -> dict:
    """Exchange a CI OIDC id token for a short-lived Hugging Face token (RFC 8693).

    Args:
        subject_token (`str`):
            The raw OIDC id token (JWT) from the CI provider. Its `aud` claim must be the Hub URL.
        resource (`str`):
            What to scope the token to: a Hub repo (`namespace/name`, `datasets/namespace/name`,
            `spaces/namespace/name`, `kernels/namespace/name`) for a write token, or a bare Hub
            username for a read-only `gated-repos` token.
        endpoint (`str`, *optional*):
            Hub endpoint. Defaults to `constants.ENDPOINT` (respects `HF_ENDPOINT`/staging).

    Returns:
        `dict`: The token-exchange response, e.g.
        `{"access_token": "hf_jwt_…", "token_type": "bearer", "expires_in": 3600, ...}`.
    """
    response = get_session().post(
        f"{endpoint or constants.ENDPOINT}/oauth/token",
        json={
            "grant_type": _TOKEN_EXCHANGE_GRANT_TYPE,
            "subject_token_type": _ID_TOKEN_TYPE,
            "subject_token": subject_token,
            "resource": resource,
        },
    )
    hf_raise_for_status(response)
    return response.json()


def oidc_login(
    *,
    resource: str,
    subject_token: str | None = None,
    provider: Provider | str | None = None,
    audience: str | None = None,
    endpoint: str | None = None,
) -> dict:
    """Mint a CI OIDC id token and exchange it for a Hugging Face token.

    Convenience wrapper around [`get_oidc_token`] + [`exchange_oidc_token`]. Returns the raw
    exchange response (it does not persist anything — the caller decides what to do with the token).

    Args:
        resource (`str`):
            Repo or username to scope the token to. See [`exchange_oidc_token`].
        subject_token (`str`, *optional*):
            A pre-minted OIDC id token to exchange directly. Use this for CI providers not yet
            supported natively (e.g. GitLab): mint the id token in your job and pass it here. When
            omitted, the token is minted from the detected `provider`.
        provider (`str`, *optional*):
            CI provider. Auto-detected when omitted. Ignored when `subject_token` is provided.
        audience (`str`, *optional*):
            The `aud` claim to request. Defaults to the resolved `endpoint`, so it matches the
            endpoint that validates it.
        endpoint (`str`, *optional*):
            Hub endpoint. Defaults to `constants.ENDPOINT`.

    Returns:
        `dict`: The token-exchange response (`access_token`, `token_type`, `expires_in`, ...).
    """
    endpoint = endpoint or constants.ENDPOINT
    if subject_token is None:
        subject_token = get_oidc_token(provider=provider, audience=audience or endpoint)
    return exchange_oidc_token(subject_token=subject_token, resource=resource, endpoint=endpoint)
