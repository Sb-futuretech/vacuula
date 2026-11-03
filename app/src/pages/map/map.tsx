import { useRef, useEffect, useState, useCallback } from 'react'
import styles from './map.module.scss'
import Drawer from '../../components/drawer/drawer'

import Input from '../../components/input/input'
import { FaChevronDown } from 'react-icons/fa'
import Button from '../../components/button/button'
import { GEN3_COMMANDS } from '../../http/gen3'
import { Http } from '../../http'
import { Neato, RobotType, type Robot } from '../../types'

import MapCanvas, { type MapMode } from './MapCanvas'
import { GEN4_COMMANDS } from '../../http/gen4'
import { useRobot } from '../../context/useRobot'
import { usePersistentMaps } from '../../loaders/resources'
import type { Floorplan } from '../../types/neato/gen4'
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { useGetPromotedFloorplan } from '../../utils/floormaps'
import type { NoGoLine, Point, UseState, Zone } from '../../components/map/types'
import { drawZones, drawNoGoLines, drawBase, drawCrosshair, drawInProgressPolyline, drawHeatmap, HEATMAP_ALPHAS, onDockImageReady } from '../../components/map/drawingFunctions'
import { useCoverageHeatmap } from '../../components/map/heatmap'
import { calcRelevancy, upsertPreserveOrder } from '../../components/map/utils'
import { GEN3_MAX_POINTS_PER_BOUNDARY, GEN3_POINT_BYTES, GEN3_REPLY_LIMIT, gen3FeatureBytes, gen3ReplyBytes, roundPoint } from '../../components/map/gen3Budget'
import { normalizeHex, pickUnusedPreset, withAlpha } from '../../components/map/color'
import ColorPicker from '../../components/colorPicker/ColorPicker'
import { isDocked } from '../../components/topbar/robotInfo'
import { BasicState, resolveRobotState } from '../../utils/state'
import { fetchGen3MapBoundaries } from '../../loaders/gen3Boundaries'
import { getGen3CleaningMode, getGen3NavigationMode, getGen4CleaningMode, getGen4NavigationMode } from '../../utils/modes'


