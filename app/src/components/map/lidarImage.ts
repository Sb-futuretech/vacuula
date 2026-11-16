// Turns a grey PNG from the server's lidar (gen3/lidar.py, gen3/lidar_map.py) into a canvas in the
// app's colours: each grey value is painted in its colour, everything else stays transparent. The grey
// values lie far apart, so a browser's colour handling of the PNG can't turn one into another; a pixel
// takes the colour of the nearest value given.
export function lidarImage(png: string, colors: [number, string][]): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            const px = ctx.getImageData(0, 0, c.width, c.height)
            const painted = colors.map(([v, col]) => [v, rgba(col)] as const)
            for (let i = 0; i < px.data.length; i += 4) {
                const v = px.data[i]
                let best: readonly [number, number, number, number] | null = null, bestD = 40
                for (const [gv, col] of painted) if (Math.abs(gv - v) < bestD) { bestD = Math.abs(gv - v); best = col }
                if (best) { px.data[i] = best[0]; px.data[i + 1] = best[1]; px.data[i + 2] = best[2]; px.data[i + 3] = best[3] }
                else px.data[i + 3] = 0
            }
            ctx.putImageData(px, 0, 0)
            resolve(c)
        }
        img.onerror = reject
        img.src = `data:image/png;base64,${png}`
    })
}

// a CSS colour as [r, g, b, a 0-255]
function rgba(color: string): [number, number, number, number] {
    const c = document.createElement('canvas').getContext('2d')!
    c.fillStyle = color
    c.fillRect(0, 0, 1, 1)
    const d = c.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
}
