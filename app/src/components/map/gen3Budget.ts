import type { NoGoLine, Point, Zone } from './types'

// Limits of the D7 (gen3, firmware 4.5.3-189) for the zones and no-go lines of one map, measured
// with build/pi/d7_boundary_test.py (see FORK.md, "What we learned about the D7"):
// - it keeps at most 10 points per zone or line and drops further ones without a word;
// - it answers every save with all boundaries of the map, and if that answer would pass 2044 bytes
//   it sends nothing and closes the connection, again after every save, until the set is smaller.
export const GEN3_MAX_POINTS_PER_BOUNDARY = 10
export const GEN3_REPLY_LIMIT = 2044

// {"version":1,"reqId":"1951","result":"ok","data": {"boundaries": [...]}} around the list,
// with one byte spare for when the request counter reaches 5 digits
const ENVELOPE = 68
// the most one more point can add: [0.1234,0.5678] and its comma
export const GEN3_POINT_BYTES = 16

// the robot keeps each coordinate rounded to 4 decimals (0.40996 -> 0.41)
const round4 = (v: number) => Math.round(v * 1e4) / 1e4
export const roundPoint = ([x, y]: Point): Point => [round4(x), round4(y)]

type Boundary = NoGoLine | Zone

// Bytes of the robot's answer to saving these boundaries: compact JSON of the fields it keeps, a
// space after "vertices": for each one, and the envelope. Every boundary counts as switched off
// ("enabled":false is one byte longer), so switching one off can't push a map over the limit.
export function gen3ReplyBytes(boundaries: Boundary[]): number {
    const echo = boundaries.map(b => ({
        id: b.id, type: b.type, vertices: b.vertices.map(roundPoint), name: b.name, color: b.color, enabled: false,
    }))
    return ENVELOPE + new TextEncoder().encode(JSON.stringify(echo)).length + boundaries.length
}

// what one more feature with this many points and no name costs at least
export function gen3FeatureBytes(type: Boundary['type'], points: number): number {
    const sample: Boundary = {
        id: '00000000-0000-0000-0000-000000000000', name: '', color: '#000000', type, enabled: false,
        vertices: Array.from({ length: points }, () => [0.1234, 0.5678] as Point),
    }
    return gen3ReplyBytes([sample, sample]) - gen3ReplyBytes([sample])
}
