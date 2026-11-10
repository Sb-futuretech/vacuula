"""Reading a gen3 robot's black box log (/emmc/black_box/BBLog_<n>.nz.enc.bin, D7 firmware 4.5.3-189).

The robot writes it itself while e.MMC logging is on (CLI `LoggingEnable Enable`). The file is a chain
of blocks:

    "ZYZY" | block no u32 | length u32 | nonce u32 | time u32 | flags (compressed, encrypted, 0, 0)

followed by `length` bytes: zlib-compressed, then RC4-encrypted with the key nonce + 11 bytes that are
fixed in the robot's firmware (VACUULA_BB_KEY, not shipped here). Decrypted and inflated, a block holds
packets:

    01 02 | length u16 | 02 | type u8 | sequence u16 | clock u32 (24 MHz) | payload

Packet type 1 ("Coords", every 100 ms while the robot moves) is the robot's position: x, y as int32 in
a fixed unit (about 525,000 per map cell on a D7), the heading as a 32-bit binary angle, and a status.
"""
from __future__ import annotations

import math
import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass

MAGIC = b"ZYZY"
BLOCK_HEADER = 24
PACKET_HEADER = 12
PKT_COORDS = 1
PKT_TEXT = 8


def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 0xFF
        s[i], s[j] = s[j], s[i]
    out = bytearray(len(data))
    i = j = 0
    for k, c in enumerate(data):
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out[k] = c ^ s[(s[i] + s[j]) & 0xFF]
    return bytes(out)


def split_blocks(buf: bytes) -> tuple[list[bytes], int]:
    """The whole blocks at the start of `buf` (header included) and how many bytes they take; bytes
    before the first "ZYZY" (a read that started mid-block) are skipped."""
    blocks: list[bytes] = []
    pos = buf.find(MAGIC)
    if pos < 0:
        return blocks, max(0, len(buf) - 3)  # keep a possible partial magic
    while pos + BLOCK_HEADER <= len(buf):
        if buf[pos:pos + 4] != MAGIC:
            nxt = buf.find(MAGIC, pos + 1)
            if nxt < 0:
                return blocks, max(pos, len(buf) - 3)
            pos = nxt
            continue
        length = struct.unpack_from("<I", buf, pos + 8)[0]
        end = pos + BLOCK_HEADER + length
        if end > len(buf):
            break
        blocks.append(buf[pos:end])
        pos = end
    return blocks, pos


def block_payload(block: bytes, key: bytes) -> bytes:
    """The packets of one block: decrypted and inflated as its flags say."""
    nonce = block[12:16]
    compressed, encrypted = block[20], block[21]
    data = block[BLOCK_HEADER:]
    if encrypted:
        data = rc4(nonce + key, data)
    if compressed:
        data = zlib.decompress(data)
    return data


class PacketStream:
    """Packets from the payloads of consecutive blocks: a packet may continue in the next block, so
    the unfinished end of one payload is kept for the next. Zero bytes between packets are padding;
    anything else that is not a packet header (a stream joined mid-packet) is skipped to the next."""

    def __init__(self) -> None:
        self._rest = b""

    def feed(self, payload: bytes) -> Iterator[tuple[int, int, bytes]]:
        """(type, clock, data) of every packet completed by `payload`."""
        buf = self._rest + payload
        pos, n = 0, len(buf)
        while pos + PACKET_HEADER <= n:
            if buf[pos] == 0:
                pos += 1
                continue
            if buf[pos] != 1 or buf[pos + 1] != 2 or buf[pos + 4] != 2:
                nxt = buf.find(b"\x01\x02", pos + 1)
                pos = nxt if nxt >= 0 else n
                continue
            length = struct.unpack_from("<H", buf, pos + 2)[0]
            start = pos + PACKET_HEADER
            if start + length > n:
                break
            yield buf[pos + 5], struct.unpack_from("<I", buf, pos + 8)[0], buf[start:start + length]
            pos = start + length
        self._rest = buf[pos:][-65536:]


@dataclass(frozen=True)
class Coords:
    x: int
    y: int
    heading: float  # radians, counter-clockwise

    @classmethod
    def parse(cls, data: bytes) -> Coords:
        x, y, angle, _status = struct.unpack_from("<iiii", data)
        return cls(x, y, (angle & 0xFFFFFFFF) / 2 ** 32 * 2 * math.pi)
