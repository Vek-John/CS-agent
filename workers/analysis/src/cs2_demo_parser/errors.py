"""Recoverable errors raised by the Demo parser boundary."""

from __future__ import annotations


class DemoAdapterError(RuntimeError):
    """Base error with a stable machine-readable code."""

    code = "DEMO_ADAPTER_ERROR"

    def __init__(self, message: str, *, path: str | None = None) -> None:
        self.path = path
        super().__init__(message)


class DemoFileError(DemoAdapterError):
    """The input path is missing, not a regular file, or not readable."""

    code = "DEMO_FILE_ERROR"


class DemoParserUnavailableError(DemoAdapterError):
    """demoparser2 is not installed or cannot be imported."""

    code = "PARSER_UNAVAILABLE"


class DemoParseError(DemoAdapterError):
    """The parser could not open or query an otherwise valid-looking Demo."""

    code = "DEMO_PARSE_ERROR"


class DemoRequestError(DemoAdapterError):
    """The caller supplied an invalid or unsupported adapter request."""

    code = "INVALID_REQUEST"
