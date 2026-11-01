"""Reading the robot's command connection: an HTTP chunked body of messages.

Each chunk is `<size in hex>\\r\\n<size bytes>\\r\\n`. Heartbeats are short non-JSON chunks; a JSON
message usually fits one chunk but a big one (e.g. the reply after setMapBoundaries) can be split
over several. Reading the stream line by line, as before, mixed up sizes and payloads as soon as
that happened and the connection was dropped on every reconnect.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import BinaryIO

# a JSON message never grows beyond this; a buffer that does is dropped instead of growing forever
MAX_MESSAGE = 1_000_000


def iter_chunks(rfile: BinaryIO, ended: list[str] | None = None) -> Iterator[bytes]:
    """The payload of each chunk until the stream ends (connection closed or the last, empty chunk).
    How it ended is appended to `ended`, so a closed connection and a finished stream can be told apart."""
    def stop(why: str) -> None:
        if ended is not None:
            ended.append(why)

    while True:
        size_line = rfile.readline()
        if not size_line:
            return stop("closed by the robot")
        size_field = size_line.split(b';', 1)[0].strip()  # chunk extensions follow a ';'
        if not size_field:
            continue  # a stray blank line between chunks
        size = int(size_field, 16)
        if size == 0:
            return stop("the robot ended its stream (last chunk)")
        payload = rfile.read(size)
        if len(payload) < size:
            return stop(f"closed by the robot in the middle of a chunk ({len(payload)} of {size} bytes)")
        rfile.read(2)  # the \r\n closing the chunk
        yield payload


class MessageAssembler:
    """Turns chunk payloads into whole messages: JSON objects, joined when split over chunks, and
    anything else (heartbeats) passed through as it is."""

    def __init__(self) -> None:
        self._decoder = json.JSONDecoder()
        self._pending = ""

    def feed(self, payload: bytes) -> list[bytes]:
        if not self._pending and not payload.lstrip().startswith(b'{'):
            return [payload]
        try:
            self._pending += payload.decode()
        except UnicodeDecodeError:
            # a multi-byte character cut in half by the chunk border: very unlikely with the
            # robot's ASCII JSON, so give up on this message rather than guess
            self._pending = ""
            return []

        messages: list[bytes] = []
        text = self._pending
        pos = 0
        while True:
            while pos < len(text) and text[pos].isspace():
                pos += 1
            if pos >= len(text):
                break
            if text[pos] != '{':
                messages.append(text[pos:].encode())  # not JSON: pass it on as a whole
                pos = len(text)
                break
            try:
                _, end = self._decoder.raw_decode(text, pos)
            except ValueError:
                break  # incomplete: wait for the next chunk
            messages.append(text[pos:end].encode())
            pos = end
        self._pending = text[pos:]
        if len(self._pending) > MAX_MESSAGE:
            self._pending = ""
        return messages
