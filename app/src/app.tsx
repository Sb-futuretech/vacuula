import Navbar from "./components/navbar/navbar"
import Map from "./pages/map/map"
import styles from './app.module.scss'
import { Routes, Route } from "react-router"
import Runs from "./pages/runs/runs"
import Topbar from "./components/topbar/topbar"
import Home from "./pages/home/home"
import AppLoadingIndicator from "./components/appLoadingIndicator/appLoadingIndicator"
import Schedule from "./pages/schedule/schedule"
import Settings from "./pages/settings/settings"
import Drive from "./pages/drive/drive"
import Notifications from "./pages/notifications/notifications"
import { RequireRobot } from "./components/require/requireRobot"
import { RequireRobots } from "./components/require/requireRobots"

const App = () => (
    <div className={styles.app}>
        <AppLoadingIndicator />
        <RequireRobots>
            <div className={styles.topbar}>
                <Topbar />
            </div>
            <div className={styles.content}>
                <RequireRobot>
                    <Routes>
                        <Route index element={<Home />} />
                        <Route path="runs" element={<Runs />} />
                        <Route path="map" element={<Map />} />
                        <Route path="schedule" element={<Schedule />} />
                        <Route path="settings" element={<Settings />} />
                        <Route path="drive" element={<Drive />} />
                        <Route path="notifications" element={<Notifications />} />
                    </Routes>
                </RequireRobot>
            </div>
            <div className={styles.navbar}>
                <Navbar />
            </div>
        </RequireRobots>
    </div>
)

export default App

