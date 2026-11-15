// One loader per thing you want to fetch. Import wherever you need it —
// no provider, no prop drilling. To add something new later, add another
// createLoader() call here and nothing else needs to know about it.

import { createLoader } from './createLoader'
import { Http } from '../http'
import { useRobot } from '../context/useRobot'

export const persistentMapsLoader = createLoader((serial: string) =>
    Http.getPersistentMaps(serial).then(res => res.data)
)
export const usePersistentMaps = () => {
    const { robot } = useRobot()
    return { ...persistentMapsLoader.useValue(robot.serial), refresh: () => persistentMapsLoader.request(robot.serial) }
}

export const persistentMapLoader = createLoader((serial: string, mapId: string) =>
    Http.getPersistentMap(serial, mapId).then(res => res.data)
)
export const usePersistentMap = (mapId: string) => {
    const { robot } = useRobot()
    return { ...persistentMapLoader.useValue(robot.serial, mapId), refresh: () => persistentMapLoader.request(robot.serial, mapId) }
}
// export const usePersistentMap = (mapId: string) => {
//     const { robot } = useRobot()

//     const entry = persistentMapLoader.useValue(robot.serial, mapId)

//     useEffect(() => {
//         if (mapId && !entry.data && !entry.loading && !entry.error) {
//             persistentMapLoader.request(robot.serial, mapId)
//         }
//     }, [robot.serial, mapId, entry.data, entry.loading, entry.error])

//     return {
//         ...entry,
//         refresh: () => persistentMapLoader.request(robot.serial, mapId)
//     }
// }

export const cleaningLoader = createLoader((serial: string, runId: string) =>
    Http.getCleaning(serial, runId).then(res => res.data)
)
export const useCleaning = (runId: string) => {
    const { robot } = useRobot()
    return { ...cleaningLoader.useValue(robot.serial, runId), refresh: () => cleaningLoader.request(robot.serial, runId) }
}
// export const useCleaning = (runId: string) => {
//     const { robot } = useRobot()

//     const entry = cleaningLoader.useValue(robot.serial, runId)

//     useEffect(() => {
//         if (runId && !entry.data && !entry.loading && !entry.error) {
//             cleaningLoader.request(robot.serial, runId)
//         }
//     }, [robot.serial, runId, entry.data, entry.loading, entry.error])

//     return {
//         ...entry,
//         refresh: () => cleaningLoader.request(robot.serial, runId)
//     }
// }

export const cleaningsLoader = createLoader((serial: string) =>
    Http.getCleanings(serial).then(res =>
        [...res.data].sort((a, b) => new Date(b.timing.start).getTime() - new Date(a.timing.start).getTime())
    )
)


// Next one might look like this — a single map's boundaries, keyed by serial + mapId:
//
// export const boundariesLoader = createLoader(
//     (serial: string, mapId: string, robotType: RobotType) =>
//         robotType === RobotType.NeatoGen4
//             ? Http.getBoundaries(serial, mapId).then(res => res.data.boundaries)
//             : GEN3_COMMANDS.getMapBoundaries(serial, mapId).then(res => res.data.data.boundaries)
// )

// gen3: the way a run drove (its black box track, coverage and problems); runs never change, so a loaded
// one is kept (the home page loads the neighbours of the shown run ahead, see pages/home/home.tsx)
export const runTrackLoader = createLoader((serial: string, runId: string) =>
    Http.getRunTrack(serial, runId).then(res => res.data)
)

// where the runs of a stored map lie on it, worked out by the server (seeds gen3Run's runOffset)
export const mapOffsetsLoader = createLoader((serial: string, mapId: string) =>
    Http.getMapOffsets(serial, mapId).then(res => res.data)
)

// load a run's files ahead (its map, its cells, its track) so showing it is instant; errors are
// left for the moment it is really shown
export const prefetchRun = (serial: string, runId: string) => {
    if (!persistentMapLoader.peek(serial, runId)) persistentMapLoader.request(serial, runId).catch(() => {})
    if (!cleaningLoader.peek(serial, runId)) cleaningLoader.request(serial, runId).catch(() => {})
    if (!runTrackLoader.peek(serial, runId)) runTrackLoader.request(serial, runId).catch(() => {})
}
