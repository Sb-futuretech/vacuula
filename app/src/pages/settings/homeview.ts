// What the home page shows in its centre: the mascot, or the map of the last cleaning
export type HomeView = 'mascot' | 'lastRun'

// TODO: check if we can get the correct lanauge type here later!!
export const HOME_VIEWS: { value: HomeView; label: any }[] = [
    { value: 'mascot', label: 'settings.homeView_mascot' },
    { value: 'lastRun', label: 'settings.homeView_lastRun' },
]

export function saveHomeView(view: HomeView) {
    localStorage.setItem('vacuula.homeView', view);
}

export function loadHomeView(): HomeView {
    const view = localStorage.getItem('vacuula.homeView') as HomeView | null;
    return view && HOME_VIEWS.some(v => v.value === view) ? view : 'mascot';
}
