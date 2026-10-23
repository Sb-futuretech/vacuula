import { Neato } from "../types";


export function getGen3CleaningMode(): Neato.Gen3.CleaningMode {
    const mode = Number(localStorage.getItem('vacuula.gen3.cleaningMode')) || Neato.Gen3.CleaningMode.ECO
    // Gen3 rejects Deep together with Eco (invalid_entry), never hand out that combination
    if (mode === Neato.Gen3.CleaningMode.ECO && getGen3NavigationMode() === Neato.Gen3.CleaningNavigationMode.DEEP)
        return Neato.Gen3.CleaningMode.NORMAL
    return mode
}
export function getGen3NavigationMode(): Neato.Gen3.CleaningNavigationMode {
    return Number(localStorage.getItem('vacuula.gen3.navigationMode')) || Neato.Gen3.CleaningNavigationMode.NORMAL
}

export function getGen4CleaningMode(): Neato.Gen4.CleaningMode {
    return localStorage.getItem('vacuula.gen4.cleaningMode') as (Neato.Gen4.CleaningMode | null) || Neato.Gen4.CleaningMode.ECO
}
export function getGen4NavigationMode(): Neato.Gen4.CleaningNavigationMode {
    return localStorage.getItem('vacuula.gen4.navigationMode') as (Neato.Gen4.CleaningNavigationMode | null) || Neato.Gen4.CleaningNavigationMode.NORMAL
}

