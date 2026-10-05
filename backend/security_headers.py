"""Security response headers for the API.

The API set none at all. It is not a browser-rendered surface, so the headers
that matter here are a different subset from the front end's: nothing frames an
API response or loads fonts into it, but a response that can be MIME-sniffed,
or that leaks a full URL in a Referer, or that a browser is willing to render
inline, is still a real surface.

The CSP here is deliberately the most restrictive one possible — `default-src
'none'` — because an API response should never load anything. If a JSON payload
is ever rendered as a document (a content-type confusion, an error page that
escapes), that policy means it can do nothing when it gets there.

Deliberately NOT set here:
  - Strict-Transport-Security. TLS terminates at the proxy in front of this
    app; emitting HSTS from behind it would be asserting something this
    process cannot actually guarantee. It belongs on the edge.
  - Permissions-Policy. It governs browser features in a document context,
    which an API response does not have.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

# Applied to every response. Values are static, so this is a dict copy per
# request and nothing more.
SECURITY_HEADERS = {
    # Stop a browser second-guessing the declared content type. The DAPI
    # endpoints return CSV and JSON to clients that are not always browsers.
    "X-Content-Type-Options": "nosniff",
    # An API response has no business being framed.
    "X-Frame-Options": "DENY",
    # An API response should load nothing, ever.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; "
                               "base-uri 'none'; form-action 'none'",
    # Paths here carry tickers and sometimes token query strings; do not spill
    # them into a third party's logs via Referer.
    "Referrer-Policy": "no-referrer",
    # Belt and braces against a browser rendering a response inline rather
    # than treating it as data.
    "X-Download-Options": "noopen",
    "Cross-Origin-Resource-Policy": "same-site",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            # setdefault semantics: a route that deliberately set its own
            # value (a download disposition, say) keeps it.
            if key not in response.headers:
                response.headers[key] = value
        return response


def install(app: ASGIApp) -> None:
    app.add_middleware(SecurityHeadersMiddleware)
