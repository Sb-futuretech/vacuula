import styles from './map.module.scss'

// mm between labelled ticks: the smallest step that still leaves room for a label at this zoom
const STEPS_MM = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]
const MIN_TICK_PX = 56
export const RULER_PX = 22

const label = (mm: number, step: number) => step >= 1000 ? `${mm / 1000} m` : `${mm / 10} cm`

interface MapRulersProps {
    zoom: number
    offset: { x: number, y: number }
    mapSize: { width: number, height: number }
    mmPerPixel: number
    width: number  // canvas size in CSS pixels
    height: number
}

// Rulers along the top and left edge of the map, measuring real distance from the map's top-left corner.
export default function MapRulers({ zoom, offset, mapSize, mmPerPixel, width, height }: MapRulersProps) {
    const pxPerMm = zoom / mmPerPixel
    if (!Number.isFinite(pxPerMm) || pxPerMm <= 0 || !width || !height) return null
    const step = STEPS_MM.find(s => s * pxPerMm >= MIN_TICK_PX) ?? STEPS_MM[STEPS_MM.length - 1]
    const half = step / 2

    // ticks every half step inside both the visible strip and the map
    const ticks = (origin: number, length: number, mapMm: number) => {
        const out: { pos: number, mm: number, major: boolean }[] = []
        const to = Math.min(mapMm, (length - origin) / pxPerMm)
        for (let mm = Math.max(0, Math.ceil(-origin / pxPerMm / half) * half); mm <= to; mm += half)
            out.push({ pos: origin + mm * pxPerMm, mm, major: mm % step === 0 })
        return out
    }
    const xTicks = ticks(offset.x, width, mapSize.width * mmPerPixel)
    const yTicks = ticks(offset.y, height, mapSize.height * mmPerPixel)

    return (
        <>
            <svg className={styles.rulerTop} width={width} height={RULER_PX} aria-hidden>
                {xTicks.map(tk => (
                    <g key={tk.mm}>
                        <line x1={tk.pos} x2={tk.pos} y1={tk.major ? 10 : 16} y2={RULER_PX} />
                        {tk.major && tk.pos > RULER_PX && <text x={tk.pos + 3} y={10}>{label(tk.mm, step)}</text>}
                    </g>
                ))}
            </svg>
            <svg className={styles.rulerLeft} width={RULER_PX} height={height} aria-hidden>
                {yTicks.map(tk => (
                    <g key={tk.mm}>
                        <line y1={tk.pos} y2={tk.pos} x1={tk.major ? 10 : 16} x2={RULER_PX} />
                        {tk.major && tk.pos > RULER_PX && <text transform={`translate(10 ${tk.pos - 3}) rotate(-90)`}>{label(tk.mm, step)}</text>}
                    </g>
                ))}
            </svg>
        </>
    )
}
