/**
 * Gen3 firmware stores names exactly as the JSON escape it received, so
 * "Büro" comes back as the literal text "Büro". Re-saving that escapes the
 * backslash again ("B\\u00fcro", ...), growing on every save. Turn any run of
 * backslashes + uXXXX back into the real character.
 */
export function decodeRobotText(text: string): string {
    return text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
