import {
    BotSourceDirectory,
    BotSourceFile,
    BotSourceNode,
    GENERATED_BOTS_DIRECTORY,
    createBotDirectory,
    deleteSource,
    isGeneratedBotSourcePath,
    listBotSources,
    normalizeBotSourcePath,
    readSource,
    writeSource
} from "./bots-script-tools"
import { initMonacoFromFilesObject } from "./monaco"

type MonacoChangeType = "syntaxError" | "semanticError" | "value"
type CreationKind = "bot" | "utility" | "directory"

interface MonacoEditorLike {
    dispose(): void
    focus(): void
    getValue(): string
}

interface ProjectFile {
    content: string
}

const SUPPORT_FILES = ["algofight-entity-model.ts", "entity-model.ts"] as const
const TEXT_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|json|md|txt|css|html?)$/i
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const
const AUTOSAVE_DELAY = 700

function escapeHtml(value: unknown) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;")
}

function dirname(path: string) {
    const index = path.lastIndexOf("/")
    return index <= 0 ? "bots" : path.slice(0, index)
}

function isBotFile(path: string) {
    return /^bots\/[^/]+\.ts$/i.test(path) || /^bots\/generated\/[^/]+\.ts$/i.test(path)
}

function sourceWithoutComments(source: string) {
    let result = ""
    let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code"
    let escaped = false

    for (let index = 0; index < source.length; index++) {
        const character = source[index]
        const next = source[index + 1]

        if (state === "line-comment") {
            if (character === "\n") {
                state = "code"
                result += character
            } else {
                result += " "
            }
            continue
        }
        if (state === "block-comment") {
            if (character === "*" && next === "/") {
                result += "  "
                index++
                state = "code"
            } else {
                result += character === "\n" ? "\n" : " "
            }
            continue
        }
        if (state === "code") {
            if (character === "/" && next === "/") {
                result += "  "
                index++
                state = "line-comment"
                continue
            }
            if (character === "/" && next === "*") {
                result += "  "
                index++
                state = "block-comment"
                continue
            }
            if (character === "'") state = "single"
            else if (character === '"') state = "double"
            else if (character === "`") state = "template"
            result += character
            continue
        }

        result += character
        if (escaped) {
            escaped = false
        } else if (character === "\\") {
            escaped = true
        } else if (
            (state === "single" && character === "'")
            || (state === "double" && character === '"')
            || (state === "template" && character === "`")
        ) {
            state = "code"
        }
    }
    return result
}

function moduleSpecifiers(source: string) {
    const cleanSource = sourceWithoutComments(source)
    const specifiers = new Set<string>()
    const patterns = [
        /\bfrom\s*["']([^"']+)["']/g,
        /\bimport\s*["']([^"']+)["']/g,
        /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g
    ]
    for (const pattern of patterns) {
        for (const match of cleanSource.matchAll(pattern)) specifiers.add(match[1])
    }
    return [...specifiers]
}

