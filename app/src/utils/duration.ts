import i18n from '../i18n'

// "1 h 2 min 3 s" / "2 min 3 s" between two ISO timestamps
export function formatDuration(startDate: string, endDate: string) {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    const totalSeconds = Math.floor((end - start) / 1000);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return i18n.t('runs.durationLong', { hours, minutes, seconds });
    }

    return i18n.t('runs.durationShort', { minutes, seconds });
}
