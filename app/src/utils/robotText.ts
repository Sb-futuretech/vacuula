import i18n from '../i18n'

// a robot error / alert code as the translated text the home page shows for it, else the code itself
export function robotCodeText(robotType: string, code: string): string {
    const key = `robotErrorCode.${robotType}.${code}`
    return i18n.exists(key) ? i18n.t(key as any) : code
}

/**
 * Gen3 firmware stores names exactly as the JSON escape it received, so
 * "Büro" comes back as the literal text "Büro". Re-saving that escapes the
 * backslash again ("B\\u00fcro", ...), growing on every save. Turn any run of
 * backslashes + uXXXX back into the real character.
 */
export function decodeRobotText(text: string): string {
    return text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