export default () => {
    const { t } = useTranslation()
    const [boundaries, setBoundaries] = useState<(NoGoLine | Zone)[]>([])
    const [drawerOpen, setDrawerOpen] = useState(true)

    const [editForm, setEditForm] = useState({
        name: '',
        color: '',
        zoneType: BoundaryTypes.NOGO_LINE
    });

    const [mapEditform, setMapEditForm] = useState({
        name: '',
        enabled: true
    })

    const [currentLinePoints, setCurrentLinePoints] = useState<Point[]>([])
    // point picked with the mouse for arrow keys / delete; null = the last point
    const [selectedPoint, setSelectedPoint] = useState<number | null>(null)
    const [closedAsPolygon, setClosedAsPolygon] = useState(false)
    // feature type picked up front for a NEW feature (the Add-feature chooser): presets the zone
    // type and, via allowClose below, decides whether drawing can be closed into a polygon
    const [featureChooserOpen, setFeatureChooserOpen] = useState(false)
    const [pendingKind, setPendingKind] = useState<BoundaryTypes>(BoundaryTypes.NOGO_LINE)
    // spot picked with "add feature here": once a type is chosen the map is centred on it (crosshair)
    const [pendingCenter, setPendingCenter] = useState<Point | null>(null)
    const [centerOn, setCenterOn] = useState<Point | null>(null)
    const [persistentMap, setPersistentMap] = useState<string>()

    const [mode, setMode] = useState<MapMode>('boundaries')
    useEffect(() => setSelectedPoint(null), [mode])
    const [returnFromEditMode, SetReturnFromEditMode] = useState<'boundaries' | 'boundary-info'>('boundaries')
    const [activeBoundaryId, setActiveBoundaryId] = useState<string | undefined>(undefined);

    const { robot } = useRobot()
    const skipNextPostRef = useRef(false)

    const { data: persistentMaps, refresh: updatePersistentMaps } = usePersistentMaps()
    const getPromotedFloorplan = useGetPromotedFloorplan()

    // the map shown: picked with the chip on top; the tab opens on the last one picked, else an active one
    const [switcherOpen, setSwitcherOpen] = useState(false)
    const currentMap = persistentMaps?.find(m => m.id === persistentMap)
    const isActive = (m: NonNullable<typeof persistentMaps>[number]) => 'enabled' in m ? m.enabled : !!m.promoted
    const lastMapKey = `map.last.${robot.serial}`
    const chooseMap = (id: string) => {
        setPersistentMap(id)
        setSwitcherOpen(false)
        try { localStorage.setItem(lastMapKey, id) } catch { /* private mode: just not remembered */ }
    }
    useEffect(() => {
        if (!persistentMaps?.length || currentMap) return
        let last: string | null = null
        try { last = localStorage.getItem(lastMapKey) } catch { /* private mode */ }
        setPersistentMap((persistentMaps.find(m => m.id === last) ?? persistentMaps.find(isActive) ?? persistentMaps[0]).id)
    }, [persistentMaps])

    // exploring a new map: confirm first (the robot vacuums the whole home on the way); when it is done,
    // the new map is fetched, shown, and asks for a name
    const [exploreConfirmOpen, setExploreConfirmOpen] = useState(false)
    const exploring = [BasicState.EXPLORING_MAP, BasicState.ACQUIRING_PERSISTENT_MAP_IDS, BasicState.CREATING_UPLOADING_MAP,
        BasicState.SUSPENDED_EXPLORATION].includes(resolveRobotState(robot))
    const mapsBeforeExplore = useRef<string[] | null>(null)
    const [newMapId, setNewMapId] = useState<string>()
    const [newMapName, setNewMapName] = useState('')
    useEffect(() => {
        if (exploring) {
            if (persistentMaps && !mapsBeforeExplore.current) mapsBeforeExplore.current = persistentMaps.map(m => m.id)
        } else if (mapsBeforeExplore.current) {
            // the upload can take a moment after the robot is done
            const timers = [0, 10_000, 30_000].map(ms => setTimeout(updatePersistentMaps, ms))
            return () => timers.forEach(clearTimeout)
        }
    }, [exploring, persistentMaps])
    useEffect(() => {
        const before = mapsBeforeExplore.current
        const fresh = !exploring && before && persistentMaps?.find(m => !before.includes(m.id))
        if (!fresh) return
        mapsBeforeExplore.current = null
        chooseMap(fresh.id)
        setNewMapId(fresh.id)
        setNewMapName('')
    }, [persistentMaps, exploring])
    const startExplore = () => {
        setExploreConfirmOpen(false)
        setSwitcherOpen(false)
        if (robot.type === RobotType.NeatoGen4) GEN4_COMMANDS.startCleaning(robot.serial, getGen4CleaningMode(), getGen4NavigationMode())
        else GEN3_COMMANDS.startPersistentMapExploration(robot.serial)
    }

    // TODO: the dock marker should be moved to the usemap thing 
    const [dockReady, setDockReady] = useState(false)
    useEffect(() => {
        onDockImageReady(() => setDockReady(true))
        updatePersistentMaps(); // get maps when this page is opened
    }, [])


    const [showHeatmap, setShowHeatmap] = useState(false)
    const [heatmapRuns, setHeatmapRuns] = useState(10)
    const { heatmap, loading: heatmapLoading } = useCoverageHeatmap(
        robot.serial, persistentMap, showHeatmap && robot.type === RobotType.NeatoGen3, heatmapRuns)

    const extraDraw = useCallback((ctx, canvas, currentZoom, currentOffset, mapSize) => {
        // coverage of the recent runs under the zones (gen3, switched on in the panel)
        if (heatmap && heatmap.width === mapSize.width) drawHeatmap(ctx, heatmap, currentZoom, currentOffset)

        const showBoundaries = mode === 'boundary-edit'
            ? boundaries.filter(b => b.id !== activeBoundaryId)
            : boundaries

        // with the heatmap on, zones are outlines so the coverage below stays readable
        drawZones(ctx, showBoundaries.filter(b => b.type === 'polygon'), currentZoom, currentOffset, mapSize, !!heatmap)
        drawNoGoLines(ctx, showBoundaries.filter(b => b.type === 'polyline'), currentZoom, currentOffset, mapSize)

        // the selected zone or line: a light halo under a thicker stroke in its own colour
        const selected = mode === 'boundary-info' ? boundaries.find(b => b.id === activeBoundaryId) : undefined
        if (selected && selected.vertices.length > 1) {
            ctx.save()
            ctx.beginPath()
            selected.vertices.forEach(([px, py], i) => {
                const x = currentOffset.x + px * mapSize.width * currentZoom
                const y = currentOffset.y + py * mapSize.height * currentZoom
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            })
            if (selected.type === 'polygon') ctx.closePath()
            ctx.lineJoin = 'round'
            ctx.lineCap = 'round'
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'
            ctx.lineWidth = 9
            ctx.stroke()
            ctx.strokeStyle = normalizeHex(selected.color) ?? '#ffffff'
            ctx.lineWidth = 4
            ctx.stroke()
            ctx.restore()
        }

        // TODO: rework this base drawing, very hacky for quick release...
        const map = persistentMaps?.find(p => p.id === persistentMap)
        const baseData = map?.base
        const NO_BASE = 2147483647
        // Gen4: base = [x_mm, y_mm, dir_deg] in the map frame. Gen3 stores an
        // object without heading; it is drawn unrotated when present.
        if (map && 'origin' in map && Array.isArray(baseData) && baseData[0] !== NO_BASE && baseData[1] !== NO_BASE) {
            const [originX, originY] = map.origin
            const resolution = map.resolution
            const [imgW, imgH] = map.imgsize
            const normX = ((baseData[0] - originX) / resolution) / imgW
            const normY = ((baseData[1] - originY) / resolution) / imgH
            drawBase(ctx, { x: normX, y: normY, dir: baseData[2] ?? 0 }, currentZoom, currentOffset, mapSize, resolution)
        } else if (Array.isArray(baseData) && baseData[0] !== NO_BASE && robot.type === RobotType.NeatoGen3) {
            drawBase(ctx, { x: baseData[0], y: baseData[1], dir: baseData[2] ?? 0 }, currentZoom, currentOffset, mapSize, 0)
        }

        if (mode === 'boundary-edit') {
            drawCrosshair(ctx, canvas)
            if (closedAsPolygon) {
                drawZones(ctx, [{ vertices: currentLinePoints, name: '', color: editForm.color, type: 'polygon', id: '', enabled: true }], currentZoom, currentOffset, mapSize)
            }
            drawInProgressPolyline(ctx, currentLinePoints, currentZoom, currentOffset, mapSize, selectedPoint ?? undefined)
        }
    }, [boundaries, activeBoundaryId, mode, currentLinePoints, closedAsPolygon, selectedPoint, editForm.color, persistentMaps, persistentMap, dockReady, heatmap])

    // Fetch boundaries when persistentMap changes
    useEffect(() => {
        if (!persistentMap) return
        getMapBoundaries();
        setMode('boundaries')
        // phone: start with the sheet folded so the map is visible; the list is a drag/tap away
        setDrawerOpen(false)
    }, [persistentMap])

    const updatePersistentMap = (data: { name: string, enabled: boolean }, mapToChange?: string) => {
        const map = mapToChange || persistentMap;
        if (!map) return;
        Http.updatePersistentMap(robot.serial, map, data).finally(() => {
            updatePersistentMaps()
            if (persistentMap) setMode('boundaries')
        })
    }

    const getMapBoundaries = () => {
        if (!persistentMap) return
        skipNextPostRef.current = true
        if (robot.type === RobotType.NeatoGen4) {
            Http.getBoundaries(robot.serial, persistentMap).then(res => setBoundaries(res.data))
        } else {
            // GEN3_COMMANDS.getMapBoundaries(robot.serial, persistentMap).then(res => setBoundaries(res.data.data.boundaries))
            fetchGen3MapBoundaries(robot.serial, persistentMap).then(b => setBoundaries([...b]))
        }
    }

    useEffect(() => {
        if (!persistentMap) return;
        if (skipNextPostRef.current) {
            skipNextPostRef.current = false
            return
        }
        if (robot.type === RobotType.NeatoGen4) {
            Http.postBoundaries(robot.serial, persistentMap, boundaries).then(() => {
                getMapBoundaries();
                const map = persistentMaps?.find(p => p.id === persistentMap)
                // If the map is promoted, promote it again
                if (map && 'promoted' in map && map.promoted) {
                    Http.promoteFloorplan(robot.serial, map.id).then(() => updatePersistentMaps());
                }
            });
            return
        }

        // The robot keeps each coordinate rounded to 4 decimals (0.40996 -> 0.41) and drops the rest,
        // so send it exactly that: what the app shows is then what the robot stores. Only the fields
        // it keeps go out (no gen4 `function`), so gen3ReplyBytes predicts its answer exactly.
        const updatedBoundaries = boundaries.map(({ id, name, color, type, vertices, enabled }) => {
            const rounded = vertices.map(roundPoint)
            return type === 'polygon'
                ? { id, name, color, type, vertices: rounded, enabled, relevancy: roundPoint(calcRelevancy(rounded)) }
                : { id, name, color, type, vertices: rounded, enabled }
        });
        GEN3_COMMANDS.setMapBoundaries(robot.serial, persistentMap, updatedBoundaries).catch(() => {
            getMapBoundaries();
        });
    }, [boundaries]);

    // mode changes
    useEffect(() => {
        if (mode === 'boundaries') setActiveBoundaryId(undefined)
        if (mode === 'map-edit') {
            const pmap = persistentMaps?.find(p => p.id === persistentMap)
            if (!pmap) return;
            setMapEditForm({
                name: pmap.name,
                enabled: 'enabled' in pmap ? pmap.enabled : false // TODO: meh fix
            })
        }
        if (mode !== 'boundary-edit') {
            setCurrentLinePoints([])
            setClosedAsPolygon(false)
            return
        }
        const existingBoundary = boundaries.find(b => b.id === activeBoundaryId);
        setEditForm({
            name: existingBoundary?.name ?? '',
            // New boundary: first preset not used on this map. Existing one with a
            // malformed colour (old un-padded random hex): also fall back to a preset.
            color: normalizeHex(existingBoundary?.color) ?? pickUnusedPreset(boundaries.map(b => b.color)),
            zoneType: existingBoundary
                ? (existingBoundary.type === 'polygon'
                    ? (existingBoundary.function === 'cleaning' ? BoundaryTypes.CLEANING_ZONE : BoundaryTypes.NOGO_ZONE)
                    : BoundaryTypes.NOGO_LINE)
                : pendingKind // new feature: the kind picked in the Add-feature chooser
        });
        setCurrentLinePoints(existingBoundary?.vertices || [])
        setClosedAsPolygon(existingBoundary?.type === 'polygon')
    }, [mode])

    // gen3 byte budget: the robot's answer to a save must stay within GEN3_REPLY_LIMIT, see gen3Budget.ts
    const isGen3 = robot.type === RobotType.NeatoGen3
    const bytesUsed = isGen3 ? gen3ReplyBytes(boundaries) : 0
    const bytesLeft = GEN3_REPLY_LIMIT - bytesUsed
    // the feature being drawn, as it would be saved
    const draftBytes = isGen3 && mode === 'boundary-edit'
        ? gen3ReplyBytes(upsertPreserveOrder(boundaries, {
            id: activeBoundaryId ?? '', name: editForm.name, color: editForm.color, enabled: true,
            type: closedAsPolygon ? 'polygon' as const : 'polyline' as const, vertices: currentLinePoints,
        }))
        : 0
    const draftTooBig = draftBytes > GEN3_REPLY_LIMIT
    // more points only while their bytes still fit, and never more than 10 per feature
    const editMaxPoints = isGen3
        ? Math.max(0, Math.min(GEN3_MAX_POINTS_PER_BOUNDARY,
            currentLinePoints.length + Math.floor((GEN3_REPLY_LIMIT - draftBytes) / GEN3_POINT_BYTES)))
        : undefined
    const minFeatureBytes = (kind: BoundaryTypes) => kind === BoundaryTypes.NOGO_LINE
        ? gen3FeatureBytes('polyline', 2) : gen3FeatureBytes('polygon', 3)
    const kindBlocked = (kind: BoundaryTypes) => isGen3 && minFeatureBytes(kind) > bytesLeft

    const saveEditBoundary = () => {
        if (draftTooBig) return
        setMode(returnFromEditMode);
        const id = activeBoundaryId ?? uuidv4();
        const updated = {
            id,
            name: editForm.name,
            color: editForm.color,
            function: closedAsPolygon ? ((robot.type !== RobotType.NeatoGen4 || editForm.zoneType === BoundaryTypes.CLEANING_ZONE) ? 'cleaning' as const : 'nogo' as const) : 'nogo' as const,
            type: closedAsPolygon ? 'polygon' as const : 'polyline' as const,
            vertices: currentLinePoints,
            enabled: true
        };
        setBoundaries(prev => upsertPreserveOrder(prev, updated));
    };

    const updateForm = <T extends object>(update: UseState<T>, patch: Partial<T>) => {
        update(prev => ({ ...prev, ...patch }))
    }

    const toggleNoGo = (item: NoGoLine | Zone) => {
        setBoundaries(prev => upsertPreserveOrder(prev, { ...item, enabled: !item.enabled }));
    };

    const deleteBoundary = (id: string) => {
        setBoundaries(prev => prev.filter(boundary => boundary.id !== id));
        setMode('boundaries')
    };

    // select a zone or line, from the list or by tapping it on the map: the panel shows its details
    const openInfo = (id: string) => {
        setMode('boundary-info')
        setActiveBoundaryId(id)
        setDrawerOpen(true)
    }

    // a tap on the map while viewing the features: select what is there; on empty map, back to the list
    const onBoundaryTap = (id: string | null) => {
        if (id) openInfo(id)
        else if (mode === 'boundary-info') {
            setMode('boundaries')
            setDrawerOpen(false)
        }
    }

    const openEdit = (id: string) => {
        if (mode !== 'boundaries' && mode !== 'boundary-info') return;
        SetReturnFromEditMode(mode)
        setMode('boundary-edit')
        setActiveBoundaryId(id)
    }

    const handleBackBtn = () => {
        if (mode === 'map-edit' || mode === 'boundary-info') setMode('boundaries')
    }

    const getTitle = () => {
        switch (mode) {
            case 'boundaries':
            case 'map-edit':
                return t('map.mapTitle', { name: persistentMaps?.find(p => p.id === persistentMap)?.name ?? '' })
            case 'boundary-info': return ' '
            case 'boundary-edit':
                if (!drawerOpen) return t('map.dragUpToFinish')
                return t('map.editBoundary')
        }
    }

    const mapRow = (map: NonNullable<typeof persistentMaps>[number]) => (
        <div key={map.id} className={`${styles.item} ${map.id === persistentMap ? styles.currentMap : ''}`} onClick={() => chooseMap(map.id)}>
            <div className={styles.info}>
                <span>{map.name}</span>
                <span className={styles.type}>{new Date('created_at' in map ? map.created_at : map.id).toLocaleDateString()}</span>
            </div>
            <div onClick={e => e.stopPropagation()}>
                {'enabled' in map
                    ? <Input type="switch" skipSection={true} value={map.enabled} onChange={() => updatePersistentMap({ name: map.name, enabled: !map.enabled }, map.id)} />
                    : <PromoteDemoteBtn robot={robot} map={map} onSuccess={updatePersistentMaps} />}
            </div>
        </div>
    )

    // TODO: user should be able to customize what modes etc
    const cleanZone = async (zone: Zone) => {
        if (!persistentMap) return
        if (robot.type === RobotType.NeatoGen3) {
            GEN3_COMMANDS.startCleaningZone(robot.serial, persistentMap, zone.id, getGen3CleaningMode(), getGen3NavigationMode())
            return;
        }
        const promotedFloorplan = await getPromotedFloorplan();
        if (!promotedFloorplan) return // TODO: ERROR (will do when i do gen3)
        GEN4_COMMANDS.startCleaning(robot.serial, getGen4CleaningMode(), getGen4NavigationMode(), promotedFloorplan.id, true, [zone.id])
    }

    return (
        <div className={styles.container}>
            <div className={styles.mapArea}>
                {persistentMap ? (
                    <MapCanvas
                        mapId={persistentMap}
                        mode={mode}
                        extraDraw={extraDraw}
                        redrawKey={extraDraw}
                        currentLinePoints={currentLinePoints}
                        setCurrentLinePoints={setCurrentLinePoints}
                        closedAsPolygon={closedAsPolygon}
                        setClosedAsPolygon={setClosedAsPolygon}
                        // a No-Go Line stays an open line: no closing into a polygon
                        allowClose={editForm.zoneType !== BoundaryTypes.NOGO_LINE}
                        setDrawerOpen={setDrawerOpen}
                        // gen3: at most 10 points per feature, and only as many as the byte budget leaves
                        maxPoints={editMaxPoints}
                        selectedPoint={selectedPoint}
                        setSelectedPoint={setSelectedPoint}
                        mmPerPixel={(persistentMaps?.find(p => p.id === persistentMap) as Floorplan | undefined)?.resolution}
                        boundaries={boundaries}
                        onBoundaryTap={onBoundaryTap}
                        onAddHere={(at) => { setPendingCenter(at); setFeatureChooserOpen(true) }}
                        centerOn={centerOn}
                    />
                ) : (
                    <canvas className={styles.canvas} />
                )}

                {!persistentMap && persistentMaps && (
                    <div className={styles.emptyState}>
                        {exploring ? <p>{t('map.exploring')}</p> : persistentMaps.length === 0 && <>
                            <h2>{t('map.noMapsTitle')}</h2>
                            <p>{robot.type === RobotType.NeatoGen4 ? t('map.gen4SelectMapGuide') : t('map.noMaps')}</p>
                            <Button text={t('map.exploreNewMap')} style='primary' disabled={!isDocked(robot)} onClick={() => setExploreConfirmOpen(true)} />
                            {!isDocked(robot) && <p>{t('map.cannotExploreNewMap')}</p>}
                        </>}
                    </div>
                )}

                {persistentMap && mode !== 'boundary-edit' && (
                    <div className={styles.mapBar}>
                        <button className={styles.mapChip} onClick={() => setSwitcherOpen(true)}>
                            {currentMap?.name || t('map.chooseMap')} <FaChevronDown size={12} />
                        </button>
                        {exploring && <span className={styles.mapNote}>{t('map.exploring')}</span>}
                        {newMapId === persistentMap && (
                            <div className={styles.mapNote}>
                                <span>{t('map.newMapName')}</span>
                                <Input type="text" skipSection={true} value={newMapName} onChange={setNewMapName} />
                                <Button text={t('common.save')} style='success' disabled={!newMapName.trim()} onClick={() => {
                                    updatePersistentMap({ name: newMapName.trim(), enabled: currentMap && 'enabled' in currentMap ? currentMap.enabled : true })
                                    setNewMapId(undefined)
                                }} />
                            </div>
                        )}
                    </div>
                )}
            </div>

            <Drawer
                sidePanel
                open={drawerOpen}
                handle={true}
                showBackButton={['map-edit', 'boundary-info'].includes(mode)}
                onBackButtonClick={handleBackBtn}
                onOpenChange={setDrawerOpen}
                openHeightPercent={mode === 'boundary-edit' ? 60 : mode === 'boundary-info' ? 30 : 70}
                title={getTitle()}
            >
                {mode === 'map-edit' && mapEditform && persistentMap && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <Input
                            type="text"
                            label={t('common.name')}
                            value={mapEditform.name}
                            onChange={(name) => updateForm(setMapEditForm, { name })} />
                        {robot.type === RobotType.NeatoGen3 && (
                            <Input type="switch" label={t('common.enabled')} value={mapEditform.enabled} onChange={(enabled) => updateForm(setMapEditForm, { enabled })} />
                        )}
                        <Button text={t('common.save')} style='success' onClick={() => {
                            updatePersistentMap(mapEditform);
                        }} />
                        {robot.type === RobotType.NeatoGen4 &&
                            (persistentMaps?.find(p => p.id === persistentMap) as Floorplan)?.in_maps_list &&
                            !(persistentMaps?.find(p => p.id === persistentMap) as Floorplan)?.promoted && (
                                <div style={{ padding: '1rem 0' }}>
                                    <Button text={t('map.stopUsingAsFloormap')} style='fail' onClick={() =>
                                        Http.postUnuseMapAsFloorPlan(robot.serial, persistentMap).then(() => {
                                            setMode('boundaries')
                                            updatePersistentMaps()
                                        })} />
                                </div>
                            )}
                    </div>
                )}

                {mode === 'boundary-edit' && (
                    <EditBoundaryDetails
                        currentLinePoints={currentLinePoints}
                        closedAsPolygon={closedAsPolygon}
                        setDrawerOpen={setDrawerOpen}
                        save={saveEditBoundary}
                        name={editForm.name}
                        color={editForm.color}
                        zoneType={editForm.zoneType}
                        setName={(name) => updateForm(setEditForm, { name })}
                        setColor={(color) => updateForm(setEditForm, { color })}
                        setZoneType={(zoneType) => updateForm(setEditForm, { zoneType })}
                        cancel={() => {
                            setMode(returnFromEditMode)
                        }}
                        supportsZoneType={robot.type === RobotType.NeatoGen4}
                        tooBig={draftTooBig ? { bytes: draftBytes, max: GEN3_REPLY_LIMIT } : undefined}
                    />
                )}

                {mode === 'boundary-info' && activeBoundaryId && (
                    <BoundaryDetails
                        map={persistentMaps?.find(p => p.id === persistentMap)}
                        boundary={boundaries.find(b => b.id === activeBoundaryId)!}
                        docked={isDocked(robot)}
                        deleteBoundary={deleteBoundary}
                        toggleEnabled={toggleNoGo}
                        editBoundary={() => {
                            setMode('boundary-edit');
                            SetReturnFromEditMode(mode)
                        }}
                        onCleanZone={(zone) => cleanZone(zone)}
                    />
                )}

                {mode === 'boundaries' && (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end' }}>
                            {robot.type === RobotType.NeatoGen4 ? (
                                <PromoteDemoteBtn robot={robot} map={persistentMaps?.find(p => p.id === persistentMap) as Floorplan} onSuccess={updatePersistentMaps} />
                            ) : (
                                <span>{(persistentMaps?.find(p => p.id === persistentMap) as Neato.Gen3.PersistentMap)?.enabled ? t('common.enabled') : t('common.disabled')}</span>
                            )}

                            <Button text={t('map.editMapDetails')} style='primary' onClick={() => setMode('map-edit')} />
                        </div>
                        {robot.type === RobotType.NeatoGen3 && (
                            <div className={styles.heatmap}>
                                <Input type="switch" label={t('map.heatmap')} value={showHeatmap} onChange={setShowHeatmap} />
                                {showHeatmap && (
                                    <>
                                        <Input
                                            type="dropdown"
                                            label={t('map.heatmapRuns')}
                                            options={[10, 30].map(n => ({ value: n, label: t('map.heatmapLastRuns', { count: n }) }))}
                                            value={heatmapRuns}
                                            onChange={setHeatmapRuns}
                                        />
                                        <div className={styles.heatmapLegend}>
                                            <span>{t('map.heatmapRarely')}</span>
                                            {HEATMAP_ALPHAS.map(alpha => <i key={alpha} style={{ opacity: alpha }} />)}
                                            <span>{t('map.heatmapOften')}</span>
                                            <i className={styles.never} />
                                            <span>{t('map.heatmapNever')}</span>
                                        </div>
                                        <span className={styles.heatmapInfo}>
                                            {heatmapLoading ? t('common.loading') : t('map.heatmapCount', { runs: heatmap?.runs ?? 0 })}
                                        </span>
                                    </>
                                )}
                            </div>
                        )}
                        <hr />
                        <div className={styles.buttonContainer}>
                            <Button text={t('map.addFeature')} style='primary' onClick={() => { setPendingCenter(null); setFeatureChooserOpen(true) }} />
                        </div>
                        {boundaries.length > 0 && <p className={styles.tapHint}>{t('map.tapHint')}</p>}
                        {isGen3 && (
                            <div className={styles.budget}>
                                <div className={styles.budgetBar}>
                                    <i className={bytesLeft < gen3FeatureBytes('polyline', 2) ? styles.budgetFull : ''}
                                        style={{ width: `${Math.min(100, bytesUsed / GEN3_REPLY_LIMIT * 100)}%` }} />
                                </div>
                                <p className={styles.tapHint}>
                                    {t('map.byteBudget', { used: bytesUsed, max: GEN3_REPLY_LIMIT })}
                                    {' '}{t('map.byteBudgetLines', { count: Math.max(0, Math.floor(bytesLeft / gen3FeatureBytes('polyline', 2))) })}
                                </p>
                            </div>
                        )}

                        <div className={styles.featureList}>
                            {boundaries.map((item, i) => (
                                <div key={i} className={styles.item} style={{ background: withAlpha(item.color, 0.13) }} onClick={() => openInfo(item.id)}>
                                    <div className={styles.info}>
                                        <span>{item.name}</span>
                                        <span className={styles.type} style={{ color: normalizeHex(item.color) ?? undefined }}>
                                            {item.type === 'polygon' ?
                                                'function' in item ? (item.function === 'cleaning' ? t('map.cleaningZone') : t('map.noGoZone'))
                                                    : t('map.zone') : t('map.noGoLine')
                                            }
                                        </span>
                                    </div>
                                    {('promoted' in (persistentMaps?.find(p => p.id === persistentMap) as Floorplan) ? (persistentMaps?.find(p => p.id === persistentMap) as Floorplan).promoted : true) && (
                                        <>
                                            {(item.type === 'polyline' || item.function === 'nogo') && (<Input type="switch" skipSection={true} value={item.enabled} onChange={() => toggleNoGo(item)} />)}
                                            {item.type === 'polygon' && ('function' in item ? item.function === 'cleaning' : true) && (<Button style='primary' disabled={!isDocked(robot)} text={t('map.cleanZone')} onClick={() => cleanZone(item)} />)}
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>

                    </div>
                )}
                {robot.type === RobotType.NeatoGen4 && mode === 'boundaries' && (
                    <span style={{ width: '90%', display: 'flex', margin: 'auto auto 0 auto', paddingTop: '1rem', opacity: 0.5, textAlign: 'center', fontSize: '1.3rem' }}>
                        {t('map.gen4UpdateBugHint')}
                    </span>
                )}
            </Drawer>

            <Drawer open={switcherOpen} handle={false} onOpenChange={setSwitcherOpen} title={t('map.chooseMap')}
                footer={<>
                    <Button text={t('map.exploreNewMap')} style='primary' disabled={!isDocked(robot) || exploring} onClick={() => setExploreConfirmOpen(true)} />
                    {!isDocked(robot) && !exploring && <p className={styles.tapHint}>{t('map.cannotExploreNewMap')}</p>}
                </>}>
                <div className={styles.featureList}>
                    <p className={styles.tapHint}>{t('map.mapsHint')}</p>
                    {persistentMaps?.filter(isActive).map(mapRow)}
                    {!!persistentMaps?.some(m => !isActive(m)) && (
                        <details className={styles.olderMaps}>
                            <summary>{t('map.mapsOff', { count: persistentMaps.filter(m => !isActive(m)).length })}</summary>
                            {persistentMaps.filter(m => !isActive(m)).map(mapRow)}
                        </details>
                    )}
                </div>
            </Drawer>

            <Drawer open={exploreConfirmOpen} handle={false} onOpenChange={setExploreConfirmOpen} title={t('map.exploreTitle')}
                footer={<div className={styles.editBoundaryActionButtons}>
                    <Button text={t('common.cancel')} style='fail' onClick={() => setExploreConfirmOpen(false)} />
                    <Button text={t('map.exploreStart')} style='success' disabled={!isDocked(robot)} onClick={startExplore} />
                </div>}>
                <p>{t('map.exploreText')}</p>
            </Drawer>

            <Drawer open={featureChooserOpen} handle={false} onOpenChange={setFeatureChooserOpen} title={t('map.chooseFeature')}>
                <div className={styles.featureChooser}>
                    {(robot.type === RobotType.NeatoGen4
                        ? [BoundaryTypes.CLEANING_ZONE, BoundaryTypes.NOGO_ZONE, BoundaryTypes.NOGO_LINE]
                        : [BoundaryTypes.CLEANING_ZONE, BoundaryTypes.NOGO_LINE]
                    ).map(kind => (
                        <button key={kind} className={styles.featureChoice}
                            disabled={kindBlocked(kind)}
                            onClick={() => {
                                setPendingKind(kind)
                                setFeatureChooserOpen(false)
                                openEdit(uuidv4())
                                if (pendingCenter) setCenterOn([...pendingCenter]) // a fresh value re-centres
                                setPendingCenter(null)
                            }}>
                            <span className={styles.featureChoiceName}>{
                                kind === BoundaryTypes.CLEANING_ZONE ? t('map.cleaningZone')
                                    : kind === BoundaryTypes.NOGO_ZONE ? t('map.noGoZone') : t('map.noGoLine')
                            }</span>
                            <span className={styles.featureChoiceDesc}>{
                                kind === BoundaryTypes.CLEANING_ZONE ? t('map.featureCleaningZoneDesc')
                                    : kind === BoundaryTypes.NOGO_ZONE ? t('map.featureNoGoZoneDesc') : t('map.featureNoGoLineDesc')
                            }</span>
                            {kindBlocked(kind) && (
                                <span className={styles.featureChoiceReason}>
                                    {t('map.byteBudgetReason', { left: Math.max(0, bytesLeft), need: minFeatureBytes(kind) })}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </Drawer>
        </div>
    )
}

interface BoundaryDetailsProps {
    map?: Floorplan | Neato.Gen3.PersistentMap
    boundary: NoGoLine | Zone
    docked: boolean
    editBoundary: (id: string) => void
    deleteBoundary: (id: string) => void
    toggleEnabled: (boundary: NoGoLine | Zone) => void
    onCleanZone: (boundary: Zone) => void
}

const BoundaryDetails = (props: BoundaryDetailsProps) => {
    const { t } = useTranslation()
    return (
        <div className={styles.boundaryDetails}>
            <div className={styles.featureList}>
                <div className={styles.item} style={{ background: withAlpha(props.boundary.color, 0.13) }}>
                    <div className={styles.info}>
                        <span>{props.boundary.name}</span>
                        <span className={styles.type} style={{ color: normalizeHex(props.boundary.color) ?? undefined }}>
                            {props.boundary.type === 'polygon' ?
                                'function' in props.boundary ? (props.boundary.function === 'cleaning' ? t('map.cleaningZone') : t('map.noGoZone'))
                                    : t('map.zone') : t('map.noGoLine')
                            }
                        </span>
                    </div>
                    {(props.map && 'promoted' in props.map ? props.map.promoted : true) && (
                        <>
                            {(props.boundary.type === 'polyline' || props.boundary.function === 'nogo') && (<Input type="switch" skipSection={true} value={props.boundary.enabled} onChange={() => props.toggleEnabled(props.boundary)} />)}
                            {props.boundary.type === 'polygon' && ('function' in props.boundary ? props.boundary.function === 'cleaning' : true) && (<Button style='primary' disabled={!props.docked} text={t('map.cleanZone')} onClick={() => props.onCleanZone(props.boundary as Zone)} />)}
                        </>
                    )}
                </div>
            </div>

            <div className={styles.zoneActions}>
                {/* TODO: add a scheduiling feature here in the future */}
                {/* {props.boundary.type === 'polygon' && (
                    <Button text={t('map.addSchedule')} style='secondary' onClick={() => console.log('Add schedule')} />
                )} */}
                <Button text={t('common.edit')} style='primary' onClick={() => props.editBoundary(props.boundary.id)} />
                <Button text={t('common.delete')} style='fail' onClick={() => props.deleteBoundary(props.boundary.id)} />
            </div>
        </div>
    )
}


enum BoundaryTypes {
    NOGO_LINE = 'nogo-line',
    NOGO_ZONE = 'nogo-zone',
    CLEANING_ZONE = 'cleaning-zone',
}

interface EditBoundaryDetailsProps {
    currentLinePoints: Point[]
    closedAsPolygon: boolean
    name: string,
    setName: (name: string) => void;
    color: string,
    setColor: (color: string) => void;
    zoneType: BoundaryTypes;
    setZoneType: (zoneType: BoundaryTypes) => void;
    save: () => void
    cancel: () => void
    setDrawerOpen: (open: boolean) => void;
    supportsZoneType: boolean
    // gen3: the map would be too big for the robot with this feature as it is
    tooBig?: { bytes: number, max: number }
}

const EditBoundaryDetails = (props: EditBoundaryDetailsProps) => {
    const { t } = useTranslation()
    return (
        <div className={styles.editBoundaryDetails}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <Input
                    type="text"
                    label={t('common.name')}
                    value={props.name}
                    onChange={(value) => props.setName(value)} />

                {props.currentLinePoints.length > 1 ? (
                    <Input
                        type="select"
                        label={props.supportsZoneType && props.closedAsPolygon ? t('map.zoneType') : t('common.type')}
                        options={[
                            {
                                value: props.closedAsPolygon ? BoundaryTypes.CLEANING_ZONE : BoundaryTypes.NOGO_LINE,
                                label: props.closedAsPolygon ? (props.supportsZoneType ? t('map.cleaning') : t('map.zone')) : t('map.noGoLine')
                            },
                            ...((props.supportsZoneType && props.closedAsPolygon) ? [{ value: BoundaryTypes.NOGO_ZONE, label: t('map.noGo') }] : [])
                        ]}
                        value={props.closedAsPolygon ? (props.supportsZoneType ? props.zoneType : BoundaryTypes.CLEANING_ZONE) : BoundaryTypes.NOGO_LINE}
                        onChange={(zoneType) => {
                            if (!props.supportsZoneType) return;
                            props.setZoneType(zoneType)
                        }}
                        extraInfo={
                            props.closedAsPolygon ?
                                t('map.polygonHint') :
                                t('map.lineHint')
                        }
                    />
                ) : (
                    <Input
                        type="custom"
                        label={t('common.type')}
                        extraInfo={t('map.drawHint')}>
                        <Button text={t('map.drawBoundary')} style='primary' onClick={() => props.setDrawerOpen(false)} />
                    </Input>
                )}

                <Input type="custom" label={t('map.color')}>
                    <ColorPicker value={props.color} onChange={props.setColor} />
                </Input>
            </div>


            {props.tooBig && (
                <p className={styles.featureChoiceReason}>{t('map.byteBudgetTooBig', props.tooBig)}</p>
            )}
            <div className={styles.editBoundaryActionButtons}>
                <Button text={t('common.cancel')} style='fail' onClick={() => props.cancel()} />
                <Button text={t('common.save')} style='success' disabled={!!props.tooBig} onClick={() => props.save()} />
            </div>
        </div>
    )
}

interface PromoteDemoteBtnProps {
    robot: Robot,
    map: Floorplan
    onSuccess: () => void
}
const PromoteDemoteBtn = ({ robot, map, onSuccess }: PromoteDemoteBtnProps) => {
    const { t } = useTranslation()
    return <Button text={map.promoted ? t('map.demote') : t('map.promote')} onClick={() => {
        if (map.promoted) Http.demoteFloorplan(robot.serial, map.id).finally(() => onSuccess())
        else Http.promoteFloorplan(robot.serial, map.id).finally(() => onSuccess());
    }} style={map.promoted ? 'fail' : 'success'} />
}
