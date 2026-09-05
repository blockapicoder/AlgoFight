import * as client from "./node_modules/tauri-kargo-tools/src/api"

export interface BotSourceFile {
    type: "file"
    name: string
    path: string
}

export interface BotSourceDirectory {
    type: "directory"
    name: string
    path: string
    content: BotSourceNode[]
}

export type BotSourceNode = BotSourceFile | BotSourceDirectory

interface RawBotTreeFile {
    type: "file"
    name: string
}

interface RawBotTreeDirectory {
    type: "directory"
    name: string
    content?: RawBotTreeNode[]
}

type RawBotTreeNode = RawBotTreeFile | RawBotTreeDirectory

export const GENERATED_BOTS_DIRECTORY = "bots/generated"

export async function codePath() {
    const tc = new client.TauriKargoClient()
    const config = await tc.getConfig()
    let code = config.code
    if (config.routes) {
        code = config.routes["/app"] ?? code
    }
    return code
}
export async function listBotsScript() {
    const tree = await listBotSources()
    const rootBots = tree.content.filter((entry): entry is BotSourceFile =>
        entry.type === "file" && entry.name.toLowerCase().endsWith(".ts")
    )
    const generatedDirectory = tree.content.find((entry): entry is BotSourceDirectory =>
        entry.type === "directory" && entry.path === GENERATED_BOTS_DIRECTORY
    )
    const generatedBots = (generatedDirectory?.content ?? []).filter((entry): entry is BotSourceFile =>
        entry.type === "file" && entry.name.toLowerCase().endsWith(".ts")
    )

    return [...rootBots, ...generatedBots]
        .map(entry => `/${entry.path}`)
        .sort((a, b) => a.localeCompare(b, "fr"))
}

export function normalizeBotSourcePath(value: string, allowRoot = false) {
    const raw = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\/+/, "")
    if (!raw || raw.includes("\0") || /^[a-z]:/i.test(raw)) {
        throw new Error("Chemin de bot invalide")
    }

    const parts = raw.split("/")
    if (
        parts[0] !== "bots"
        || parts.some(part => !part || part === "." || part === "..")
    ) {
        throw new Error("Le chemin doit rester dans le répertoire bots")
    }

    const path = parts.join("/")
    if (!allowRoot && path === "bots") {
        throw new Error("Un fichier ou un sous-répertoire de bots est requis")
    }
    return path
}

export function isGeneratedBotSourcePath(value: string) {
    const path = normalizeBotSourcePath(value, true)
    return path === GENERATED_BOTS_DIRECTORY || path.startsWith(`${GENERATED_BOTS_DIRECTORY}/`)
}

function assertWritableSourcePath(value: string) {
    const raw = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\/+/, "")
    if (
        !raw
        || raw.includes("\0")
        || /^[a-z]:/i.test(raw)
        || raw.split("/").some(part => !part || part === "." || part === "..")
    ) {
        throw new Error("Chemin de source invalide")
    }
    if (raw === GENERATED_BOTS_DIRECTORY || raw.startsWith(`${GENERATED_BOTS_DIRECTORY}/`)) {
        throw new Error("Les bots générés sont intégrés au jeu et disponibles uniquement en lecture")
    }
    return raw
}

export async function listBotSources(): Promise<BotSourceDirectory> {
    const tc = new client.TauriKargoClient()
    const code = await codePath()
    const result = await tc.explorer({
        path: code + "/bots",
        type: "tree",
        maxDeep: 32,
        maxSize: 5000
    })
    if (result.type === "error") throw new Error(result.message)
    if (result.type !== "directory") throw new Error("Le répertoire bots est introuvable")

    const convert = (entries: RawBotTreeNode[], parentPath: string): BotSourceNode[] => {
        const nodes: BotSourceNode[] = []
        for (const entry of entries) {
            const name = entry.name
            if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
                continue
            }
            const path = normalizeBotSourcePath(`${parentPath}/${name}`)
            if (entry.type === "file") {
                nodes.push({ type: "file", name, path })
            } else {
                nodes.push({
                    type: "directory",
                    name,
                    path,
                    content: convert(entry.content ?? [], path)
                })
            }
        }
        return nodes
    }

    return {
        type: "directory",
        name: "bots",
        path: "bots",
        content: convert(result.content as RawBotTreeNode[], "bots")
    }
}

export async function createBotDirectory(path: string) {
    const safePath = assertWritableSourcePath(normalizeBotSourcePath(path))
    const tc = new client.TauriKargoClient()
    const code = await codePath()
    await tc.setCurrentDirectory({ path: code })
    return await tc.createDirectory(safePath)
}
export async function readSource(file: string) {
    const tc = new client.TauriKargoClient()
    let code = await codePath()
    await tc.setCurrentDirectory({ path: code })
    return await tc.readFileText(file)
}

export async function writeSource(file: string, src: string) {
    const safeFile = assertWritableSourcePath(file)
    const tc = new client.TauriKargoClient()
    let code = await codePath()
    await tc.setCurrentDirectory({ path: code })
    await tc.writeFileText(safeFile, src)
}

export async function deleteSource(file: string) {
    const safeFile = assertWritableSourcePath(file)
    const tc = new client.TauriKargoClient()
    let code = await codePath()
    await tc.setCurrentDirectory({ path: code })
    await tc.deleteFile(safeFile)
}