function resolveModulePath(importerPath: string, specifier: string, availablePaths: Set<string>) {
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0].replaceAll("\\", "/")
    let parts: string[]
    if (cleanSpecifier.startsWith("./") || cleanSpecifier.startsWith("../")) {
        const slashIndex = importerPath.lastIndexOf("/")
        parts = slashIndex < 0 ? [] : importerPath.slice(0, slashIndex).split("/")
    } else if (cleanSpecifier === "bots" || cleanSpecifier.startsWith("bots/") || cleanSpecifier.startsWith("/bots/")) {
        parts = []
    } else {
        return undefined
    }

    for (const part of cleanSpecifier.replace(/^\/+/, "").split("/")) {
        if (!part || part === ".") continue
        if (part === "..") parts.pop()
        else parts.push(part)
    }
    const unresolvedPath = parts.join("/")
    const candidates = [unresolvedPath]
    if (!/\.[a-z0-9]+$/i.test(unresolvedPath)) {
        for (const extension of MODULE_EXTENSIONS) candidates.push(`${unresolvedPath}${extension}`)
        for (const extension of MODULE_EXTENSIONS) candidates.push(`${unresolvedPath}/index${extension}`)
    } else if (/\.(?:mjs|cjs|js|jsx)$/i.test(unresolvedPath)) {
        const stem = unresolvedPath.replace(/\.(?:mjs|cjs|js|jsx)$/i, "")
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`)
    }
    return candidates.find(candidate => availablePaths.has(candidate))
}

function botTemplate() {
    return `import {
    Drone,
    Monde,
    setTarget,
    start
} from "../algofight-entity-model"

start((monde: Monde) => {
    const drones = monde.entities.filter(
        (entity): entity is Drone =>
            entity instanceof Drone
            && entity.joueur === monde.joueur
            && !entity.cible
    )

    for (const drone of drones) {
        // Choisissez une cible puis appelez : setTarget(drone, cible)
    }
})
`
}

function utilityTemplate(name: string) {
    const exportName = name
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_$]+(.)/g, (_, next: string) => next.toUpperCase())
        .replace(/^[^a-zA-Z_$]+/, "") || "utilitaire"
    return `export function ${exportName}() {
    // Fonction utilitaire partagée par les bots.
}
`
}

export interface BotsDevOptions {
    /** Fichier ouvert dès l’arrivée dans l’éditeur. */
    initialFile?: string
    /** Masque l’explorateur et limite l’écran à la modification du fichier choisi. */
    focusedFile?: boolean
    backLabel?: string
}

export class BotsDev {
    root!: HTMLDivElement

    private explorerElement!: HTMLElement
    private selectedDirectoryElement!: HTMLElement
    private newNameInput!: HTMLInputElement
    private editorHost!: HTMLDivElement
    private emptyElement!: HTMLElement
    private pathElement!: HTMLElement
    private kindElement!: HTMLElement
    private saveButton!: HTMLButtonElement
    private deleteButton!: HTMLButtonElement
    private backButton!: HTMLButtonElement
    private refreshButton!: HTMLButtonElement
    private statusElement!: HTMLElement
    private diagnosticElement!: HTMLElement

    private tree?: BotSourceDirectory
    private selectedDirectory = "bots"
    private selectedPath?: string
    private editor?: MonacoEditorLike
    private projectFiles: Record<string, ProjectFile> = {}
    private savedSource = ""
    private dirty = false
    private busy = false
    private autosaveTimer?: ReturnType<typeof setTimeout>
    private previousBodyOverflow?: string
    private readonly onBack: () => void | Promise<void>
    private readonly options: BotsDevOptions
    private readonly keydownHandler = (event: KeyboardEvent) => this.onKeydown(event)

    constructor(onBack: () => void | Promise<void>, options: BotsDevOptions = {}) {
        this.onBack = onBack
        this.options = options
        if (options.initialFile) {
            this.selectedPath = normalizeBotSourcePath(options.initialFile)
            this.selectedDirectory = dirname(this.selectedPath)
        }
    }

    createInterface() {
        this.root = document.createElement("div")
        this.root.className = "bots-dev"
        this.root.dataset.focusedFile = String(Boolean(this.options.focusedFile && this.selectedPath))
        const focusedFile = this.root.dataset.focusedFile === "true"
        const title = focusedFile ? "ALGOFIGHT · MODIFIER LE BOT" : "ALGOFIGHT · BOT STUDIO"
        const subtitle = focusedFile && this.selectedPath
            ? this.selectedPath
            : "Vos bots sont à la racine de bots. Les bots intégrés dans generated sont consultables en lecture seule."
        const backLabel = this.options.backLabel ?? "← Retour au jeu"
        this.root.innerHTML = `
            <style>
                .bots-dev {
                    --background: #050812;
                    --surface: #0d1527;
                    --surface-2: #080e1c;
                    --border: rgba(135, 158, 207, .24);
                    --text: #eef4ff;
                    --muted: #91a0be;
                    --accent: #37e686;
                    --blue: #4f86ff;
                    position: fixed;
                    inset: 0;
                    z-index: 2147483001;
                    display: grid;
                    grid-template-rows: auto minmax(0, 1fr) auto;
                    color: var(--text);
                    background:
                        radial-gradient(circle at 0 0, rgba(55, 230, 134, .09), transparent 28%),
                        radial-gradient(circle at 100% 0, rgba(79, 134, 255, .1), transparent 28%),
                        var(--background);
                    font: 14px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
                }
                .bots-dev * { box-sizing: border-box; }
                .bots-dev-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 18px;
                    min-width: 0;
                    padding: 13px 16px;
                    border-bottom: 1px solid var(--border);
                    background: rgba(7, 12, 24, .97);
                }
                .bots-dev-title { min-width: 0; }
                .bots-dev-title strong { display: block; font-size: 20px; letter-spacing: .04em; }
                .bots-dev-title span { display: block; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
                .bots-dev-actions { display: flex; gap: 8px; }
                .bots-dev-button {
                    min-height: 36px;
                    padding: 7px 11px;
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    color: var(--text);
                    background: linear-gradient(180deg, #202e51, #151e37);
                    font: inherit;
                    font-weight: 800;
                    cursor: pointer;
                }
                .bots-dev-button:hover { border-color: #8195c8; transform: translateY(-1px); }
                .bots-dev-button:disabled { cursor: wait; opacity: .48; transform: none; }
                .bots-dev-button.primary { border-color: rgba(55, 230, 134, .45); background: linear-gradient(180deg, #248f60, #176342); }
                .bots-dev-button.danger { border-color: rgba(255, 87, 116, .48); color: #ffdbe2; background: linear-gradient(180deg, #7e2a40, #501b2b); }
                .bots-dev-button.back { border-color: rgba(79, 134, 255, .45); }
                .bots-dev-main {
                    display: grid;
                    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
                    min-height: 0;
                }
                .bots-dev-sidebar {
                    display: grid;
                    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
                    min-height: 0;
                    padding: 12px;
                    border-right: 1px solid var(--border);
                    background: rgba(8, 14, 28, .96);
                }
                .bots-dev-sidebar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
                .bots-dev-sidebar h2 { margin: 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
                .bots-dev-directory {
                    margin: 9px 0;
                    padding: 7px 9px;
                    overflow: hidden;
                    border: 1px solid rgba(55, 230, 134, .18);
                    border-radius: 7px;
                    color: #a9f9ce;
                    background: rgba(55, 230, 134, .06);
                    font: 12px/1.3 ui-monospace, monospace;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .bots-dev-create { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-bottom: 10px; }
                .bots-dev-input {
                    width: 100%;
                    min-width: 0;
                    padding: 8px 9px;
                    border: 1px solid var(--border);
                    border-radius: 7px;
                    outline: none;
                    color: var(--text);
                    background: #050a15;
                    font: inherit;
                }
                .bots-dev-input:focus { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(79, 134, 255, .12); }
                .bots-dev-create-buttons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
                .bots-dev-create-buttons .bots-dev-button { min-height: 32px; padding: 5px; font-size: 11px; }
                .bots-dev-tree { min-height: 0; overflow: auto; padding: 4px 0 12px; }
                .bots-dev-node { margin: 1px 0; }
                .bots-dev-node-button {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    width: 100%;
                    min-width: 0;
                    padding: 6px 7px;
                    border: 1px solid transparent;
                    border-radius: 6px;
                    color: #b8c5df;
                    background: transparent;
                    font: inherit;
                    text-align: left;
                    cursor: pointer;
                }
                .bots-dev-node-button:hover { color: #fff; background: rgba(126, 151, 206, .1); }
                .bots-dev-node-button.selected { border-color: rgba(79, 134, 255, .45); color: #fff; background: rgba(79, 134, 255, .13); }
                .bots-dev-node-icon { flex: 0 0 auto; width: 18px; color: #7f91b5; text-align: center; }
                .bots-dev-node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .bots-dev-node-badge {
                    flex: 0 0 auto;
                    margin-left: auto;
                    padding: 2px 5px;
                    border-radius: 999px;
                    color: #a9f9ce;
                    background: rgba(55, 230, 134, .12);
                    font-size: 9px;
                    font-weight: 900;
                }
                .bots-dev-node-badge.generated { color: #d9e3ff; background: rgba(79, 134, 255, .14); }
                .bots-dev-note { padding-top: 9px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
                .bots-dev-editor-panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
                .bots-dev-editor-toolbar {
                    display: flex;
                    align-items: center;
                    gap: 9px;
                    min-width: 0;
                    padding: 9px 12px;
                    border-bottom: 1px solid var(--border);
                    background: rgba(10, 17, 33, .95);
                }
                .bots-dev-file-path { min-width: 0; overflow: hidden; color: #dce7fb; font: 12px/1.3 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
                .bots-dev-file-kind { flex: 0 0 auto; padding: 3px 6px; border-radius: 999px; color: #aebbd5; background: rgba(143, 164, 211, .12); font-size: 10px; font-weight: 900; }
                .bots-dev-file-kind.bot { color: #a9f9ce; background: rgba(55, 230, 134, .12); }
                .bots-dev-dirty { color: #ffd166; font-size: 12px; }
                .bots-dev-editor-spacer { flex: 1 1 auto; }
                .bots-dev-editor-wrap { position: relative; min-height: 0; background: #060a13; }
                .bots-dev-editor { position: absolute; inset: 0; }
                .bots-dev-empty {
                    position: absolute;
                    inset: 0;
                    z-index: 2;
                    display: grid;
                    place-items: center;
                    padding: 30px;
                    color: var(--muted);
                    background: #060a13;
                    text-align: center;
                }
                .bots-dev-empty[hidden] { display: none; }
                .bots-dev-diagnostic {
                    min-height: 38px;
                    max-height: 100px;
                    padding: 8px 11px;
                    overflow: auto;
                    border-top: 1px solid var(--border);
                    color: #91a0be;
                    background: rgba(7, 12, 24, .98);
                    font: 11px/1.35 ui-monospace, monospace;
                    white-space: pre-wrap;
                }
                .bots-dev-diagnostic[data-state=ok] { color: #82efb5; }
                .bots-dev-diagnostic[data-state=error] { color: #ff8ca2; }
                .bots-dev-footer {
                    display: flex;
                    align-items: center;
                    min-height: 34px;
                    padding: 7px 13px;
                    border-top: 1px solid var(--border);
                    color: var(--muted);
                    background: #070c18;
                    font-size: 12px;
                }
                .bots-dev-footer[data-state=error] { color: #ff8ca2; }
                .bots-dev-footer[data-state=success] { color: #82efb5; }
                .bots-dev[data-focused-file=true] .bots-dev-main { grid-template-columns: minmax(0, 1fr); }
                .bots-dev[data-focused-file=true] .bots-dev-sidebar,
                .bots-dev[data-focused-file=true] [data-role=delete] { display: none; }
                @media (max-width: 780px) {
                    .bots-dev-main { grid-template-columns: 230px minmax(0, 1fr); }
                    .bots-dev-title span { display: none; }
                    .bots-dev-create-buttons { grid-template-columns: 1fr; }
                }
            </style>

            <header class="bots-dev-header">
                <div class="bots-dev-title">
                    <strong>${escapeHtml(title)}</strong>
                    <span>${escapeHtml(subtitle)}</span>
                </div>
                <div class="bots-dev-actions">
                    <button class="bots-dev-button back" data-role="back">${escapeHtml(backLabel)}</button>
                    <button class="bots-dev-button primary" data-role="save" disabled>Sauvegarde auto ✓</button>
                </div>
            </header>

            <main class="bots-dev-main">
                <aside class="bots-dev-sidebar">
                    <div class="bots-dev-sidebar-head">
                        <h2>Explorateur bots</h2>
                        <button class="bots-dev-button" data-role="refresh" title="Recharger les fichiers">↻</button>
                    </div>
                    <div class="bots-dev-directory" data-role="selected-directory">bots</div>
                    <div class="bots-dev-create">
                        <input class="bots-dev-input" data-role="new-name" placeholder="nom du fichier ou dossier" autocomplete="off">
                        <div class="bots-dev-create-buttons">
                            <button class="bots-dev-button" data-create="bot">+ Bot</button>
                            <button class="bots-dev-button" data-create="utility">+ Utilitaire</button>
                            <button class="bots-dev-button" data-create="directory">+ Dossier</button>
                        </div>
                    </div>
                    <div class="bots-dev-tree" data-role="explorer"></div>
                    <div class="bots-dev-note">
                        Vos bots sont des fichiers <strong>.ts</strong> directement dans <strong>bots</strong>.
                        <strong>bots/generated</strong> contient les bots intégrés consultables en lecture seule.
                        Sélectionnez un autre sous-répertoire pour y créer un utilitaire.
                    </div>
                </aside>

                <section class="bots-dev-editor-panel">
                    <div class="bots-dev-editor-toolbar">
                        <span class="bots-dev-file-kind" data-role="file-kind">AUCUN FICHIER</span>
                        <span class="bots-dev-file-path" data-role="file-path">Sélectionnez un fichier</span>
                        <span class="bots-dev-dirty" data-role="dirty"></span>
                        <span class="bots-dev-editor-spacer"></span>
                        <button class="bots-dev-button danger" data-role="delete" disabled>Supprimer</button>
                    </div>
                    <div class="bots-dev-editor-wrap">
                        <div class="bots-dev-editor" data-role="editor"></div>
                        <div class="bots-dev-empty" data-role="empty">Sélectionnez un bot ou un fichier utilitaire dans l’explorateur.</div>
                    </div>
                    <div class="bots-dev-diagnostic" data-role="diagnostic">Monaco est prêt à charger un fichier.</div>
                </section>
            </main>

            <footer class="bots-dev-footer" data-role="status">Chargement du répertoire bots…</footer>
        `
        return this.root
    }

    async init() {
        this.explorerElement = this.role("explorer")
        this.selectedDirectoryElement = this.role("selected-directory")
        this.newNameInput = this.role<HTMLInputElement>("new-name")
        this.editorHost = this.role<HTMLDivElement>("editor")
        this.emptyElement = this.role("empty")
        this.pathElement = this.role("file-path")
        this.kindElement = this.role("file-kind")
        this.saveButton = this.role<HTMLButtonElement>("save")
        this.deleteButton = this.role<HTMLButtonElement>("delete")
        this.backButton = this.role<HTMLButtonElement>("back")
        this.refreshButton = this.role<HTMLButtonElement>("refresh")
        this.statusElement = this.role("status")
        this.diagnosticElement = this.role("diagnostic")

        this.previousBodyOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        this.backButton.addEventListener("click", () => void this.returnToGame())
        this.saveButton.addEventListener("click", () => void this.saveCurrent())
        this.deleteButton.addEventListener("click", () => void this.deleteCurrent())
        this.refreshButton.addEventListener("click", () => void this.reloadProject())
        this.explorerElement.addEventListener("click", event => void this.onExplorerClick(event))
        this.root.querySelectorAll<HTMLButtonElement>("[data-create]").forEach(button => {
            button.addEventListener("click", () => void this.createEntry(button.dataset.create as CreationKind))
        })
        this.newNameInput.addEventListener("keydown", event => {
            if (event.key === "Enter") void this.createEntry("bot")
        })
        window.addEventListener("keydown", this.keydownHandler)

        await this.reloadProject(false)
    }

    private role<T extends HTMLElement = HTMLElement>(name: string) {
        const element = this.root.querySelector(`[data-role="${name}"]`)
        if (!element) throw new Error(`Élément '${name}' introuvable dans Bot Studio`)
        return element as T
    }

    private flattenFiles(node: BotSourceNode): BotSourceFile[] {
        if (node.type === "file") return [node]
        return node.content.flatMap(child => this.flattenFiles(child))
    }

    private async reloadProject(saveBeforeReload = true, preferredPath = this.selectedPath) {
        if (saveBeforeReload && !await this.flushAutosave()) return
        await this.withBusy(() => this.loadProject(preferredPath))
    }

    private async loadProject(preferredPath = this.selectedPath) {
        this.setStatus("Lecture de l’arborescence bots…")
        this.tree = await listBotSources()
        const botFiles = this.flattenFiles(this.tree).filter(file => TEXT_FILE_PATTERN.test(file.name))
        const entries = await Promise.all(botFiles.map(async file => {
            return [file.path, { content: await readSource(file.path) }] as const
        }))
        const supportEntries = await Promise.all(SUPPORT_FILES.map(async path => {
            try {
                return [path, { content: await readSource(path) }] as const
            } catch {
                return undefined
            }
        }))
        this.projectFiles = Object.fromEntries([
            ...entries,
            ...supportEntries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        ])
        this.renderTree()

        const selectablePath = preferredPath && entries.some(([path]) => path === preferredPath)
            ? preferredPath
            : entries.find(([path]) => isBotFile(path))?.[0] ?? entries[0]?.[0]
        if (selectablePath) {
            await this.openFile(selectablePath, false)
        } else {
            this.closeEditor()
        }
        this.setStatus(`${entries.length} fichier${entries.length > 1 ? "s" : ""} chargé${entries.length > 1 ? "s" : ""} depuis bots.`, "success")
    }

    private renderTree() {
        if (!this.tree) {
            this.explorerElement.innerHTML = ""
            return
        }
        this.selectedDirectoryElement.textContent = this.selectedDirectory
        this.explorerElement.innerHTML = this.nodeHtml(this.tree, 0)
    }

    private nodeHtml(node: BotSourceNode, depth: number): string {
        const selected = node.type === "directory"
            ? node.path === this.selectedDirectory
            : node.path === this.selectedPath
        const padding = 7 + depth * 14
        if (node.type === "file") {
            const bot = isBotFile(node.path)
            const generated = isGeneratedBotSourcePath(node.path)
            const supported = TEXT_FILE_PATTERN.test(node.name)
            return `
                <div class="bots-dev-node">
                    <button
                        class="bots-dev-node-button ${selected ? "selected" : ""}"
                        style="padding-left:${padding}px"
                        data-node-type="file"
                        data-node-path="${escapeHtml(node.path)}"
                        ${supported ? "" : "disabled"}
                    >
                        <span class="bots-dev-node-icon">${supported ? "◇" : "×"}</span>
                        <span class="bots-dev-node-name">${escapeHtml(node.name)}</span>
                        ${generated
                            ? '<span class="bots-dev-node-badge generated">INTÉGRÉ</span>'
                            : bot ? '<span class="bots-dev-node-badge">BOT</span>' : ""}
                    </button>
                </div>
            `
        }
        const children = [...node.content].sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name, "fr")
        })
        return `
            <div class="bots-dev-node">
                <button
                    class="bots-dev-node-button ${selected ? "selected" : ""}"
                    style="padding-left:${padding}px"
                    data-node-type="directory"
                    data-node-path="${escapeHtml(node.path)}"
                >
                    <span class="bots-dev-node-icon">▾</span>
                    <span class="bots-dev-node-name">${escapeHtml(node.name)}</span>
                </button>
                ${children.map(child => this.nodeHtml(child, depth + 1)).join("")}
            </div>
        `
    }

    private async onExplorerClick(event: Event) {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-node-path]")
        if (!button || button.disabled) return
        const path = button.dataset.nodePath
        if (!path) return
        if (button.dataset.nodeType === "directory") {
            this.selectedDirectory = normalizeBotSourcePath(path, true)
            this.renderTree()
            this.updateControls()
            return
        }
        if (!await this.flushAutosave()) return
        this.selectedDirectory = dirname(path)
        await this.openFile(path, false)
    }

    private async openFile(path: string, saveBeforeOpen = true) {
        const safePath = normalizeBotSourcePath(path)
        if (saveBeforeOpen && !await this.flushAutosave()) return
        const projectFile = this.projectFiles[safePath]
        if (!projectFile) throw new Error(`Le fichier ${safePath} n’est pas chargé`)

        this.selectedPath = safePath
        this.selectedDirectory = dirname(safePath)
        this.savedSource = projectFile.content
        this.dirty = false
        this.editor?.dispose()
        this.editor = undefined
        this.emptyElement.hidden = true
        this.pathElement.textContent = safePath
        const generated = isGeneratedBotSourcePath(safePath)
        this.kindElement.textContent = generated ? "BOT INTÉGRÉ · LECTURE SEULE" : isBotFile(safePath) ? "BOT" : "UTILITAIRE"
        this.kindElement.className = `bots-dev-file-kind${isBotFile(safePath) ? " bot" : ""}`
        this.diagnosticElement.textContent = generated ? "Bot intégré : le code peut être consulté mais pas modifié." : "Analyse TypeScript…"
        this.diagnosticElement.dataset.state = ""
        this.updateControls()
        this.renderTree()

        const selectedAtOpen = safePath
        const result = await initMonacoFromFilesObject(this.editorHost, {
            files: this.projectFiles,
            entry: safePath,
            editorOptions: {
                fontSize: 15,
                lineHeight: 22,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                tabSize: 4,
                insertSpaces: true,
                wordWrap: "off",
                readOnly: generated,
                readOnlyMessage: { value: "Les bots intégrés sont disponibles uniquement en lecture." }
            },
            onChange: (type: MonacoChangeType, payload: string) => {
                if (this.selectedPath !== selectedAtOpen) return
                this.onEditorChange(type, payload)
            }
        })
        this.editor = result.editor as MonacoEditorLike
        this.editor.focus()
    }

    private onEditorChange(type: MonacoChangeType, payload: string) {
        if (this.selectedPath && isGeneratedBotSourcePath(this.selectedPath)) {
            this.dirty = false
            this.diagnosticElement.textContent = "Bot intégré : le code peut être consulté mais pas modifié."
            this.diagnosticElement.dataset.state = ""
            this.updateControls()
            return
        }
        if (type === "value") {
            this.diagnosticElement.textContent = "Aucune erreur TypeScript détectée."
            this.diagnosticElement.dataset.state = "ok"
        } else {
            this.diagnosticElement.textContent = payload || "Erreur TypeScript"
            this.diagnosticElement.dataset.state = "error"
        }
        this.dirty = Boolean(this.editor && this.editor.getValue() !== this.savedSource)
        this.updateControls()
        if (this.dirty) this.scheduleAutosave()
    }

    private closeEditor() {
        this.cancelAutosave()
        this.editor?.dispose()
        this.editor = undefined
        this.selectedPath = undefined
        this.savedSource = ""
        this.dirty = false
        this.emptyElement.hidden = false
        this.pathElement.textContent = "Sélectionnez un fichier"
        this.kindElement.textContent = "AUCUN FICHIER"
        this.kindElement.className = "bots-dev-file-kind"
        this.diagnosticElement.textContent = "Créez un bot ou sélectionnez un fichier dans l’explorateur."
        this.diagnosticElement.dataset.state = ""
        this.updateControls()
    }

    private async saveCurrent() {
        if (!this.selectedPath || !this.editor || !this.dirty) return
        if (isGeneratedBotSourcePath(this.selectedPath)) {
            this.dirty = false
            this.updateControls()
            return
        }
        this.cancelAutosave()
        if (this.busy) {
            this.scheduleAutosave(250)
            return
        }
        await this.withBusy(async () => {
            const safePath = normalizeBotSourcePath(this.selectedPath!)
            const source = this.editor!.getValue()
            this.setStatus(`Enregistrement de ${safePath}…`)
            await writeSource(safePath, source)
            this.savedSource = source
            const currentSource = this.editor?.getValue() ?? source
            this.projectFiles[safePath] = { content: currentSource }
            this.dirty = currentSource !== source
            this.updateControls()
            if (this.dirty) {
                this.setStatus(`${safePath} a encore été modifié — nouvelle sauvegarde automatique…`)
                this.scheduleAutosave()
            } else {
                this.setStatus(`${safePath} enregistré automatiquement.`, "success")
            }
        })
    }

    private scheduleAutosave(delay = AUTOSAVE_DELAY) {
        this.cancelAutosave()
        if (!this.dirty || !this.selectedPath || !this.editor) return
        const scheduledPath = this.selectedPath
        this.setStatus(`${scheduledPath} modifié — sauvegarde automatique…`)
        this.autosaveTimer = setTimeout(() => {
            this.autosaveTimer = undefined
            if (this.selectedPath !== scheduledPath) return
            void this.saveCurrent()
        }, delay)
    }

    private cancelAutosave() {
        if (this.autosaveTimer !== undefined) {
            clearTimeout(this.autosaveTimer)
            this.autosaveTimer = undefined
        }
    }

    private async flushAutosave() {
        this.cancelAutosave()
        if (this.dirty) await this.saveCurrent()
        return !this.dirty
    }

    private findFileUsers(targetPath: string) {
        const availablePaths = new Set(Object.keys(this.projectFiles))
        return Object.entries(this.projectFiles)
            .filter(([path]) => path !== targetPath)
            .filter(([importerPath, file]) => moduleSpecifiers(file.content).some(specifier => {
                return resolveModulePath(importerPath, specifier, availablePaths) === targetPath
            }))
            .map(([path]) => path)
            .sort((a, b) => a.localeCompare(b, "fr"))
    }

    private async deleteCurrent() {
        if (!this.selectedPath || this.busy) return
        const safePath = normalizeBotSourcePath(this.selectedPath)
        if (isGeneratedBotSourcePath(safePath)) {
            this.setStatus("Les bots intégrés ne peuvent pas être supprimés.", "error")
            return
        }
        const users = this.findFileUsers(safePath)
        if (users.length) {
            this.setStatus(
                `Suppression impossible : ${safePath} est utilisé par ${users.join(", ")}.`,
                "error"
            )
            return
        }
        this.cancelAutosave()
        const dirtyWarning = this.dirty ? " Les modifications non enregistrées seront également perdues." : ""
        if (!window.confirm(`Supprimer définitivement ${safePath} ?${dirtyWarning}`)) {
            if (this.dirty) this.scheduleAutosave()
            return
        }

        await this.withBusy(async () => {
            this.setStatus(`Suppression de ${safePath}…`)
            await deleteSource(safePath)
            delete this.projectFiles[safePath]
            this.selectedPath = undefined
            this.dirty = false
            await this.loadProject(undefined)
            this.setStatus(`${safePath} a été supprimé.`, "success")
        })
    }

    private async createEntry(kind: CreationKind) {
        if (this.busy) return
        const rawName = this.newNameInput.value.trim()
        try {
            const name = this.validEntryName(rawName)
            if (isGeneratedBotSourcePath(this.selectedDirectory)) {
                throw new Error(`Le répertoire ${GENERATED_BOTS_DIRECTORY} est réservé aux bots intégrés`)
            }
            if (this.dirty) await this.saveCurrent()
            if (this.dirty) return

            if (kind === "directory") {
                const path = normalizeBotSourcePath(`${this.selectedDirectory}/${name}`)
                await this.withBusy(async () => {
                    this.setStatus(`Création du dossier ${path}…`)
                    await createBotDirectory(path)
                    this.selectedDirectory = path
                    this.newNameInput.value = ""
                    await this.loadProject(this.selectedPath)
                    this.selectedDirectory = path
                    this.renderTree()
                })
                return
            }

            let fileName = name
            if (!/\.[a-z0-9]+$/i.test(fileName)) fileName += ".ts"
            if (kind === "bot" && !fileName.toLowerCase().endsWith(".ts")) {
                throw new Error("Un bot doit être un fichier TypeScript .ts")
            }
            if (kind === "utility" && this.selectedDirectory === "bots") {
                throw new Error("Sélectionnez ou créez un sous-répertoire de bots pour cet utilitaire")
            }
            const parent = kind === "bot" ? "bots" : this.selectedDirectory
            const path = normalizeBotSourcePath(`${parent}/${fileName}`)
            if (this.projectFiles[path]) throw new Error(`${path} existe déjà`)
            const source = kind === "bot" ? botTemplate() : utilityTemplate(fileName)

            await this.withBusy(async () => {
                this.setStatus(`Création de ${path}…`)
                await writeSource(path, source)
                this.newNameInput.value = ""
                await this.loadProject(path)
            })
        } catch (error) {
            this.setStatus(this.errorMessage(error), "error")
        }
    }

    private validEntryName(value: string) {
        if (!value) throw new Error("Saisissez un nom")
        if (value === "." || value === ".." || /[\\/:*?"<>|\0]/.test(value)) {
            throw new Error("Le nom ne doit contenir aucun caractère de chemin")
        }
        return value
    }

    private async returnToGame() {
        if (!await this.flushAutosave()) return
        this.destroy()
        await this.onBack()
    }

    private onKeydown(event: KeyboardEvent) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault()
            void this.saveCurrent()
        }
    }

    private async withBusy(action: () => Promise<void>) {
        if (this.busy) return
        this.busy = true
        this.updateControls()
        try {
            await action()
        } catch (error) {
            this.setStatus(this.errorMessage(error), "error")
        } finally {
            this.busy = false
            this.updateControls()
        }
    }

    private updateControls() {
        const generatedFile = Boolean(this.selectedPath && isGeneratedBotSourcePath(this.selectedPath))
        const generatedDirectory = isGeneratedBotSourcePath(this.selectedDirectory)
        this.saveButton.disabled = this.busy || generatedFile || !this.editor || !this.dirty
        this.saveButton.textContent = generatedFile ? "Lecture seule" : this.dirty ? "Enregistrer maintenant" : "Sauvegarde auto ✓"
        this.deleteButton.disabled = this.busy || generatedFile || !this.selectedPath
        this.backButton.disabled = this.busy
        this.refreshButton.disabled = this.busy
        this.root.querySelectorAll<HTMLButtonElement>("[data-create]").forEach(button => {
            button.disabled = this.busy || generatedDirectory
        })
        const dirtyElement = this.role("dirty")
        dirtyElement.textContent = this.dirty ? "● non enregistré" : ""
    }

    private setStatus(text: string, state: "" | "success" | "error" = "") {
        this.statusElement.textContent = text
        this.statusElement.dataset.state = state
    }

    private errorMessage(error: unknown) {
        return error instanceof Error ? error.message : String(error)
    }

    destroy() {
        this.cancelAutosave()
        window.removeEventListener("keydown", this.keydownHandler)
        this.editor?.dispose()
        this.editor = undefined
        if (this.previousBodyOverflow !== undefined) {
            document.body.style.overflow = this.previousBodyOverflow
            this.previousBodyOverflow = undefined
        }
    }
}

let currentBotsDev: BotsDev | undefined

export async function installBotsDev(
    container: HTMLElement = document.body,
    onBack: () => void | Promise<void>,
    options: BotsDevOptions = {}
) {
    currentBotsDev?.destroy()
    const botsDev = new BotsDev(onBack, options)
    container.replaceChildren(botsDev.createInterface())
    currentBotsDev = botsDev
    await botsDev.init()
    return botsDev
}
