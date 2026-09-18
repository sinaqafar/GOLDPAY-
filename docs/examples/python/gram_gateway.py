"""
Minimal Python client for the GRAM Gateway API.

Mirrors packages/sdk: canonical signing, a fresh nonce per request, idempotency
keys on writes, and constant-time webhook verification.

Standard library only, so it drops into any project.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Mapping


class GramGatewayError(Exception):
    def __init__(self, code: str, message: str, status: int, request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id

    @property
    def retryable(self) -> bool:
        """5xx and 429 may succeed later; a 4xx will not."""
        return self.status >= 500 or self.status == 429


@dataclass
class GramGateway:
    base_url: str
    api_key: str
    timeout: float = 15.0

    def __post_init__(self) -> None:
        if "." not in self.api_key:
            raise ValueError('api_key must be "<prefix>.<secret>"')
        self.base_url = self.base_url.rstrip("/")
        self._secret = self.api_key.split(".", 1)[1]

    # --- resources ---------------------------------------------------------

    def create_invoice(
        self, amount: str, description: str | None = None, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"amount": amount}
        if description is not None:
            body["description"] = description
        # Always send a key: a retry after a timeout must not create a second
        # invoice (SPEC 1779).
        return self._request(
            "POST", "/v1/invoices", body, idempotency_key or f"inv_{uuid.uuid4()}"
        )

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/invoices/{urllib.parse.quote(invoice_id)}")

    def list_payments(self, **query: Any) -> dict[str, Any]:
        target = "/v1/payments"
        params = {k: str(v) for k, v in query.items() if v is not None}
        if params:
            target += "?" + urllib.parse.urlencode(params)
        return self._request("GET", target)

    def get_balances(self) -> dict[str, Any]:
        return self._request("GET", "/v1/balances")

    # --- webhooks ----------------------------------------------------------

    @staticmethod
    def verify_webhook(
        secret: str,
        raw_body: str,
        timestamp: str,
        signature: str,
        tolerance_seconds: int = 300,
        now: float | None = None,
    ) -> bool:
        """
        compare_digest is constant-time: a plain == would leak the signature
        one byte at a time through timing.
        """
        if not timestamp.isdigit():
            return False
        current = now if now is not None else time.time()
        if abs(current - int(timestamp)) > tolerance_seconds:
            return False

        expected = hmac.new(
            secret.encode(), f"{timestamp}.{raw_body}".encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    # --- internals ---------------------------------------------------------

    def _request(
        self,
        method: str,
        target: str,
        body: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        # separators without spaces keeps the bytes we hash identical to the
        # bytes we send.
        raw_body = "" if body is None else json.dumps(body, separators=(",", ":"))
        timestamp = str(int(time.time()))
        nonce = str(uuid.uuid4())

        # The target includes the query string; signing only the path would
        # leave filters unauthenticated.
        canonical = "\n".join(
            [
                method.upper(),
                target,
                timestamp,
                nonce,
                hashlib.sha256(raw_body.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._secret.encode(), canonical.encode(), hashlib.sha256
        ).hexdigest()

        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
            "x-gateway-timestamp": timestamp,
            "x-gateway-nonce": nonce,
            "x-gateway-signature": signature,
        }
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key

        request = urllib.request.Request(
            self.base_url + target,
            data=raw_body.encode() if raw_body else None,
            headers=headers,
            method=method.upper(),
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                envelope = json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            envelope = json.loads(exc.read().decode() or "{}")
            error = envelope.get("error", {})
            raise GramGatewayError(
                error.get("code", "UNKNOWN_ERROR"),
                error.get("message", f"request failed ({exc.code})"),
                exc.code,
                error.get("request_id"),
            ) from exc
        except urllib.error.URLError as exc:
            # Ambiguous: the request may have been processed. Only retry when
            # an idempotency key makes that safe.
            raise GramGatewayError("NETWORK_ERROR", str(exc.reason), 0) from exc

        # Unwrap the standard { data, meta } envelope.
        data = envelope.get("data")
        return data if isinstance(data, dict) else envelope
