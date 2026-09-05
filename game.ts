import {
    Drone,
    Energie,
    Element as GameElement,
    Usine,
    Vie,
    type Log as BotState,
    type Position
} from "./algofight-entity-model"
import { isGeneratedBotSourcePath, listBotsScript, readSource } from "./bots-script-tools"
import {
    GAME_LEVELS_SOURCE,
    GAME_POWER_LEVELS,
    gameBotSignature,
    gameProgressionLevelCount,
    generateGameLevels,
    levelConfig,
    readGameLevels,
    readProgrammingBotProgress,
    readSelectedProgrammingBot,
    runBotBatch,
    writeProgrammingBotProgress,
    type BatchFailure,
    type BatchMatchCompleted,
    type GameLevelsData
} from "./game-batch"
import { GestionMonde } from "./gestion-algofight-entity-model"

const PLAYER_A_COLOR = "#18854f"
const PLAYER_B_COLOR = "#2864c7"
const NEUTRAL_COLOR = "#687386"
function escapeHtml(value: unknown) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;")
}

function botStateFormHtml(state: BotState | undefined) {
    const entries = Object.entries(state?.values ?? {})
    if (entries.length === 0) {
        return '<div class="bot-state-empty">En attente d’informations…</div>'
    }
    return entries
        .map(([key, value]) => `
            <label class="bot-state-field">
                <span title="${escapeHtml(key)}">${escapeHtml(key)}</span>
                <output>${escapeHtml(value)}</output>
            </label>
        `)
        .join("")
}

type ReplayActionType = "attack-drone" | "attack-factory" | "collect-energy" | "collect-life" | "repair-factory" | "capture-factory"

interface ReplayAction {
    type: ReplayActionType
    target: Drone | Usine | Energie | Vie
}

interface ReplayRememberedDrone {
    ref: Drone
    position: Position
    angle: number
    isA: boolean
}

interface ReplayParticle {
    angle: number
    speed: number
    size: number
    delay: number
    color: string
    kind: "spark" | "fragment" | "smoke"
}

interface ReplayExplosion {
    position: Position
    startedAt: number
    duration: number
    particles: ReplayParticle[]
}

interface ReplayLaunch {
    position: Position
    color: string
    startedAt: number
    duration: number
}

function scriptName(path: string) {
    const parts = path.split("/").filter(Boolean)
    return (parts[parts.length - 1] ?? path).replace(/\.ts$/i, "")
}

function workerUrl(path: string, player: "A" | "B") {
    const javascriptPath = path.replace(/\.ts$/i, ".js")
    return `${javascriptPath}${javascriptPath.includes("?") ? "&" : "?"}player=${player}&replay=${Date.now()}`
}

function loadImage(url: string) {
    const image = new Image()
    image.src = url
    return image
}

export interface ProgrammingGameOptions {
    selectedBot?: string
    /** Relance automatiquement le batch à partir de ce niveau linéaire. */
    autoRunFromLevel?: number
    /** Conserve en mémoire les mondes exacts pendant un aller-retour dans l’éditeur. */
    initialLevels?: GameLevelsData
    /** Affiche le choix de reprise après l'enregistrement d'un bot modifié. */
    editedBotResumeLevel?: number
}

export class AlgoFightProgrammingGame {
    private root!: HTMLDivElement
    private botSelect!: HTMLSelectElement
    private launchButton!: HTMLButtonElement
    private rebuildButton!: HTMLButtonElement
    private cancelButton!: HTMLButtonElement
    private editBotButton!: HTMLButtonElement
    private statusElement!: HTMLElement
    private detailElement!: HTMLElement
    private levelElement!: HTMLElement
    private progressElement!: HTMLElement
    private failureElement!: HTMLElement
    private visualizationElement!: HTMLElement
    private canvas!: HTMLCanvasElement
    private ctx!: CanvasRenderingContext2D
    private replayStatusElement!: HTMLElement
    private replaySpeedInput!: HTMLInputElement
    private replayBotNameAElement!: HTMLElement
    private replayBotNameBElement!: HTMLElement
    private replayBotStateAElement!: HTMLElement
    private replayBotStateBElement!: HTMLElement
    private replayPlayerStatsAElement!: HTMLElement
    private replayPlayerStatsBElement!: HTMLElement
    private replayPauseButton!: HTMLButtonElement
    private replayContinueButton!: HTMLButtonElement
    private replayZoomOutButton!: HTMLButtonElement
    private replayZoomResetButton!: HTMLButtonElement
    private replayZoomInButton!: HTMLButtonElement
    private replayInspectorElement!: HTMLElement
    private replayGame?: GestionMonde
    private replayWorkerA?: Worker
    private replayWorkerB?: Worker
    private replayRequestId?: number
    private replayStepInterval?: ReturnType<typeof setInterval>
    private replayStepInFlight = false
    private replayStepError?: string
    private replayLastFrame = 0
    private replayVisualTime = 0
    private replayAccumulator = 0
    private replayPaused = false
    private replayHovered?: GameElement
    private replayZoom = 1
    private replayCamera = { x: 0, y: 0 }
    private replayView = { scale: 1, offsetX: 0, offsetY: 0 }
    private replayPan?: {
        id: number | string
        startX: number
        startY: number
        lastX: number
        lastY: number
        dragging: boolean
    }
    private replayDroneMemory = new Map<string, ReplayRememberedDrone>()
    private replayFactoryOwners = new Map<string, string | undefined>()
    private replayCooldowns = new Map<string, number>()
    private replayActions = new Map<string, ReplayAction>()
    private replayPendingDestroyed = new Map<string, ReplayRememberedDrone>()
    private replayExplosions: ReplayExplosion[] = []
    private replayLaunches: ReplayLaunch[] = []
    private abortController?: AbortController
    private allBots: string[] = []
    private userBots: string[] = []
    private levelBots: string[] = []
    private levels?: GameLevelsData
    private failure?: BatchFailure
    private busy = false
    private currentProgressionLevelIndex = 0
    private progressRestoreRevision = 0
    private progressSaveQueue: Promise<void> = Promise.resolve()
    private destroyed = false
    private readonly options: ProgrammingGameOptions
    private images = {
        droneA: loadImage(new URL("./assets/drones/16bit/idle.png", import.meta.url).href),
        droneB: loadImage(new URL("./assets/drones/16bit/attack.png", import.meta.url).href),
        factory: loadImage(new URL("./assets/factories/16bit/factory-idle.png", import.meta.url).href),
        factoryBuilding: loadImage(new URL("./assets/factories/16bit/factory-building.png", import.meta.url).href),
        energy: loadImage(new URL("./assets/resources/16bit/energy.png", import.meta.url).href),
        life: loadImage(new URL("./assets/resources/16bit/life.png", import.meta.url).href)
    }

    constructor(options: ProgrammingGameOptions = {}) {
        this.options = options
    }

    createInterface() {
        this.root = document.createElement("div")
        this.root.className = "algofight-programming"
        this.root.innerHTML = `
            <style>
                .algofight-programming {
                    --bg: #e2e5e9;
                    --surface: #f7f8fa;
                    --border: #aeb6c2;
                    --text: #182234;
                    --muted: #586679;
                    min-height: 100vh;
                    padding: 24px;
                    box-sizing: border-box;
                    color: var(--text);
                    background: var(--bg);
                    font: 17px/1.45 ui-sans-serif, system-ui, Segoe UI, sans-serif;
                }
                .algofight-programming * { box-sizing: border-box; }
                .program-shell { width: min(1120px, 100%); margin: 0 auto; }
                .program-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
                .program-title { margin: 0; font-size: clamp(28px, 4vw, 46px); line-height: 1; letter-spacing: -.04em; }
                .program-subtitle { margin: 8px 0 0; color: var(--muted); font-size: 18px; }
                .program-card { padding: 22px; border: 2px solid var(--border); border-radius: 14px; background: var(--surface); box-shadow: 5px 5px 0 #c3c9d1; }
                .program-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .7fr); gap: 18px; }
                .program-field { display: grid; gap: 7px; font-weight: 900; }
                .program-select, .program-range { width: 100%; font: inherit; touch-action: manipulation; }
                .program-select { padding: 11px 12px; border: 2px solid var(--border); border-radius: 9px; color: var(--text); background: #fff; }
                .program-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
                .program-button { min-height: 46px; padding: 11px 16px; border: 2px solid #6f7d91; border-radius: 9px; color: var(--text); background: #fff; font-family: inherit; font-size: 16px; font-weight: 900; line-height: 1.2; cursor: pointer; touch-action: manipulation; }
                .program-button:hover { transform: translateY(-1px); }
                .program-button.primary { color: #fff; border-color: #3147c9; background: #4358dc; }
                .program-button.danger { color: #fff; border-color: #a3253c; background: #c93650; }
                .program-button:disabled { cursor: not-allowed; opacity: .5; transform: none; }
                .program-status { min-height: 55px; padding: 12px; border-radius: 9px; color: var(--muted); background: #e8ebef; font-weight: 800; }
                .program-detail { margin-top: 10px; color: var(--muted); }
                .program-level {
                    display: grid;
                    gap: 2px;
                    margin-bottom: 10px;
                    padding: 11px 13px;
                    border: 2px solid #8794a7;
                    border-left: 7px solid #4358dc;
                    border-radius: 9px;
                    background: #fff;
                }
                .program-level span { color: var(--muted); font-size: 13px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
                .program-level strong { color: #263ab9; font-size: 23px; }
                .program-level small { color: var(--muted); font-size: 15px; font-weight: 800; }
                .program-progress { height: 18px; margin-top: 15px; overflow: hidden; border: 2px solid #9ca7b6; border-radius: 4px; background: #d4d9df; }
                .program-progress > div { width: 0; height: 100%; background: #4358dc; transition: width .12s linear; }
                .program-note { padding: 13px; border-left: 5px solid #4358dc; background: #eceefe; }
                .program-failure { margin-top: 18px; padding: 17px; border: 2px solid #c13a50; border-radius: 11px; background: #fff0f2; }
                .program-failure.success { border-color: #268358; background: #edfff5; }
                .program-failure[hidden], .program-visualization[hidden] { display: none; }
                .program-failure h2 { margin: 0 0 8px; color: #9d263b; font-size: 24px; }
                .program-failure.success h2 { color: #176841; }
                .program-edit-choice { position: fixed; inset: 0; z-index: 2147483100; display: grid; place-items: center; padding: 24px; background: rgba(36, 43, 55, .58); }
                .program-edit-choice-card { width: min(620px, 100%); padding: 26px; border: 2px solid #9aa6b8; border-radius: 15px; background: #f4f5f7; box-shadow: 0 22px 60px rgba(25, 31, 42, .3); }
                .program-edit-choice-card h2 { margin: 0 0 10px; font-size: 28px; }
                .program-edit-choice-card p { margin: 0 0 20px; font-size: 19px; line-height: 1.5; }
                .program-edit-choice-actions { display: flex; flex-wrap: wrap; gap: 12px; }
                .program-visualization { position: fixed; inset: 0; z-index: 2147483000; display: grid; grid-template-rows: auto minmax(0, 1fr); background: #d9dde2; }
                .replay-hud { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 16px; border-bottom: 2px solid #aeb6c2; background: #f4f5f7; }
                .replay-hud strong { font-size: 18px; }
                .replay-hud .program-range { width: 180px; }
                .replay-status { flex: 1 1 280px; color: var(--muted); font-weight: 900; }
                .replay-battle {
                    display: grid;
                    grid-template-columns: minmax(190px, 260px) minmax(0, 1fr) minmax(190px, 260px);
                    gap: 10px;
                    min-height: 0;
                    padding: 10px;
                }
                .replay-arena { position: relative; min-width: 0; min-height: 0; overflow: hidden; border-radius: 4px; }
                .replay-canvas { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; image-rendering: pixelated; background: #d5d8dd; cursor: grab; touch-action: none; user-select: none; }
                .replay-canvas[data-panning=true] { cursor: grabbing; }
                .replay-inspector {
                    position: absolute;
                    top: 14px;
                    left: 14px;
                    z-index: 8;
                    width: min(370px, calc(100% - 28px));
                    max-height: calc(100% - 28px);
                    padding: 13px;
                    overflow-y: auto;
                    border: 2px solid #687386;
                    border-left-width: 7px;
                    border-radius: 11px;
                    color: var(--text);
                    background: rgba(250, 251, 252, .97);
                    box-shadow: 6px 7px 0 rgba(35, 47, 65, .22);
                    pointer-events: none;
                }
                .replay-inspector[hidden] { display: none; }
                .replay-inspector[data-owner=A] { border-left-color: ${PLAYER_A_COLOR}; }
                .replay-inspector[data-owner=B] { border-left-color: ${PLAYER_B_COLOR}; }
                .replay-inspector-title { display: block; margin-bottom: 10px; color: #26334a; font-size: 19px; line-height: 1.2; overflow-wrap: anywhere; }
                .replay-inspector-grid { display: grid; gap: 5px; }
                .replay-inspector-row { display: grid; grid-template-columns: minmax(105px, .8fr) minmax(0, 1.2fr); gap: 9px; padding: 6px 7px; border: 1px solid #c8ced7; border-radius: 6px; background: #fff; }
                .replay-inspector-row span { color: var(--muted); font-size: 13px; font-weight: 900; }
                .replay-inspector-row b { min-width: 0; font: 900 13px/1.3 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; text-align: right; }
                .replay-bot-state {
                    min-width: 0;
                    padding: 14px;
                    overflow-y: auto;
                    border: 2px solid #aeb6c2;
                    border-radius: 10px;
                    background: #f7f8fa;
                    box-shadow: 3px 3px 0 #c3c9d1;
                }
                .replay-bot-state.a { border-left: 7px solid ${PLAYER_A_COLOR}; }
                .replay-bot-state.b { border-right: 7px solid ${PLAYER_B_COLOR}; text-align: right; }
                .replay-bot-state h2 { margin: 0; font-size: 20px; }
                .replay-bot-state > small { display: block; margin: 2px 0 12px; overflow: hidden; color: var(--muted); font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
                .replay-player-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 12px; }
                .replay-player-stat { padding: 9px 7px; border: 1px solid #c5cbd4; border-radius: 8px; background: #fff; text-align: center; }
                .replay-player-stat b { display: block; color: var(--text); font: 900 25px/1 ui-monospace, Consolas, monospace; }
                .replay-player-stat span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; }
                .bot-state-fields { display: grid; gap: 7px; }
                .bot-state-field {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(58px, auto);
                    align-items: center;
                    gap: 8px;
                    padding: 7px 8px;
                    border: 1px solid #c5cbd4;
                    border-radius: 7px;
                    background: #fff;
                }
                .bot-state-field span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 14px; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
                .bot-state-field output { color: var(--text); font: 900 15px/1.25 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; text-align: right; }
                .bot-state-empty { padding: 10px; border: 1px dashed #aeb6c2; border-radius: 7px; color: var(--muted); font-size: 14px; font-weight: 800; text-align: center; }
                @media (max-width: 760px) {
                    .algofight-programming { padding: 14px; font-size: 16px; }
                    .program-grid { grid-template-columns: 1fr; }
                    .program-header { align-items: flex-start; flex-direction: column; }
                    .replay-battle { grid-template-columns: 150px minmax(0, 1fr) 150px; gap: 5px; padding: 5px; }
                    .replay-bot-state { padding: 8px; }
                    .replay-player-stats { grid-template-columns: 1fr; }
                    .bot-state-field { grid-template-columns: 1fr; gap: 2px; }
                    .bot-state-field output { text-align: inherit; }
                }
            </style>
            <main class="program-shell">
                <header class="program-header">
                    <div>
                        <h1 class="program-title">ALGOFIGHT · PROGRAMMATION</h1>
                        <p class="program-subtitle">Choisissez votre bot : il doit gagner tous les niveaux, du premier au dernier.</p>
                    </div>
                    <button class="program-button" data-role="manual">Mode manuel</button>
                </header>
                <section class="program-card program-grid">
                    <div>
                        <label class="program-field">Votre bot
                            <select class="program-select" data-role="bot" disabled><option>Chargement…</option></select>
                        </label>
                        <div class="program-actions">
                            <button class="program-button primary" data-role="launch" disabled>Jouer le niveau 1</button>
                            <button class="program-button danger" data-role="cancel" disabled>Arrêter</button>
                            <button class="program-button" data-role="bots-dev" disabled>Modifier ce bot</button>
                            <button class="program-button" data-role="rebuild" disabled>Recalculer les niveaux</button>
                        </div>
                    </div>
                    <div>
                        <div class="program-level" data-role="level">
                            <span>Progression</span><strong>Niveau —</strong><small>Préparation des niveaux…</small>
                        </div>
                        <div class="program-status" data-role="status">Chargement des bots et des niveaux…</div>
                        <div class="program-detail" data-role="detail"></div>
                        <div class="program-progress"><div data-role="progress"></div></div>
                    </div>
                </section>
                <p class="program-note">La progression est enregistrée automatiquement pour chaque bot. Le niveau affiché est joué, puis les suivants s’enchaînent jusqu’à la première défaite. Après modification du bot, vous choisissez de reprendre au niveau atteint ou de tout recommencer.</p>
                <section class="program-failure" data-role="failure" hidden></section>
            </main>
            <section class="program-visualization" data-role="visualization" hidden>
                <div class="replay-hud">
                    <strong>Visualisation du niveau</strong>
                    <span class="replay-status" data-role="replay-status"></span>
                    <label>Vitesse <input class="program-range" data-role="replay-speed" type="range" min="30" max="900" step="30" value="300"></label>
                    <button class="program-button" data-role="replay-zoom-out" title="Dézoomer">−</button>
                    <button class="program-button" data-role="replay-zoom-reset" title="Réinitialiser le zoom">Zoom 100 %</button>
                    <button class="program-button" data-role="replay-zoom-in" title="Zoomer">+</button>
                    <button class="program-button primary" data-role="replay-pause" aria-pressed="false">Pause</button>
                    <button class="program-button primary" data-role="replay-continue" hidden>Jouer le niveau suivant</button>
                    <button class="program-button primary" data-role="replay-evaluate">Rejouer le niveau</button>
                    <button class="program-button" data-role="replay-restart">Relancer l’animation</button>
                    <button class="program-button" data-role="replay-close">Retour</button>
                </div>
                <div class="replay-battle">
                    <aside class="replay-bot-state a">
                        <h2>Joueur A</h2>
                        <small data-role="replay-bot-name-a">Bot sélectionné</small>
                        <div class="replay-player-stats" data-role="replay-player-stats-a">
                            <div class="replay-player-stat"><b>0</b><span>Usines</span></div>
                            <div class="replay-player-stat"><b>0</b><span>Drones</span></div>
                        </div>
                        <div class="bot-state-fields" data-role="replay-bot-state-a"><div class="bot-state-empty">En attente d’informations…</div></div>
                    </aside>
                    <div class="replay-arena">
                        <canvas class="replay-canvas" data-role="canvas" aria-label="Zone de combat automatisé" title="En pause, cliquez pour les détails · molette : zoom · glisser : déplacer la carte"></canvas>
                        <aside class="replay-inspector" data-role="replay-inspector" aria-live="polite" hidden></aside>
                    </div>
                    <aside class="replay-bot-state b">
                        <h2>Joueur B</h2>
                        <small data-role="replay-bot-name-b">Bot adverse</small>
                        <div class="replay-player-stats" data-role="replay-player-stats-b">
                            <div class="replay-player-stat"><b>0</b><span>Usines</span></div>
                            <div class="replay-player-stat"><b>0</b><span>Drones</span></div>
                        </div>
                        <div class="bot-state-fields" data-role="replay-bot-state-b"><div class="bot-state-empty">En attente d’informations…</div></div>
                    </aside>
                </div>
            </section>
        `
        return this.root
    }

    init() {
        this.botSelect = this.role<HTMLSelectElement>("bot")
        this.launchButton = this.role<HTMLButtonElement>("launch")
        this.rebuildButton = this.role<HTMLButtonElement>("rebuild")
        this.cancelButton = this.role<HTMLButtonElement>("cancel")
        this.editBotButton = this.role<HTMLButtonElement>("bots-dev")
        this.statusElement = this.role<HTMLElement>("status")
        this.detailElement = this.role<HTMLElement>("detail")
        this.levelElement = this.role<HTMLElement>("level")
        this.progressElement = this.role<HTMLElement>("progress")
        this.failureElement = this.role<HTMLElement>("failure")
        this.visualizationElement = this.role<HTMLElement>("visualization")
        this.canvas = this.role<HTMLCanvasElement>("canvas")
        this.ctx = this.canvas.getContext("2d")!
        this.replayStatusElement = this.role<HTMLElement>("replay-status")
        this.replaySpeedInput = this.role<HTMLInputElement>("replay-speed")
        this.replayBotNameAElement = this.role<HTMLElement>("replay-bot-name-a")
        this.replayBotNameBElement = this.role<HTMLElement>("replay-bot-name-b")
        this.replayBotStateAElement = this.role<HTMLElement>("replay-bot-state-a")
        this.replayBotStateBElement = this.role<HTMLElement>("replay-bot-state-b")
        this.replayPlayerStatsAElement = this.role<HTMLElement>("replay-player-stats-a")
        this.replayPlayerStatsBElement = this.role<HTMLElement>("replay-player-stats-b")
        this.replayPauseButton = this.role<HTMLButtonElement>("replay-pause")
        this.replayContinueButton = this.role<HTMLButtonElement>("replay-continue")
        this.replayZoomOutButton = this.role<HTMLButtonElement>("replay-zoom-out")
        this.replayZoomResetButton = this.role<HTMLButtonElement>("replay-zoom-reset")
        this.replayZoomInButton = this.role<HTMLButtonElement>("replay-zoom-in")
        this.replayInspectorElement = this.role<HTMLElement>("replay-inspector")

        this.launchButton.addEventListener("click", () => void this.runProgressionLevel())
        this.cancelButton.addEventListener("click", () => this.abortController?.abort())
        this.rebuildButton.addEventListener("click", () => void this.prepareLevels(true))
        this.role<HTMLButtonElement>("manual").addEventListener("click", () => void this.openManualGame())
        this.editBotButton.addEventListener("click", () => void this.openSelectedBotEditor())
        this.botSelect.addEventListener("change", () => {
            this.updateSelectedBotControl()
            void this.restoreSavedProgrammingProgress()
        })
        this.role<HTMLButtonElement>("replay-evaluate").addEventListener("click", () => {
            const levelIndex = this.failure?.levelIndex ?? this.currentProgressionLevelIndex
            this.closeReplay()
            void this.runProgressionLevel(levelIndex)
        })
        this.role<HTMLButtonElement>("replay-restart").addEventListener("click", () => this.startFailureReplay())
        this.role<HTMLButtonElement>("replay-close").addEventListener("click", () => this.closeReplay())
        this.replayContinueButton.addEventListener("click", () => this.continueAfterReplayVictory())
        this.replayPauseButton.addEventListener("click", () => this.toggleReplayPause())
        this.replaySpeedInput.addEventListener("input", () => this.startReplayStepInterval())
        this.replayZoomOutButton.addEventListener("click", () => this.changeReplayZoom(1 / 1.25))
        this.replayZoomResetButton.addEventListener("click", () => this.resetReplayZoom())
        this.replayZoomInButton.addEventListener("click", () => this.changeReplayZoom(1.25))
        this.installReplayCanvasControls()
        window.addEventListener("resize", this.handleResize)
        void this.load()
    }

    private role<T extends globalThis.Element>(name: string) {
        const element = this.root.querySelector(`[data-role="${name}"]`)
        if (!element) throw new Error(`Élément '${name}' introuvable`)
        return element as T
    }

    private async load() {
        try {
            this.allBots = (await listBotsScript()).filter(path => /\.ts$/i.test(path))
            if (this.destroyed) return
            this.userBots = this.allBots.filter(path => !isGeneratedBotSourcePath(path))
            const generatedBots = this.allBots.filter(isGeneratedBotSourcePath)
            this.levelBots = generatedBots.length > 0 ? generatedBots : this.allBots
            this.botSelect.replaceChildren()
            for (const script of this.userBots) {
                this.botSelect.add(new Option(`${scriptName(script)} — ${script}`, script))
            }
            if (this.options.selectedBot && this.userBots.includes(this.options.selectedBot)) {
                this.botSelect.value = this.options.selectedBot
            }
            if (this.userBots.length === 0) {
                this.botSelect.add(new Option("Créez d’abord un bot utilisateur", ""))
                this.setStatus("Aucun bot utilisateur à la racine de /bots.", true)
            }
            this.botSelect.disabled = this.userBots.length === 0
            this.updateSelectedBotControl()
            if (this.options.initialLevels) {
                this.restoreCurrentLevels(
                    this.options.initialLevels,
                    this.options.editedBotResumeLevel ?? this.options.autoRunFromLevel ?? 0
                )
            } else {
                await this.prepareLevels(false)
                if (!this.options.selectedBot) await this.restoreLastSelectedProgrammingBot()
                await this.restoreSavedProgrammingProgress()
            }
            if (
                this.options.editedBotResumeLevel !== undefined
                && !this.destroyed
                && this.levels
                && this.botSelect.value
            ) {
                this.showBotEditChoice(this.options.editedBotResumeLevel)
                return
            }
            if (
                this.options.autoRunFromLevel !== undefined
                && !this.destroyed
                && this.levels
                && this.botSelect.value
            ) {
                await this.runProgressionLevel(this.options.autoRunFromLevel)
            }
        } catch (error) {
            this.setStatus(`Initialisation impossible : ${this.errorMessage(error)}`, true)
        }
    }

    private restoreCurrentLevels(levels: GameLevelsData, requestedLevelIndex: number) {
        this.levels = levels
        const botScript = this.botSelect.value
        const levelCount = this.progressionLevelCount(botScript)
        const levelIndex = Math.max(0, Math.min(
            Math.max(0, levelCount - 1),
            Math.trunc(requestedLevelIndex)
        ))
        const level = this.progressionLevelAt(botScript, levelIndex)
        this.currentProgressionLevelIndex = levelIndex
        this.progressElement.style.width = `${levelIndex / Math.max(1, levelCount) * 100}%`
        this.showLevelProgress(
            levelIndex,
            levelCount,
            level?.powerCount ?? 0,
            levelIndex > 0 ? "Niveau courant restauré" : "Prêt à jouer"
        )
        this.detailElement.textContent = level
            ? `${levelCount} niveaux · reprise contre ${scriptName(level.opponentScript)} · ${levels.levels.length} paliers × ${this.levelBots.length} bots`
            : `${levelCount} niveaux de combat · ${levels.levels.length} paliers × ${this.levelBots.length} bots`
        this.setStatus(levelIndex > 0
            ? `Le niveau ${levelIndex + 1}/${levelCount} a été conservé pendant la modification du bot.`
            : "Niveaux conservés. Le bot peut être relancé."
        )
        this.setBusy(false)
    }

    private async restoreSavedProgrammingProgress(
        botScript = this.botSelect.value,
        revision = this.progressRestoreRevision
    ) {
        const levels = this.levels
        if (!levels || !botScript) return
        try {
            const progress = await readProgrammingBotProgress(botScript, levels.botSignature)
            if (
                this.destroyed
                || revision !== this.progressRestoreRevision
                || botScript !== this.botSelect.value
                || levels !== this.levels
            ) return
            if (!progress) {
                this.updateProgressionControl()
                return
            }

            const levelCount = this.progressionLevelCount(botScript)
            const levelIndex = Math.max(0, Math.min(
                Math.max(0, levelCount - 1),
                Math.trunc(progress.levelIndex)
            ))
            const level = this.progressionLevelAt(botScript, levelIndex)
            this.currentProgressionLevelIndex = levelIndex
            this.progressElement.style.width = progress.completed
                ? "100%"
                : `${levelIndex / Math.max(1, levelCount) * 100}%`
            this.showLevelProgress(
                levelIndex,
                levelCount,
                level?.powerCount ?? 0,
                progress.completed ? "Progression terminée" : "Progression restaurée"
            )
            this.detailElement.textContent = level
                ? `${levelCount} niveaux · ${progress.completed ? "dernier combat" : "reprise"} contre ${scriptName(level.opponentScript)} · ${levels.width} × ${levels.height}`
                : `${levelCount} niveaux de combat · ${levels.width} × ${levels.height}`
            this.setStatus(progress.completed
                ? `${scriptName(botScript)} a déjà terminé les ${levelCount} niveaux. Vous pouvez rejouer le dernier niveau.`
                : `Progression chargée : ${scriptName(botScript)} reprendra au niveau ${levelIndex + 1}/${levelCount}.`
            )
            this.updateProgressionControl()
        } catch {
            // L'absence d'un ancien fichier de progression est un démarrage normal.
        }
    }

    private async restoreLastSelectedProgrammingBot() {
        const levels = this.levels
        if (!levels) return
        try {
            const botScript = await readSelectedProgrammingBot(levels.botSignature)
            if (
                this.destroyed
                || !botScript
                || !this.userBots.includes(botScript)
                || this.botSelect.value === botScript
            ) return
            this.botSelect.value = botScript
            this.updateSelectedBotControl()
        } catch {
            // Un ancien fichier sans bot sélectionné conserve le premier choix de la liste.
        }
    }

    private queueProgrammingProgress(
        botScript: string,
        levelIndex: number,
        completed: boolean
    ) {
        const botSignature = this.levels?.botSignature
        if (!botSignature || !botScript) return this.progressSaveQueue
        this.progressSaveQueue = this.progressSaveQueue
            .catch(() => undefined)
            .then(() => writeProgrammingBotProgress(botScript, botSignature, {
                levelIndex,
                completed
            }))
            .catch(error => {
                console.error("Impossible d’enregistrer la progression AlgoFight", error)
            })
        return this.progressSaveQueue
    }

    private async prepareLevels(force: boolean) {
        if (this.destroyed) return
        if (this.levelBots.length === 0) {
            this.setStatus("Aucun bot disponible pour construire les niveaux.", true)
            return
        }
        this.setBusy(true)
        this.failureElement.hidden = true
        const controller = new AbortController()
        this.abortController = controller
        try {
            const signature = await gameBotSignature(this.levelBots)
            let levels: GameLevelsData | undefined
            if (!force) {
                try {
                    const saved = await readGameLevels()
                    const validPowers = saved.levels.length === GAME_POWER_LEVELS.length
                        && saved.levels.every((level, index) => level.powerCount === GAME_POWER_LEVELS[index])
                    if (saved.botSignature === signature && validPowers) levels = saved
                } catch {
                    levels = undefined
                }
            }
            if (!levels) {
                this.setStatus(`Première utilisation : Battle royale et génération de ${GAME_LEVELS_SOURCE}…`)
                let lastUi = 0
                let displayedLevelIndex = -1
                levels = await generateGameLevels(this.levelBots, {
                    signal: controller.signal,
                    onProgress: progress => {
                        const now = performance.now()
                        if (
                            now - lastUi < 80
                            && progress.phase === "match"
                            && progress.levelIndex === displayedLevelIndex
                        ) return
                        lastUi = now
                        displayedLevelIndex = progress.levelIndex
                        const percent = progress.matchCount === 0
                            ? (progress.levelIndex + 1) / progress.levelCount * 100
                            : progress.matchIndex / progress.matchCount * 100
                        this.progressElement.style.width = `${percent}%`
                        this.showLevelPreparation(
                            progress.levelIndex,
                            progress.levelCount,
                            progress.powerCount,
                            progress.phase === "match"
                                ? `Classement · combat ${progress.matchIndex + 1}/${progress.matchCount}`
                                : progress.phase === "save" ? "Enregistrement" : "Création du monde"
                        )
                        this.detailElement.textContent = progress.phase === "match"
                            ? `Palier ${progress.levelIndex + 1}/${progress.levelCount} · ${progress.powerCount} pouvoir${progress.powerCount > 1 ? "s" : ""} · combat ${progress.matchIndex + 1}/${progress.matchCount} · ${scriptName(progress.scriptA!)} contre ${scriptName(progress.scriptB!)} · tick ${progress.tick ?? 0}`
                            : progress.phase === "save" ? "Enregistrement des niveaux…" : `Création du palier à ${progress.powerCount} pouvoir${progress.powerCount > 1 ? "s" : ""}…`
                    }
                })
            }
            if (controller.signal.aborted) return
            this.levels = levels
            this.currentProgressionLevelIndex = 0
            this.progressElement.style.width = "0%"
            const firstLevel = levels.levels[0]
            const progressionLevelCount = this.progressionLevelCount()
            this.showLevelProgress(0, progressionLevelCount, firstLevel?.powerCount ?? 0, "Prêt à jouer")
            this.detailElement.textContent = `${progressionLevelCount} niveaux de combat · ${levels.levels.length} paliers de pouvoir × ${this.levelBots.length} bots · ${levels.width} × ${levels.height}`
            this.setStatus("Niveaux prêts. Choisissez votre bot puis lancez le batch.")
        } catch (error) {
            if (controller.signal.aborted) this.setStatus("Calcul des niveaux arrêté.", true)
            else this.setStatus(`Impossible de préparer les niveaux : ${this.errorMessage(error)}`, true)
        } finally {
            if (this.abortController === controller) this.abortController = undefined
            this.setBusy(false)
        }
    }

    private async runSelectedBot(startLevelIndex = 0, levelIndexes?: readonly number[]) {
        if (this.destroyed) return
        const botScript = this.botSelect.value
        if (!botScript || !this.levels) {
            this.setStatus("Sélectionnez un bot et attendez le chargement des niveaux.", true)
            return
        }
        const totalLevelCount = this.progressionLevelCount(botScript)
        const selectedLevelIndexes = levelIndexes
            ? [...new Set(levelIndexes
                .map(index => Math.trunc(index))
                .filter(index => index >= 0 && index < totalLevelCount))]
                .sort((a, b) => a - b)
            : undefined
        if (selectedLevelIndexes && selectedLevelIndexes.length === 0) {
            this.setStatus("Cochez au moins un niveau à exécuter.", true)
            return
        }
        const singleLevelIndex = selectedLevelIndexes?.length === 1
            ? selectedLevelIndexes[0]
            : undefined
        if (singleLevelIndex !== undefined) this.currentProgressionLevelIndex = singleLevelIndex
        this.setBusy(true)
        this.failure = undefined
        this.failureElement.hidden = true
        this.failureElement.classList.remove("success")
        const controller = new AbortController()
        this.abortController = controller
        let lastUi = 0
        let displayedLevelIndex = -1
        let completedMatch: BatchMatchCompleted | undefined
        try {
            const progressionLevelCount = totalLevelCount
            const safeStartLevelIndex = Math.max(0, Math.min(
                Math.max(0, progressionLevelCount - 1),
                Math.trunc(startLevelIndex)
            ))
            const executionLevelIndexes = selectedLevelIndexes
                ? selectedLevelIndexes.filter(index => index >= safeStartLevelIndex)
                : Array.from(
                    { length: Math.max(0, progressionLevelCount - safeStartLevelIndex) },
                    (_, index) => safeStartLevelIndex + index
                )
            const startingLevelIndex = executionLevelIndexes[0] ?? safeStartLevelIndex
            const startingLevel = this.progressionLevelAt(botScript, startingLevelIndex)
            this.setStatus(singleLevelIndex !== undefined
                ? `${scriptName(botScript)} joue le niveau ${singleLevelIndex + 1}/${progressionLevelCount}…`
                : selectedLevelIndexes
                    ? `${scriptName(botScript)} exécute ${executionLevelIndexes.length} niveau${executionLevelIndexes.length > 1 ? "x" : ""} sélectionné${executionLevelIndexes.length > 1 ? "s" : ""}, jusqu’à la première défaite…`
                    : safeStartLevelIndex > 0
                        ? `${scriptName(botScript)} réévalue d’abord le niveau ${safeStartLevelIndex + 1}/${progressionLevelCount}, puis continuera jusqu’à la première défaite…`
                        : `${scriptName(botScript)} exécute les ${progressionLevelCount} niveaux depuis le niveau 1, jusqu’à la première défaite…`
            )
            this.progressElement.style.width = selectedLevelIndexes
                ? "0%"
                : `${safeStartLevelIndex / Math.max(1, progressionLevelCount) * 100}%`
            this.showLevelProgress(
                startingLevelIndex,
                progressionLevelCount,
                startingLevel?.powerCount ?? 0,
                singleLevelIndex !== undefined
                    ? "Combat en cours"
                    : selectedLevelIndexes
                        ? `Sélection de ${executionLevelIndexes.length} niveau${executionLevelIndexes.length > 1 ? "x" : ""}`
                        : safeStartLevelIndex > 0 ? "Réévaluation du niveau perdu" : "Démarrage du batch"
            )
            const failure = await runBotBatch(botScript, {
                levels: this.levels,
                signal: controller.signal,
                startLevelIndex: safeStartLevelIndex,
                levelIndexes: selectedLevelIndexes,
                onMatchComplete: match => {
                    completedMatch = match
                    const won = match.outcome.winner === "A"
                    const completed = won && match.levelIndex + 1 >= match.levelCount
                    const reachedLevelIndex = won && !completed
                        ? match.levelIndex + 1
                        : match.levelIndex
                    this.currentProgressionLevelIndex = reachedLevelIndex
                    return this.queueProgrammingProgress(botScript, reachedLevelIndex, completed)
                },
                onProgress: progress => {
                    const now = performance.now()
                    if (now - lastUi < 70 && progress.levelIndex === displayedLevelIndex) return
                    lastUi = now
                    displayedLevelIndex = progress.levelIndex
                    const executionIndex = Math.max(0, executionLevelIndexes.indexOf(progress.levelIndex))
                    this.progressElement.style.width = `${Math.min(99, selectedLevelIndexes
                        ? (executionIndex + .5) / Math.max(1, executionLevelIndexes.length) * 100
                        : (progress.levelIndex + .5) / Math.max(1, progress.levelCount) * 100
                    )}%`
                    this.showLevelProgress(
                        progress.levelIndex,
                        progress.levelCount,
                        progress.powerCount,
                        `Adversaire ${progress.opponentIndex + 1}/${Math.max(1, progress.opponentCount)} · ${scriptName(progress.opponentScript)}`
                    )
                    this.detailElement.textContent = `${selectedLevelIndexes && singleLevelIndex === undefined ? `Sélection ${executionIndex + 1}/${executionLevelIndexes.length} · ` : ""}Niveau ${progress.levelIndex + 1}/${progress.levelCount} · ${progress.powerCount} pouvoir${progress.powerCount > 1 ? "s" : ""} · contre ${scriptName(progress.opponentScript)} · tick ${progress.tick}`
                }
            })
            await this.progressSaveQueue
            if (controller.signal.aborted) return
            this.failure = failure
            if (!failure) {
                if (singleLevelIndex !== undefined) {
                    if (
                        !completedMatch
                        || completedMatch.levelIndex !== singleLevelIndex
                        || completedMatch.outcome.winner !== "A"
                    ) {
                        throw new Error(`Le niveau ${singleLevelIndex + 1} n'a pas produit de victoire valide`)
                    }
                    this.progressElement.style.width = `${(singleLevelIndex + 1) / Math.max(1, progressionLevelCount) * 100}%`
                    this.currentProgressionLevelIndex = Math.min(
                        progressionLevelCount - 1,
                        singleLevelIndex + 1
                    )
                    this.renderLevelVictory(completedMatch, progressionLevelCount)
                    return
                }
                this.progressElement.style.width = "100%"
                this.setStatus(selectedLevelIndexes
                    ? `${scriptName(botScript)} a gagné les ${executionLevelIndexes.length} niveaux sélectionnés !`
                    : `Jeu terminé : ${scriptName(botScript)} a gagné tous les niveaux !`
                )
                const lastIndex = executionLevelIndexes.at(-1) ?? Math.max(0, progressionLevelCount - 1)
                this.currentProgressionLevelIndex = lastIndex
                const lastLevel = this.progressionLevelAt(botScript, lastIndex)
                this.showLevelProgress(
                    lastIndex,
                    progressionLevelCount,
                    lastLevel?.powerCount ?? 0,
                    selectedLevelIndexes ? "Tous les niveaux sélectionnés sont validés" : "Tous les niveaux sont validés"
                )
                this.detailElement.textContent = selectedLevelIndexes
                    ? `Les ${executionLevelIndexes.length} niveaux choisis ont été gagnés.`
                    : "Tous les adversaires de chaque niveau ont été battus."
                return
            }
            this.currentProgressionLevelIndex = failure.levelIndex
            const failedExecutionIndex = Math.max(0, executionLevelIndexes.indexOf(failure.levelIndex))
            this.progressElement.style.width = `${singleLevelIndex !== undefined
                ? failure.levelIndex / Math.max(1, failure.levelCount) * 100
                : selectedLevelIndexes
                    ? failedExecutionIndex / Math.max(1, executionLevelIndexes.length) * 100
                    : failure.levelIndex / Math.max(1, failure.levelCount) * 100}%`
            this.setStatus(
                `${scriptName(botScript)} a perdu au niveau ${failure.levelIndex + 1}/${failure.levelCount}${selectedLevelIndexes && singleLevelIndex === undefined ? ` (sélection ${failedExecutionIndex + 1}/${executionLevelIndexes.length})` : ""}.`,
                true
            )
            this.showLevelProgress(
                failure.levelIndex,
                failure.levelCount,
                failure.powerCount,
                `Échec contre ${scriptName(failure.opponentScript)}`
            )
            this.detailElement.textContent = `Premier échec contre ${scriptName(failure.opponentScript)} au tick ${failure.outcome.tick}.`
            this.renderFailure(failure)
        } catch (error) {
            if (controller.signal.aborted) this.setStatus("Exécution batch arrêtée.", true)
            else this.setStatus(`Erreur pendant le batch : ${this.errorMessage(error)}`, true)
        } finally {
            if (this.abortController === controller) this.abortController = undefined
            this.setBusy(false)
        }
    }

    private renderLevelVictory(match: BatchMatchCompleted, levelCount: number) {
        const levelIndex = match.levelIndex
        const botScript = this.botSelect.value
        const hasNext = levelIndex + 1 < levelCount
        const outcome = match.outcome
        const victoryDetail = outcome.reason === "time"
            ? `Victoire au temps : ${outcome.droneCountA} drone${outcome.droneCountA > 1 ? "s" : ""} contre ${outcome.droneCountB}.`
            : outcome.reason === "worker-error"
                ? "Victoire provoquée par une erreur du bot adverse."
                : `Victoire par élimination au tick ${outcome.tick}.`
        this.failureElement.classList.add("success")
        this.failureElement.hidden = false
        this.failureElement.innerHTML = `
            <h2>Niveau ${levelIndex + 1}/${levelCount} gagné</h2>
            <p><strong>${escapeHtml(scriptName(botScript))}</strong> a battu <strong>${escapeHtml(scriptName(match.opponentScript))}</strong>.</p>
            <p>${escapeHtml(victoryDetail)}</p>
            <button class="program-button primary" data-action="next">${hasNext ? "Jouer le niveau suivant" : "Rejouer depuis le niveau 1"}</button>
            <button class="program-button" data-action="retry">Rejouer ce niveau</button>
        `
        this.setStatus(hasNext
            ? `Niveau ${levelIndex + 1}/${levelCount} gagné. Vous pouvez passer au niveau suivant.`
            : `Tous les niveaux sont gagnés ! Vous pouvez recommencer depuis le niveau 1.`
        )
        this.showLevelProgress(
            levelIndex,
            levelCount,
            match.powerCount,
            hasNext
                ? `${victoryDetail} · niveau suivant disponible`
                : `${victoryDetail} · jeu terminé`
        )
        this.detailElement.textContent = hasNext
            ? `Prochain combat : niveau ${levelIndex + 2}/${levelCount}.`
            : "Toute la progression est validée."
        this.failureElement.querySelector<HTMLButtonElement>("[data-action=next]")
            ?.addEventListener("click", () => void this.runProgressionLevel(hasNext ? levelIndex + 1 : 0))
        this.failureElement.querySelector<HTMLButtonElement>("[data-action=retry]")
            ?.addEventListener("click", () => void this.runProgressionLevel(levelIndex))
    }

    private renderFailure(failure: BatchFailure) {
        const outcome = failure.outcome
        const result = outcome.reason === "time"
            ? outcome.winner === "draw"
                ? `match nul au temps : ${outcome.droneCountA} drone${outcome.droneCountA > 1 ? "s" : ""} partout`
                : `victoire ${outcome.winner} au temps : A ${outcome.droneCountA} drone${outcome.droneCountA > 1 ? "s" : ""} · B ${outcome.droneCountB} drone${outcome.droneCountB > 1 ? "s" : ""}`
            : outcome.reason === "worker-error"
                ? outcome.winner === "draw" ? "erreur des deux bots" : `victoire ${outcome.winner} après une erreur du bot adverse`
                : outcome.winner === "draw" ? "match nul par élimination" : `victoire ${outcome.winner} par élimination`
        const levelCount = failure.levelCount
        this.failureElement.classList.remove("success")
        this.failureElement.hidden = false
        this.failureElement.innerHTML = `
            <h2>Niveau ${failure.levelIndex + 1}/${levelCount} non validé · ${failure.powerCount} pouvoir${failure.powerCount > 1 ? "s" : ""}</h2>
            <p><strong>${escapeHtml(scriptName(failure.botScript))}</strong> contre <strong>${escapeHtml(scriptName(failure.opponentScript))}</strong> · ${escapeHtml(result)} · tick ${failure.outcome.tick}.</p>
            <button class="program-button primary" data-action="retry">Rejouer ce niveau</button>
            <button class="program-button" data-action="visualize">Visualiser cette partie</button>
            <button class="program-button" data-action="edit">Modifier ce bot</button>
        `
        this.failureElement.querySelector<HTMLButtonElement>("[data-action=retry]")
            ?.addEventListener("click", () => void this.runProgressionLevel(failure.levelIndex))
        this.failureElement.querySelector<HTMLButtonElement>("[data-action=visualize]")
            ?.addEventListener("click", () => this.startFailureReplay())
        this.failureElement.querySelector<HTMLButtonElement>("[data-action=edit]")
            ?.addEventListener("click", () => void this.openSelectedBotEditor(failure.botScript))
    }

    private startFailureReplay() {
        const failure = this.failure
        if (!failure) return
        this.stopReplay()
        this.visualizationElement.hidden = false
        document.body.style.overflow = "hidden"
        const game = new GestionMonde([], levelConfig(failure.powerCount))
        game.load(failure.world)
        const workerA = new Worker(workerUrl(failure.botScript, "A"), { type: "module", name: "Replay joueur A" })
        const workerB = new Worker(workerUrl(failure.opponentScript, "B"), { type: "module", name: "Replay joueur B" })
        game.setWorkerA(workerA)
        game.setWorkerB(workerB)
        this.replayVisualTime = 0
        this.resetReplayAnimations(game)
        this.replayGame = game
        this.replayWorkerA = workerA
        this.replayWorkerB = workerB
        this.replayAccumulator = 0
        this.replayPaused = false
        this.replayStepInFlight = false
        this.replayStepError = undefined
        this.replayHovered = undefined
        this.replayContinueButton.hidden = true
        this.updateReplayPauseButton()
        this.renderReplayInspector()
        this.replayLastFrame = performance.now()
        this.resetReplayZoom(false)
        this.replayBotNameAElement.textContent = scriptName(failure.botScript)
        this.replayBotNameBElement.textContent = scriptName(failure.opponentScript)
        this.replayBotStateAElement.innerHTML = botStateFormHtml(undefined)
        this.replayBotStateBElement.innerHTML = botStateFormHtml(undefined)
        this.resizeCanvas()
        this.replayStatusElement.textContent = `${this.failureLevelLabel(failure)} · ${scriptName(failure.botScript)} (A) contre ${scriptName(failure.opponentScript)} (B)`
        this.startReplayStepInterval()
        this.replayRequestId = requestAnimationFrame(time => this.replayFrame(time))
    }

    private replayFrame(time: number) {
        const game = this.replayGame
        const failure = this.failure
        if (!game || !failure || this.visualizationElement.hidden) return
        const elapsed = Math.min(200, time - this.replayLastFrame)
        this.replayLastFrame = time
        if (!this.replayPaused) this.replayVisualTime += elapsed
        if (!this.replayPaused && game.combatResult && game.drones().some(drone => (drone.cible?.fireTime ?? 0) > 0)) {
            // La simulation s'arrête immédiatement au résultat. On termine uniquement
            // les délais visuels en cours afin que le dernier tir ne reste pas figé.
            this.replayAccumulator += elapsed * (Number(this.replaySpeedInput.value) || 300) / 1000
            let visualSteps = 0
            while (this.replayAccumulator >= 1 && visualSteps < 120) {
                for (const drone of game.drones()) {
                    if (!drone.cible || drone.cible.fireTime <= 0) continue
                    drone.cible.fireTime--
                    if (drone.cible.fireTime <= 0) drone.cible = undefined
                }
                this.detectReplayWorldEvents(game)
                this.replayAccumulator--
                visualSteps++
            }
        }
        this.drawReplay(this.replayVisualTime)
        const aFactories = game.usines().filter(factory => factory.etat?.joueur === game.joueurA).length
        const bFactories = game.usines().filter(factory => factory.etat?.joueur === game.joueurB).length
        const aDrones = game.drones().filter(drone => drone.joueur === game.joueurA).length
        const bDrones = game.drones().filter(drone => drone.joueur === game.joueurB).length
        const result = game.combatResult
        const level = this.failureLevelLabel(failure)
        this.replayBotStateAElement.innerHTML = botStateFormHtml(game.dataLogA)
        this.replayBotStateBElement.innerHTML = botStateFormHtml(game.dataLogB)
        this.replayPlayerStatsAElement.innerHTML = this.replayPlayerStatsHtml(aFactories, aDrones)
        this.replayPlayerStatsBElement.innerHTML = this.replayPlayerStatsHtml(bFactories, bDrones)
        const replayStatus = result
            ? `${level} · ${result.winner ? `Victoire ${result.winner === game.joueurA ? "A" : "B"}` : "Match nul"} · tick ${result.tick} · A ${aFactories}U/${aDrones}D · B ${bFactories}U/${bDrones}D`
            : `${level} · tick ${game.combatTick} · A ${aFactories}U/${aDrones}D · B ${bFactories}U/${bDrones}D`
        this.replayStatusElement.textContent = this.replayStepError
            ? `ERREUR · ${this.replayStepError} · ${replayStatus}`
            : this.replayPaused
                ? `PAUSE · cliquez sur un élément pour ses détails · ${replayStatus}`
                : replayStatus
        this.updateReplayContinueButton(result, game, failure)
        this.renderReplayInspector()
        this.replayRequestId = requestAnimationFrame(next => this.replayFrame(next))
    }

    private startReplayStepInterval() {
        if (this.replayStepInterval !== undefined) clearInterval(this.replayStepInterval)
        this.replayStepInterval = undefined
        if (!this.replayGame || this.visualizationElement.hidden || this.replayStepError) return
        const stepsPerSecond = Math.max(1, Number(this.replaySpeedInput.value) || 300)
        const delay = Math.max(1, Math.round(1000 / stepsPerSecond))
        this.replayStepInterval = setInterval(() => void this.executeReplayStep(), delay)
    }

    private async executeReplayStep() {
        const game = this.replayGame
        if (
            !game
            || this.visualizationElement.hidden
            || this.replayPaused
            || this.replayStepInFlight
            || game.combatResult
            || this.replayStepError
        ) return

        this.replayStepInFlight = true
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
            const result = await Promise.race([
                game.step(),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("un bot ne répond plus")), 2_000)
                })
            ])
            if (this.replayGame !== game) return
            this.detectReplayWorldEvents(game)
            if (result || game.combatResult) {
                if (this.replayStepInterval !== undefined) clearInterval(this.replayStepInterval)
                this.replayStepInterval = undefined
            }
        } catch (error) {
            if (this.replayGame !== game) return
            this.replayStepError = this.errorMessage(error)
            this.replayPaused = true
            if (this.replayStepInterval !== undefined) clearInterval(this.replayStepInterval)
            this.replayStepInterval = undefined
            this.updateReplayPauseButton()
        } finally {
            if (timeout !== undefined) clearTimeout(timeout)
            if (this.replayGame === game) this.replayStepInFlight = false
        }
    }

    private updateReplayContinueButton(
        result: GestionMonde["combatResult"],
        game: GestionMonde,
        match: BatchFailure
    ) {
        const wonBySelectedBot = result?.winner === game.joueurA
        this.replayContinueButton.hidden = !wonBySelectedBot
        if (!wonBySelectedBot) return
        this.replayContinueButton.textContent = match.levelIndex + 1 < match.levelCount
            ? "Jouer le niveau suivant"
            : "Terminer le jeu"
    }

    private continueAfterReplayVictory() {
        const game = this.replayGame
        const match = this.failure
        const result = game?.combatResult
        if (!game || !match || result?.winner !== game.joueurA) return

        const hasNext = match.levelIndex + 1 < match.levelCount
        const completedMatch: BatchMatchCompleted = {
            ...match,
            outcome: {
                winner: "A",
                tick: result.tick,
                droneCountA: result.droneCountA,
                droneCountB: result.droneCountB,
                reason: result.reason
            }
        }
        const reachedLevelIndex = hasNext ? match.levelIndex + 1 : match.levelIndex
        this.currentProgressionLevelIndex = reachedLevelIndex
        void this.queueProgrammingProgress(match.botScript, reachedLevelIndex, !hasNext)
        this.closeReplay()
        if (hasNext) {
            void this.runProgressionLevel(match.levelIndex + 1)
            return
        }

        this.failure = undefined
        this.renderLevelVictory(completedMatch, match.levelCount)
        this.updateProgressionControl()
    }

    private toggleReplayPause() {
        if (!this.replayGame || this.visualizationElement.hidden) return
        this.replayPaused = !this.replayPaused
        this.replayLastFrame = performance.now()
        if (!this.replayPaused) this.clearReplaySelection()
        this.updateReplayPauseButton()
    }

    private updateReplayPauseButton() {
        if (!this.replayPauseButton) return
        this.replayPauseButton.textContent = this.replayPaused ? "Reprendre" : "Pause"
        this.replayPauseButton.setAttribute("aria-pressed", String(this.replayPaused))
        this.replayPauseButton.title = this.replayPaused
            ? "Reprendre le combat"
            : "Mettre le combat et ses animations en pause"
    }

    private replayPlayerName(game: GestionMonde, player: Drone["joueur"]) {
        if (player === game.joueurA) return "A"
        if (player === game.joueurB) return "B"
        return "inconnu"
    }

    private replayTargetName(game: GestionMonde, target: NonNullable<Drone["cible"]>["cible"]) {
        if (target instanceof Drone) return `Drone ${this.replayPlayerName(game, target.joueur)} · ${target.id}`
        if (target instanceof Usine) return `Usine ${target.etat ? this.replayPlayerName(game, target.etat.joueur) : "neutre"} · ${target.id}`
        if (target instanceof Energie) return `Énergie · ${target.id}`
        if (target instanceof Vie) return `Vie · ${target.id}`
        if (target instanceof GameElement) return `Élément · ${target.id}`
        return `Point ${target.x.toFixed(1)}, ${target.y.toFixed(1)}`
    }

    private replayActionName(type: ReplayActionType | undefined) {
        if (!type) return "aucune"
        return ({
            "attack-drone": "attaque d’un drone",
            "attack-factory": "attaque d’une usine",
            "collect-energy": "collecte d’énergie",
            "collect-life": "collecte de vie",
            "repair-factory": "réparation d’une usine",
            "capture-factory": "prise d’une usine"
        } satisfies Record<ReplayActionType, string>)[type]
    }

    private replayInspectorRow(label: string, value: unknown) {
        return `<div class="replay-inspector-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
    }

    private replayElementIsVisible(game: GestionMonde, entity: GameElement) {
        if (entity instanceof Drone) {
            return game.entities.includes(entity) || this.replayPendingDestroyed.has(entity.id)
        }
        if (entity instanceof Energie || entity instanceof Vie) {
            return !entity.proprietaire || [...this.replayActions.values()].some(action => action.target === entity)
        }
        return game.entities.includes(entity)
    }

    private renderReplayInspector() {
        const game = this.replayGame
        const entity = this.replayHovered
        if (!this.replayPaused || !game || !entity || !this.replayElementIsVisible(game, entity)) {
            this.replayHovered = undefined
            if (this.replayInspectorElement) {
                this.replayInspectorElement.hidden = true
                this.replayInspectorElement.replaceChildren()
                delete this.replayInspectorElement.dataset.owner
            }
            return
        }

        delete this.replayInspectorElement.dataset.owner
        let title: string
        const rows: string[] = []
        if (entity instanceof Drone) {
            const player = this.replayPlayerName(game, entity.joueur)
            const state = game.droneStates.find(value => value.ref === entity)
            const action = this.replayActions.get(entity.id)
            const destroyed = this.replayPendingDestroyed.has(entity.id)
            const target = entity.cible?.cible
            this.replayInspectorElement.dataset.owner = player
            title = `Drone du joueur ${player}`
            rows.push(this.replayInspectorRow("Identifiant", entity.id))
            rows.push(this.replayInspectorRow("État", destroyed
                ? "touché · destruction imminente"
                : (entity.cible?.fireTime ?? 0) > 0
                    ? "en action"
                    : state?.type === "move" ? "en déplacement" : state?.type === "wait" ? "disponible" : "absent"))
            rows.push(this.replayInspectorRow("Action", this.replayActionName(action?.type)))
            rows.push(this.replayInspectorRow("Énergie", entity.energieCount))
            rows.push(this.replayInspectorRow("Vie", entity.vieCount))
            rows.push(this.replayInspectorRow("Cargaison", `${entity.energieCount + entity.vieCount} / ${game.getDroneTransport(entity.joueur)}`))
            rows.push(this.replayInspectorRow("Puissance", game.getDronePower(entity.joueur)))
            rows.push(this.replayInspectorRow("Vitesse", game.getDroneSpeed(entity.joueur)))
            rows.push(this.replayInspectorRow("Portée", game.getDroneRange(entity.joueur)))
            rows.push(this.replayInspectorRow("Cible", target ? this.replayTargetName(game, target) : "aucune"))
            rows.push(this.replayInspectorRow("Temps d’action", entity.cible?.fireTime ?? 0))
            rows.push(this.replayInspectorRow("Usine d’origine", `${entity.usine.technologie} · ${entity.usine.id}`))
            rows.push(this.replayInspectorRow("Position", `${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}`))
            if (state?.type === "move") {
                rows.push(this.replayInspectorRow("Distance restante", state.distance.toFixed(2)))
                rows.push(this.replayInspectorRow("Déplacement/tick", state.dep.toFixed(2)))
                rows.push(this.replayInspectorRow("Vecteur", `${state.sx.toFixed(2)}, ${state.sy.toFixed(2)}`))
            }
        } else if (entity instanceof Usine) {
            const player = entity.etat ? this.replayPlayerName(game, entity.etat.joueur) : "neutre"
            if (player === "A" || player === "B") this.replayInspectorElement.dataset.owner = player
            const buildDuration = entity.etat ? game.buildTime(entity.etat.joueur) : 0
            title = `Usine ${player}`
            rows.push(this.replayInspectorRow("Identifiant", entity.id))
            rows.push(this.replayInspectorRow("Propriétaire", player))
            rows.push(this.replayInspectorRow("Technologie", entity.technologie))
            rows.push(this.replayInspectorRow("Pouvoir actif", game.isTechnologyEnabled(entity.technologie) ? "oui" : "non"))
            rows.push(this.replayInspectorRow("Vie", entity.etat?.vieCount ?? 0))
            rows.push(this.replayInspectorRow("Production", !entity.etat
                ? "inactive"
                : entity.etat.newDrone ? "drone prêt" : `${Math.max(0, entity.etat.time)} ticks restants`))
            rows.push(this.replayInspectorRow("Durée construction", buildDuration || "—"))
            rows.push(this.replayInspectorRow("Population", entity.etat
                ? `${entity.etat.populationCount} / ${game.getDronePopulation(entity.etat.joueur)}`
                : "—"))
            rows.push(this.replayInspectorRow("Nouveau drone", entity.etat?.newDrone?.id ?? "aucun"))
            rows.push(this.replayInspectorRow("Position", `${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}`))
        } else {
            const resource = entity as Energie | Vie
            const owner = resource.proprietaire
            title = entity instanceof Energie ? "Ressource Énergie" : "Ressource Vie"
            const ownerName = owner instanceof Drone
                ? `Drone ${this.replayPlayerName(game, owner.joueur)} · ${owner.id}`
                : owner instanceof Usine
                    ? `Usine ${owner.etat ? this.replayPlayerName(game, owner.etat.joueur) : "neutre"} · ${owner.id}`
                    : "aucun"
            rows.push(this.replayInspectorRow("Identifiant", entity.id))
            rows.push(this.replayInspectorRow("Type", entity instanceof Energie ? "énergie" : "vie"))
            rows.push(this.replayInspectorRow("Disponible", owner ? "non" : "oui"))
            rows.push(this.replayInspectorRow("Propriétaire", ownerName))
            rows.push(this.replayInspectorRow("Position", `${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}`))
        }

        this.replayInspectorElement.hidden = false
        this.replayInspectorElement.innerHTML = `
            <strong class="replay-inspector-title">${escapeHtml(title)}</strong>
            <div class="replay-inspector-grid">${rows.join("")}</div>
        `
    }

    private resetReplayAnimations(game: GestionMonde) {
        this.replayActions.clear()
        this.replayPendingDestroyed.clear()
        this.replayExplosions = []
        this.replayLaunches = []
        this.replayDroneMemory = new Map(game.drones().map(drone => [drone.id, {
            ref: drone,
            position: { ...drone.position },
            angle: this.replayDroneAngle(game, drone),
            isA: drone.joueur === game.joueurA
        }]))
        this.replayFactoryOwners = new Map(game.usines().map(factory => [factory.id, factory.etat?.joueur.id]))
        this.replayCooldowns = new Map(game.drones().map(drone => [drone.id, drone.cible?.fireTime ?? 0]))
    }

    private detectReplayWorldEvents(game: GestionMonde) {
        const nextCooldowns = new Map<string, number>()
        for (const drone of game.drones()) {
            const cooldown = drone.cible?.fireTime ?? 0
            const previousCooldown = this.replayCooldowns.get(drone.id) ?? 0
            nextCooldowns.set(drone.id, cooldown)
            if (cooldown > 0 && previousCooldown <= 0) {
                const action = this.classifyReplayAction(drone)
                if (action) this.replayActions.set(drone.id, action)
            } else if (cooldown <= 0) {
                this.replayActions.delete(drone.id)
            }
        }
        const liveIds = new Set(game.drones().map(drone => drone.id))
        for (const droneId of this.replayActions.keys()) {
            if (!liveIds.has(droneId)) this.replayActions.delete(droneId)
        }
        this.replayCooldowns = nextCooldowns

        const currentDrones = new Map(game.drones().map(drone => [drone.id, {
            ref: drone,
            position: { ...drone.position },
            angle: this.replayDroneAngle(game, drone),
            isA: drone.joueur === game.joueurA
        }]))
        for (const drone of game.drones()) {
            if (!this.replayDroneMemory.has(drone.id)) {
                this.replayLaunches.push({
                    position: { ...drone.usine.position },
                    color: drone.joueur === game.joueurA ? PLAYER_A_COLOR : PLAYER_B_COLOR,
                    startedAt: this.replayVisualTime,
                    duration: 850
                })
            }
        }
        for (const [id, remembered] of this.replayDroneMemory) {
            if (currentDrones.has(id)) continue
            if (this.replayDroneIsUnderAttack(game, remembered.ref)) {
                this.replayPendingDestroyed.set(id, remembered)
            } else {
                this.startReplayExplosion(remembered)
            }
        }
        for (const [id, remembered] of this.replayPendingDestroyed) {
            if (!this.replayDroneIsUnderAttack(game, remembered.ref)) {
                this.replayPendingDestroyed.delete(id)
                this.startReplayExplosion(remembered)
            }
        }
        this.replayDroneMemory = currentDrones
        this.replayFactoryOwners = new Map(game.usines().map(factory => [factory.id, factory.etat?.joueur.id]))
    }

    private classifyReplayAction(drone: Drone): ReplayAction | undefined {
        const target = drone.cible?.cible
        if (target instanceof Drone) return { type: "attack-drone", target }
        if (target instanceof Energie) return { type: "collect-energy", target }
        if (target instanceof Vie) return { type: "collect-life", target }
        if (!(target instanceof Usine)) return undefined
        const previousOwner = this.replayFactoryOwners.get(target.id)
        if (previousOwner && previousOwner !== drone.joueur.id) return { type: "attack-factory", target }
        if (!previousOwner) return { type: "capture-factory", target }
        return { type: "repair-factory", target }
    }

    private replayDroneIsUnderAttack(game: GestionMonde, target: Drone) {
        return game.drones().some(drone =>
            (drone.cible?.fireTime ?? 0) > 0
            && drone.cible?.cible === target
        )
    }

    private replayDroneAngle(game: GestionMonde, drone: Drone) {
        const target = drone.cible?.cible
        if ((drone.cible?.fireTime ?? 0) > 0 && target instanceof GameElement) {
            const dx = target.position.x - drone.position.x
            const dy = target.position.y - drone.position.y
            if (Math.hypot(dx, dy) > .001) return Math.atan2(dy, dx) + Math.PI / 2
        }
        const state = game.droneStates.find(value => value.ref === drone)
        if (state?.type === "move" && state.distance > 0 && Math.hypot(state.sx, state.sy) > .001) {
            return Math.atan2(state.sy, state.sx) + Math.PI / 2
        }
        if (target instanceof GameElement) {
            return Math.atan2(target.position.y - drone.position.y, target.position.x - drone.position.x) + Math.PI / 2
        }
        return 0
    }

    private startReplayExplosion(drone: ReplayRememberedDrone) {
        const playerColor = drone.isA ? PLAYER_A_COLOR : PLAYER_B_COLOR
        const colors = [playerColor, "#ffffff", "#ffd166", "#ff713d"]
        const particles: ReplayParticle[] = Array.from({ length: 26 }, (_, index) => {
            const kind: ReplayParticle["kind"] = index < 15 ? "spark" : index < 21 ? "fragment" : "smoke"
            return {
                angle: Math.random() * Math.PI * 2,
                speed: kind === "smoke" ? 22 + Math.random() * 28 : 45 + Math.random() * 75,
                size: kind === "smoke" ? 3 + Math.random() * 3 : 1.5 + Math.random() * 2.5,
                delay: Math.random() * .12,
                color: kind === "smoke" ? "#596176" : colors[index % colors.length],
                kind
            }
        })
        this.replayExplosions.push({
            position: { ...drone.position },
            startedAt: this.replayVisualTime,
            duration: 950,
            particles
        })
    }

    private resizeCanvas() {
        const rect = this.canvas.getBoundingClientRect()
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const width = Math.max(1, rect.width)
        const height = Math.max(1, rect.height)
        const pixelWidth = Math.max(1, Math.round(width * dpr))
        const pixelHeight = Math.max(1, Math.round(height * dpr))
        if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
            this.canvas.width = pixelWidth
            this.canvas.height = pixelHeight
        }
        return { width, height, dpr }
    }

    private replayElementAt(clientX: number, clientY: number) {
        const game = this.replayGame
        if (!game) return undefined
        const rect = this.canvas.getBoundingClientRect()
        const scale = Math.max(.01, this.replayView.scale)
        const worldX = (clientX - rect.left - this.replayView.offsetX) / scale
        const worldY = (clientY - rect.top - this.replayView.offsetY) / scale
        const nearest = (elements: GameElement[], radiusPixels: number) => {
            let best: GameElement | undefined
            let bestDistance = Infinity
            for (const entity of elements) {
                const distance = Math.hypot(entity.position.x - worldX, entity.position.y - worldY)
                if (distance * scale <= radiusPixels && distance < bestDistance) {
                    best = entity
                    bestDistance = distance
                }
            }
            return best
        }

        const drones = [
            ...game.drones(),
            ...[...this.replayPendingDestroyed.values()].map(value => value.ref)
        ]
        return nearest(drones, 25)
            ?? nearest(game.usines(), 39)
            ?? nearest(
                game.ressources().filter(resource => this.replayElementIsVisible(game, resource)),
                21
            )
    }

    private selectReplayElement(clientX: number, clientY: number) {
        if (!this.replayPaused || this.visualizationElement.hidden) return
        const selected = this.replayElementAt(clientX, clientY)
        if (selected === this.replayHovered) return
        this.replayHovered = selected
        this.renderReplayInspector()
        this.drawReplay()
    }

    private clearReplaySelection() {
        if (!this.replayHovered && this.replayInspectorElement?.hidden) return
        this.replayHovered = undefined
        this.renderReplayInspector()
        this.drawReplay()
    }

    private installReplayCanvasControls() {
        this.canvas.addEventListener("wheel", event => {
            if (this.visualizationElement.hidden) return
            event.preventDefault()
            const rect = this.canvas.getBoundingClientRect()
            this.changeReplayZoom(
                event.deltaY < 0 ? 1.2 : 1 / 1.2,
                event.clientX - rect.left,
                event.clientY - rect.top
            )
        }, { passive: false })

        if ("PointerEvent" in window) {
            this.canvas.addEventListener("pointerdown", event => {
                if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return
                event.preventDefault()
                try {
                    this.canvas.setPointerCapture(event.pointerId)
                } catch {
                    // La capture peut être indisponible dans certaines WebView.
                }
                this.beginReplayPan(event.clientX, event.clientY, event.pointerId)
            })
            this.canvas.addEventListener("pointermove", event => {
                if (this.moveReplayPan(event.clientX, event.clientY, event.pointerId)) event.preventDefault()
            })
            this.canvas.addEventListener("pointerup", event => {
                const dragged = this.endReplayPan(event.pointerId)
                if (!dragged) this.selectReplayElement(event.clientX, event.clientY)
            })
            this.canvas.addEventListener("pointercancel", event => {
                this.endReplayPan(event.pointerId)
            })
            return
        }

        this.canvas.addEventListener("mousedown", event => {
            if (event.button !== 0) return
            this.beginReplayPan(event.clientX, event.clientY, "mouse")
        })
        this.canvas.addEventListener("mousemove", event => {
            if (this.moveReplayPan(event.clientX, event.clientY, "mouse")) event.preventDefault()
        })
        this.canvas.addEventListener("mouseup", event => {
            const dragged = this.endReplayPan("mouse")
            if (!dragged) this.selectReplayElement(event.clientX, event.clientY)
        })
        this.canvas.addEventListener("mouseleave", () => {
            this.endReplayPan("mouse")
        })
        this.canvas.addEventListener("touchstart", event => {
            const touch = event.changedTouches[0]
            if (!touch) return
            event.preventDefault()
            this.beginReplayPan(touch.clientX, touch.clientY, touch.identifier)
        }, { passive: false })
        this.canvas.addEventListener("touchmove", event => {
            const pan = this.replayPan
            if (!pan) return
            const touch = Array.from(event.touches).find(value => value.identifier === pan.id)
            if (!touch) return
            event.preventDefault()
            this.moveReplayPan(touch.clientX, touch.clientY, touch.identifier)
        }, { passive: false })
        this.canvas.addEventListener("touchend", event => {
            const pan = this.replayPan
            if (!pan) return
            const touch = Array.from(event.changedTouches).find(value => value.identifier === pan.id)
            if (touch) {
                const dragged = this.endReplayPan(touch.identifier)
                if (!dragged) this.selectReplayElement(touch.clientX, touch.clientY)
            }
        })
    }

    private beginReplayPan(clientX: number, clientY: number, id: number | string) {
        if (this.visualizationElement.hidden || !this.failure) return
        this.replayPan = {
            id,
            startX: clientX,
            startY: clientY,
            lastX: clientX,
            lastY: clientY,
            dragging: false
        }
    }

    private moveReplayPan(clientX: number, clientY: number, id: number | string) {
        const pan = this.replayPan
        const failure = this.failure
        if (!pan || pan.id !== id || !failure) return false
        if (!pan.dragging) {
            const threshold = typeof id === "number" ? 7 : 5
            if (Math.hypot(clientX - pan.startX, clientY - pan.startY) < threshold) return true
            pan.dragging = true
            this.canvas.dataset.panning = "true"
        }
        const dx = clientX - pan.lastX
        const dy = clientY - pan.lastY
        const rect = this.canvas.getBoundingClientRect()
        const scale = this.replayFittedScale(rect.width, rect.height, failure) * this.replayZoom
        this.replayCamera.x -= dx / Math.max(.01, scale)
        this.replayCamera.y -= dy / Math.max(.01, scale)
        this.syncReplayView(rect.width, rect.height, scale, failure)
        pan.lastX = clientX
        pan.lastY = clientY
        this.drawReplay()
        return true
    }

    private endReplayPan(id: number | string) {
        if (this.replayPan?.id !== id) return false
        const dragged = this.replayPan.dragging
        this.replayPan = undefined
        delete this.canvas.dataset.panning
        return dragged
    }

    private changeReplayZoom(factor: number, canvasX?: number, canvasY?: number) {
        const failure = this.failure
        if (!failure || this.visualizationElement.hidden) return
        const rect = this.canvas.getBoundingClientRect()
        const width = Math.max(1, rect.width)
        const height = Math.max(1, rect.height)
        const previousZoom = this.replayZoom
        const nextZoom = Math.min(6, Math.max(1, previousZoom * factor))
        if (Math.abs(nextZoom - previousZoom) < .001) return
        const baseScale = this.replayFittedScale(width, height, failure)
        const currentScale = baseScale * previousZoom
        this.syncReplayView(width, height, currentScale, failure)
        const focusX = canvasX ?? width / 2
        const focusY = canvasY ?? height / 2
        const worldX = (focusX - this.replayView.offsetX) / currentScale
        const worldY = (focusY - this.replayView.offsetY) / currentScale
        const nextScale = baseScale * nextZoom
        this.replayCamera = {
            x: worldX + (width / 2 - focusX) / nextScale,
            y: worldY + (height / 2 - focusY) / nextScale
        }
        this.replayZoom = nextZoom
        this.syncReplayView(width, height, nextScale, failure)
        this.updateReplayZoomControls()
        this.drawReplay()
    }

    private resetReplayZoom(redraw = true) {
        const failure = this.failure
        this.replayZoom = 1
        this.replayCamera = failure
            ? { x: failure.width / 2, y: failure.height / 2 }
            : { x: 0, y: 0 }
        this.replayPan = undefined
        if (this.canvas) delete this.canvas.dataset.panning
        this.updateReplayZoomControls()
        if (redraw && failure && !this.visualizationElement.hidden) this.drawReplay()
    }

    private updateReplayZoomControls() {
        if (!this.replayZoomResetButton) return
        this.replayZoomResetButton.textContent = `Zoom ${Math.round(this.replayZoom * 100)} %`
        this.replayZoomResetButton.disabled = this.replayZoom <= 1.001
        this.replayZoomOutButton.disabled = this.replayZoom <= 1.001
        this.replayZoomInButton.disabled = this.replayZoom >= 5.999
    }

    private replayFittedScale(width: number, height: number, failure: BatchFailure) {
        const margin = 14
        return Math.max(.01, Math.min(
            Math.max(1, width - margin * 2) / failure.width,
            Math.max(1, height - margin * 2) / failure.height
        ))
    }

    private syncReplayView(width: number, height: number, scale: number, failure: BatchFailure) {
        const halfVisibleWidth = width / (2 * Math.max(.01, scale))
        const halfVisibleHeight = height / (2 * Math.max(.01, scale))
        this.replayCamera.x = halfVisibleWidth >= failure.width / 2
            ? failure.width / 2
            : Math.min(failure.width - halfVisibleWidth, Math.max(halfVisibleWidth, this.replayCamera.x))
        this.replayCamera.y = halfVisibleHeight >= failure.height / 2
            ? failure.height / 2
            : Math.min(failure.height - halfVisibleHeight, Math.max(halfVisibleHeight, this.replayCamera.y))
        this.replayView = {
            scale,
            offsetX: width / 2 - this.replayCamera.x * scale,
            offsetY: height / 2 - this.replayCamera.y * scale
        }
    }

    private replayPlayerStatsHtml(factoryCount: number, droneCount: number) {
        return `
            <div class="replay-player-stat"><b>${factoryCount}</b><span>Usine${factoryCount > 1 ? "s" : ""}</span></div>
            <div class="replay-player-stat"><b>${droneCount}</b><span>Drone${droneCount > 1 ? "s" : ""}</span></div>
        `
    }

    private drawReplay(time = this.replayVisualTime) {
        const game = this.replayGame
        const failure = this.failure
        if (!game || !failure) return
        const { width, height, dpr } = this.resizeCanvas()
        const scale = this.replayFittedScale(width, height, failure) * this.replayZoom
        this.syncReplayView(width, height, scale, failure)
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.ctx.imageSmoothingEnabled = false
        this.ctx.fillStyle = "#d5d8dd"
        this.ctx.fillRect(0, 0, width, height)
        this.ctx.save()
        this.ctx.translate(this.replayView.offsetX, this.replayView.offsetY)
        this.ctx.scale(scale, scale)
        this.ctx.fillStyle = "#e4e6e9"
        this.ctx.fillRect(0, 0, failure.width, failure.height)
        this.ctx.strokeStyle = "#c5cad1"
        this.ctx.lineWidth = 1 / scale
        for (let x = 0; x <= failure.width; x += 50) {
            this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, failure.height); this.ctx.stroke()
        }
        for (let y = 0; y <= failure.height; y += 50) {
            this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(failure.width, y); this.ctx.stroke()
        }
        for (const resource of game.ressources()) {
            if (resource.proprietaire) continue
            const image = resource instanceof Energie ? this.images.energy : this.images.life
            this.drawImage(image, resource.position.x, resource.position.y, 26 / scale)
        }
        for (const factory of game.usines()) {
            const building = Boolean(factory.etat && !factory.etat.newDrone)
            const image = building ? this.images.factoryBuilding : this.images.factory
            const buildPulse = building ? 1 + Math.sin(time / 105 + factory.position.x) * .04 : 1
            this.drawImage(image, factory.position.x, factory.position.y, 58 * buildPulse / scale)
            const color = !factory.etat ? NEUTRAL_COLOR
                : factory.etat.joueur === game.joueurA ? PLAYER_A_COLOR : PLAYER_B_COLOR
            if (factory.etat) {
                const radius = 35 / scale
                this.ctx.save()
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 4 / scale
                this.ctx.strokeStyle = "rgba(24, 34, 52, .82)"
                this.ctx.lineWidth = 7 / scale
                this.ctx.beginPath()
                this.ctx.arc(factory.position.x, factory.position.y, radius, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.shadowBlur = 0
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 4 / scale
                this.ctx.beginPath()
                this.ctx.arc(factory.position.x, factory.position.y, radius, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.restore()
            } else {
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 2 / scale
                this.ctx.strokeRect(
                    factory.position.x - 29 / scale,
                    factory.position.y - 29 / scale,
                    58 / scale,
                    58 / scale
                )
            }
            if (building && factory.etat) {
                const duration = Math.max(1, game.buildTime(factory.etat.joueur))
                const progress = Math.min(1, Math.max(0, 1 - factory.etat.time / duration))
                this.ctx.save()
                this.ctx.translate(factory.position.x, factory.position.y)
                this.ctx.rotate(time / 420)
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 2.5 / scale
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 8 / scale
                this.ctx.setLineDash([5 / scale, 4 / scale])
                this.ctx.beginPath()
                this.ctx.arc(0, 0, 42 / scale, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
                this.ctx.stroke()
                this.ctx.restore()
            }
        }
        this.drawReplayResourceActions(game, time, scale)
        for (const drone of game.drones()) this.drawDrone(game, drone, scale)
        this.drawReplayPendingDestroyed(game, time, scale)
        this.drawReplayLaunches(time, scale)
        this.drawReplayFactoryActions(game, time, scale)
        this.drawReplayAttackLasers(game, time, scale)
        this.drawReplayExplosions(time, scale)
        this.drawReplayHovered(game, time, scale)
        this.ctx.strokeStyle = "#505a68"
        this.ctx.lineWidth = 2 / scale
        this.ctx.strokeRect(0, 0, failure.width, failure.height)
        this.ctx.restore()
    }

    private drawReplayHovered(game: GestionMonde, time: number, scale: number) {
        const entity = this.replayHovered
        if (!this.replayPaused || !entity || !this.replayElementIsVisible(game, entity)) return
        const radius = entity instanceof Usine ? 43 : entity instanceof Drone ? 27 : 21
        const pulse = 1 + Math.sin(time / 130) * .08
        this.ctx.save()
        this.ctx.strokeStyle = "#ffffff"
        this.ctx.lineWidth = 3 / scale
        this.ctx.shadowColor = "#26334a"
        this.ctx.shadowBlur = 7 / scale
        this.ctx.setLineDash([7 / scale, 4 / scale])
        this.ctx.lineDashOffset = -time / 55 / scale
        this.ctx.beginPath()
        this.ctx.arc(entity.position.x, entity.position.y, radius * pulse / scale, 0, Math.PI * 2)
        this.ctx.stroke()
        this.ctx.restore()
    }

    private drawReplayResourceActions(game: GestionMonde, time: number, scale: number) {
        for (const drone of game.drones()) {
            const action = this.replayActions.get(drone.id)
            const fireTime = drone.cible?.fireTime ?? 0
            if (
                !action
                || (action.type !== "collect-energy" && action.type !== "collect-life")
                || !(action.target instanceof Energie || action.target instanceof Vie)
                || drone.cible?.cible !== action.target
                || fireTime <= 0
            ) continue

            const target = action.target
            const progress = Math.min(1, Math.max(0, 1 - fireTime / game.config.FIRE_TIME))
            let dx = target.position.x - drone.position.x
            let dy = target.position.y - drone.position.y
            let distance = Math.hypot(dx, dy)
            if (distance < .001) {
                const fallbackAngle = drone.id.charCodeAt(0) % 2 === 0 ? -Math.PI / 3 : Math.PI / 3
                dx = Math.cos(fallbackAngle)
                dy = Math.sin(fallbackAngle)
                distance = 1
            }
            const perpendicularX = -dy / distance
            const perpendicularY = dx / distance
            const curveDirection = drone.id.charCodeAt(1) % 2 === 0 ? 1 : -1
            const curveOffset = Math.max(0, 72 / scale - distance) * .88 * curveDirection
                + Math.sin(time / 115 + progress * 8) * 1.8 / scale
            const controlX = (drone.position.x + target.position.x) / 2 + perpendicularX * curveOffset
            const controlY = (drone.position.y + target.position.y) / 2 + perpendicularY * curveOffset
            const retractPhase = Math.min(1, Math.max(0, (progress - .58) / .42))
            const extension = progress < .42
                ? 1 - Math.pow(1 - progress / .42, 3)
                : progress < .58
                    ? 1
                    : 1 - retractPhase * retractPhase * (3 - 2 * retractPhase)
            const jointX = drone.position.x + (controlX - drone.position.x) * extension
            const jointY = drone.position.y + (controlY - drone.position.y) * extension
            const secondControlX = controlX + (target.position.x - controlX) * extension
            const secondControlY = controlY + (target.position.y - controlY) * extension
            const tipX = jointX + (secondControlX - jointX) * extension
            const tipY = jointY + (secondControlY - jointY) * extension
            const color = target instanceof Energie ? "#ff9e20" : "#1fcf98"

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.lineJoin = "round"
            this.ctx.strokeStyle = "#111827"
            this.ctx.lineWidth = 8 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(drone.position.x, drone.position.y)
            this.ctx.lineTo(jointX, jointY)
            this.ctx.lineTo(tipX, tipY)
            this.ctx.stroke()
            this.ctx.strokeStyle = "#aebbd0"
            this.ctx.lineWidth = 4 / scale
            this.ctx.stroke()
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 1.3 / scale
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 6 / scale
            this.ctx.stroke()
            this.ctx.shadowBlur = 0

            for (const joint of [{ x: jointX, y: jointY }, { x: tipX, y: tipY }]) {
                this.ctx.fillStyle = "#17233a"
                this.ctx.strokeStyle = "#ffffff"
                this.ctx.lineWidth = 1.4 / scale
                this.ctx.beginPath()
                this.ctx.arc(joint.x, joint.y, 3.4 / scale, 0, Math.PI * 2)
                this.ctx.fill()
                this.ctx.stroke()
            }

            const clawDx = tipX - jointX
            const clawDy = tipY - jointY
            const clawDistance = Math.max(.001, Math.hypot(clawDx, clawDy))
            const clawUx = clawDx / clawDistance
            const clawUy = clawDy / clawDistance
            const clawPx = -clawUy
            const clawPy = clawUx
            this.ctx.strokeStyle = "#ffffff"
            this.ctx.lineWidth = 2 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(tipX, tipY)
            this.ctx.lineTo(tipX + clawUx * 7 / scale + clawPx * 5 / scale, tipY + clawUy * 7 / scale + clawPy * 5 / scale)
            this.ctx.moveTo(tipX, tipY)
            this.ctx.lineTo(tipX + clawUx * 7 / scale - clawPx * 5 / scale, tipY + clawUy * 7 / scale - clawPy * 5 / scale)
            this.ctx.stroke()

            const carried = progress >= .5
            const image = target instanceof Energie ? this.images.energy : this.images.life
            this.drawImage(
                image,
                carried ? tipX : target.position.x,
                carried ? tipY : target.position.y,
                (carried ? 23 : 29) / scale
            )
            this.ctx.restore()
        }
    }

    private drawReplayPendingDestroyed(game: GestionMonde, time: number, scale: number) {
        for (const drone of this.replayPendingDestroyed.values()) {
            const attacker = game.drones().find(value =>
                (value.cible?.fireTime ?? 0) > 0 && value.cible?.cible === drone.ref
            )
            const fireTime = attacker?.cible?.fireTime ?? 0
            const progress = Math.min(1, Math.max(0, 1 - fireTime / game.config.FIRE_TIME))
            const image = drone.isA ? this.images.droneA : this.images.droneB
            if (!image.complete || image.naturalWidth <= 0) continue
            const jitter = progress > .62 ? (progress - .62) * 6 / scale : 0
            const size = 36 / scale

            this.ctx.save()
            this.ctx.translate(
                drone.position.x + Math.sin(time / 18) * jitter,
                drone.position.y + Math.cos(time / 21) * jitter
            )
            this.ctx.rotate(drone.angle)
            this.ctx.shadowColor = progress > .65 ? "#ff5a36" : (drone.isA ? PLAYER_A_COLOR : PLAYER_B_COLOR)
            this.ctx.shadowBlur = (4 + progress * 10) / scale
            this.ctx.drawImage(image, -size / 2, -size / 2, size, size)
            this.ctx.restore()

            if (progress > .68) {
                this.ctx.save()
                this.ctx.translate(drone.position.x, drone.position.y)
                this.ctx.rotate(time / 260)
                this.ctx.globalAlpha = .4 + (progress - .68) / .32 * .5
                this.ctx.strokeStyle = "#ff713d"
                this.ctx.lineWidth = 2 / scale
                this.ctx.setLineDash([4 / scale, 5 / scale])
                this.ctx.beginPath()
                this.ctx.arc(0, 0, (20 + progress * 5) / scale, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.restore()
            }
        }
    }

    private drawReplayLaunches(time: number, scale: number) {
        const active: ReplayLaunch[] = []
        for (const launch of this.replayLaunches) {
            const progress = (time - launch.startedAt) / launch.duration
            if (progress < 0 || progress >= 1) continue
            active.push(launch)
            const eased = 1 - Math.pow(1 - progress, 3)
            this.ctx.save()
            this.ctx.globalAlpha = Math.pow(1 - progress, 2)
            this.ctx.strokeStyle = launch.color
            this.ctx.lineWidth = 3 / scale
            this.ctx.shadowColor = launch.color
            this.ctx.shadowBlur = 15 / scale
            this.ctx.beginPath()
            this.ctx.arc(launch.position.x, launch.position.y, (8 + eased * 40) / scale, 0, Math.PI * 2)
            this.ctx.stroke()
            for (let index = 0; index < 12; index++) {
                const angle = index * Math.PI * 2 / 12 + progress * 1.8
                const distance = (10 + eased * (28 + index % 3 * 6)) / scale
                this.ctx.fillStyle = index % 3 === 0 ? "#ffffff" : launch.color
                this.ctx.beginPath()
                this.ctx.arc(
                    launch.position.x + Math.cos(angle) * distance,
                    launch.position.y + Math.sin(angle) * distance,
                    (index % 3 === 0 ? 2.2 : 1.5) / scale,
                    0,
                    Math.PI * 2
                )
                this.ctx.fill()
            }
            this.ctx.restore()
        }
        this.replayLaunches = active
    }

    private drawReplayFactoryActions(game: GestionMonde, time: number, scale: number) {
        for (const drone of game.drones()) {
            const action = this.replayActions.get(drone.id)
            const fireTime = drone.cible?.fireTime ?? 0
            if (
                !action
                || (action.type !== "repair-factory" && action.type !== "capture-factory")
                || !(action.target instanceof Usine)
                || drone.cible?.cible !== action.target
                || fireTime <= 0
                || !game.entities.includes(action.target)
            ) continue

            const target = action.target
            const progress = Math.min(1, Math.max(0, 1 - fireTime / game.config.FIRE_TIME))
            const dx = target.position.x - drone.position.x
            const dy = target.position.y - drone.position.y
            const distance = Math.max(.001, Math.hypot(dx, dy))
            const ux = dx / distance
            const uy = dy / distance
            const startPadding = Math.min(distance * .18, 17 / scale)
            const endPadding = Math.min(distance * .22, 29 / scale)
            const startX = drone.position.x + ux * startPadding
            const startY = drone.position.y + uy * startPadding
            const endX = target.position.x - ux * endPadding
            const endY = target.position.y - uy * endPadding
            const repair = action.type === "repair-factory"
            const color = repair ? "#22b96f" : "#8a4be8"

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.globalAlpha = .72 + Math.sin(time / 95 + drone.position.x) * .2
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = (repair ? 4 : 3.5) / scale
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 12 / scale
            this.ctx.setLineDash(repair ? [3 / scale, 7 / scale] : [8 / scale, 6 / scale])
            this.ctx.lineDashOffset = (repair ? -1 : 1) * time / 40 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(startX, startY)
            this.ctx.lineTo(endX, endY)
            this.ctx.stroke()
            this.ctx.setLineDash([])

            for (let index = 0; index < 3; index++) {
                const packetProgress = (time / 700 + index / 3) % 1
                const x = startX + (endX - startX) * packetProgress
                const y = startY + (endY - startY) * packetProgress
                this.ctx.fillStyle = index === 1 ? "#ffffff" : color
                this.ctx.beginPath()
                this.ctx.arc(x, y, (2.5 + index % 2) / scale, 0, Math.PI * 2)
                this.ctx.fill()
            }

            this.ctx.globalAlpha = .92
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 2.5 / scale
            this.ctx.beginPath()
            this.ctx.arc(
                target.position.x,
                target.position.y,
                (repair ? 38 : 42) / scale,
                repair ? 0 : -Math.PI / 2,
                repair ? Math.PI * 2 : -Math.PI / 2 + Math.PI * 2 * progress
            )
            this.ctx.stroke()

            if (repair) {
                const plusY = target.position.y - 41 / scale
                const plusSize = 7 / scale
                this.ctx.strokeStyle = "#ffffff"
                this.ctx.lineWidth = 3.5 / scale
                this.ctx.beginPath()
                this.ctx.moveTo(target.position.x - plusSize, plusY)
                this.ctx.lineTo(target.position.x + plusSize, plusY)
                this.ctx.moveTo(target.position.x, plusY - plusSize)
                this.ctx.lineTo(target.position.x, plusY + plusSize)
                this.ctx.stroke()
            }
            this.ctx.restore()
        }
    }

    private drawReplayAttackLasers(game: GestionMonde, time: number, scale: number) {
        for (const drone of game.drones()) {
            const action = this.replayActions.get(drone.id)
            const fireTime = drone.cible?.fireTime ?? 0
            if (
                !action
                || (action.type !== "attack-drone" && action.type !== "attack-factory")
                || !(action.target instanceof Drone || action.target instanceof Usine)
                || drone.cible?.cible !== action.target
                || fireTime <= 0
            ) continue

            const target = action.target
            const targetPending = target instanceof Drone && this.replayPendingDestroyed.has(target.id)
            if (!game.entities.includes(target) && !targetPending) continue
            const dx = target.position.x - drone.position.x
            const dy = target.position.y - drone.position.y
            const distance = Math.hypot(dx, dy)
            if (distance > game.getDroneRange(drone.joueur) + .01) continue
            const progress = Math.min(1, Math.max(0, 1 - fireTime / game.config.FIRE_TIME))
            const beamProgress = progress * progress * (3 - 2 * progress)
            const beamX = drone.position.x + dx * beamProgress
            const beamY = drone.position.y + dy * beamProgress
            const color = drone.joueur === game.joueurA ? PLAYER_A_COLOR : PLAYER_B_COLOR
            const pulse = .82 + Math.sin(time / 42 + fireTime * .35) * .18

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.globalAlpha = pulse
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 8 / scale
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 18 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(drone.position.x, drone.position.y)
            this.ctx.lineTo(beamX, beamY)
            this.ctx.stroke()
            this.ctx.globalAlpha = 1
            this.ctx.strokeStyle = "#ffffff"
            this.ctx.lineWidth = 2.2 / scale
            this.ctx.shadowColor = "#ffffff"
            this.ctx.shadowBlur = 8 / scale
            this.ctx.stroke()

            const packet = (time / 170) % 1
            this.ctx.fillStyle = "#ffffff"
            this.ctx.beginPath()
            this.ctx.arc(
                drone.position.x + (beamX - drone.position.x) * packet,
                drone.position.y + (beamY - drone.position.y) * packet,
                3.2 / scale,
                0,
                Math.PI * 2
            )
            this.ctx.fill()

            if (beamProgress >= .96) {
                this.drawReplayHitEffect(time, scale, target, targetPending, color)
            }
            this.ctx.restore()
        }
    }

    private drawReplayHitEffect(
        time: number,
        scale: number,
        target: Drone | Usine,
        destroyed: boolean,
        color: string
    ) {
        const pulse = .7 + Math.sin(time / 34 + target.position.x * .1) * .25
        const radius = (12 + pulse * 5) / scale
        this.ctx.save()
        this.ctx.globalCompositeOperation = "screen"
        const flash = this.ctx.createRadialGradient(
            target.position.x,
            target.position.y,
            0,
            target.position.x,
            target.position.y,
            radius
        )
        flash.addColorStop(0, "rgba(255,255,255,.95)")
        flash.addColorStop(.32, destroyed ? "rgba(255,90,54,.72)" : "rgba(255,209,102,.6)")
        flash.addColorStop(1, "rgba(255,90,54,0)")
        this.ctx.fillStyle = flash
        this.ctx.beginPath()
        this.ctx.arc(target.position.x, target.position.y, radius, 0, Math.PI * 2)
        this.ctx.fill()
        this.ctx.globalCompositeOperation = "source-over"
        this.ctx.strokeStyle = destroyed ? "#ff5a36" : color
        this.ctx.lineWidth = 2 / scale
        this.ctx.shadowColor = destroyed ? "#ff5a36" : color
        this.ctx.shadowBlur = 9 / scale
        for (let index = 0; index < 8; index++) {
            const angle = time / 150 + index * Math.PI / 4
            const inner = 7 / scale
            const outer = (12 + index % 3 * 3) / scale
            this.ctx.beginPath()
            this.ctx.moveTo(target.position.x + Math.cos(angle) * inner, target.position.y + Math.sin(angle) * inner)
            this.ctx.lineTo(target.position.x + Math.cos(angle) * outer, target.position.y + Math.sin(angle) * outer)
            this.ctx.stroke()
        }
        this.ctx.restore()
    }

    private drawReplayExplosions(time: number, scale: number) {
        const active: ReplayExplosion[] = []
        for (const explosion of this.replayExplosions) {
            const progress = (time - explosion.startedAt) / explosion.duration
            if (progress < 0) {
                active.push(explosion)
                continue
            }
            if (progress >= 1) continue
            active.push(explosion)
            const haloProgress = Math.min(1, progress / .55)
            const haloRadius = (7 + 38 * (1 - Math.pow(1 - haloProgress, 3))) / scale

            this.ctx.save()
            this.ctx.globalAlpha = Math.pow(1 - haloProgress, 2) * .85
            this.ctx.strokeStyle = "#ffb347"
            this.ctx.lineWidth = 3 / scale
            this.ctx.shadowColor = "#ff713d"
            this.ctx.shadowBlur = 18 / scale
            this.ctx.beginPath()
            this.ctx.arc(explosion.position.x, explosion.position.y, haloRadius, 0, Math.PI * 2)
            this.ctx.stroke()
            if (progress < .22) {
                const flash = 1 - progress / .22
                const radius = (4 + progress * 55) / scale
                const gradient = this.ctx.createRadialGradient(
                    explosion.position.x,
                    explosion.position.y,
                    0,
                    explosion.position.x,
                    explosion.position.y,
                    radius
                )
                gradient.addColorStop(0, `rgba(255,255,255,${flash})`)
                gradient.addColorStop(.35, `rgba(255,196,92,${flash * .9})`)
                gradient.addColorStop(1, "rgba(255,80,40,0)")
                this.ctx.globalAlpha = 1
                this.ctx.fillStyle = gradient
                this.ctx.beginPath()
                this.ctx.arc(explosion.position.x, explosion.position.y, radius, 0, Math.PI * 2)
                this.ctx.fill()
            }
            this.ctx.restore()

            for (const particle of explosion.particles) {
                const particleProgress = (progress - particle.delay) / (1 - particle.delay)
                if (particleProgress < 0 || particleProgress >= 1) continue
                const travel = 1 - Math.pow(1 - particleProgress, 2)
                const distance = particle.speed * travel / scale
                const x = explosion.position.x + Math.cos(particle.angle) * distance
                const y = explosion.position.y
                    + Math.sin(particle.angle) * distance
                    + 30 * particleProgress * particleProgress / scale
                const alpha = Math.pow(1 - particleProgress, particle.kind === "smoke" ? 1.4 : 2)

                this.ctx.save()
                this.ctx.globalAlpha = alpha
                if (particle.kind === "smoke") {
                    this.ctx.fillStyle = particle.color
                    this.ctx.beginPath()
                    this.ctx.arc(x, y, particle.size * (1 + particleProgress * 2.2) / scale, 0, Math.PI * 2)
                    this.ctx.fill()
                } else if (particle.kind === "spark") {
                    const tail = (5 + particle.speed * .08) / scale
                    this.ctx.strokeStyle = particle.color
                    this.ctx.lineWidth = particle.size / scale
                    this.ctx.shadowColor = particle.color
                    this.ctx.shadowBlur = 7 / scale
                    this.ctx.beginPath()
                    this.ctx.moveTo(x - Math.cos(particle.angle) * tail, y - Math.sin(particle.angle) * tail)
                    this.ctx.lineTo(x, y)
                    this.ctx.stroke()
                } else {
                    this.ctx.translate(x, y)
                    this.ctx.rotate(particle.angle + particleProgress * 8)
                    this.ctx.fillStyle = particle.color
                    const size = particle.size / scale
                    this.ctx.fillRect(-size / 2, -size / 2, size, size * .65)
                }
                this.ctx.restore()
            }
        }
        this.replayExplosions = active
    }

    private drawDrone(game: GestionMonde, drone: Drone, scale: number) {
        const isA = drone.joueur === game.joueurA
        const image = isA ? this.images.droneA : this.images.droneB
        const target = drone.cible?.cible
        let angle = 0
        if (target instanceof GameElement) {
            angle = Math.atan2(target.position.y - drone.position.y, target.position.x - drone.position.x) + Math.PI / 2
        } else {
            const state = game.droneStates.find(value => value.ref === drone)
            if (state?.type === "move") angle = Math.atan2(state.sy, state.sx) + Math.PI / 2
        }
        const size = 36 / scale
        this.ctx.save()
        this.ctx.translate(drone.position.x, drone.position.y)
        this.ctx.rotate(angle)
        if (image.complete && image.naturalWidth > 0) this.ctx.drawImage(image, -size / 2, -size / 2, size, size)
        this.ctx.restore()
        this.ctx.fillStyle = isA ? PLAYER_A_COLOR : PLAYER_B_COLOR
        this.ctx.fillRect(drone.position.x - 9 / scale, drone.position.y + 17 / scale, 18 / scale, 13 / scale)
        this.ctx.fillStyle = "#fff"
        this.ctx.font = `900 ${10 / scale}px ui-monospace, monospace`
        this.ctx.textAlign = "center"
        this.ctx.textBaseline = "middle"
        this.ctx.fillText(isA ? "A" : "B", drone.position.x, drone.position.y + 23 / scale)
    }

    private drawImage(image: HTMLImageElement, x: number, y: number, size: number) {
        if (image.complete && image.naturalWidth > 0) this.ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
    }

    private closeReplay() {
        this.stopReplay()
        this.visualizationElement.hidden = true
        document.body.style.overflow = ""
    }

    private stopReplay() {
        if (this.replayRequestId !== undefined) cancelAnimationFrame(this.replayRequestId)
        this.replayRequestId = undefined
        if (this.replayStepInterval !== undefined) clearInterval(this.replayStepInterval)
        this.replayStepInterval = undefined
        this.replayWorkerA?.terminate()
        this.replayWorkerB?.terminate()
        this.replayWorkerA = undefined
        this.replayWorkerB = undefined
        this.replayGame = undefined
        this.replayPan = undefined
        this.replayPaused = false
        this.replayStepInFlight = false
        this.replayStepError = undefined
        if (this.replayContinueButton) this.replayContinueButton.hidden = true
        this.replayVisualTime = 0
        this.replayHovered = undefined
        this.replayDroneMemory.clear()
        this.replayFactoryOwners.clear()
        this.replayCooldowns.clear()
        this.replayActions.clear()
        this.replayPendingDestroyed.clear()
        this.replayExplosions = []
        this.replayLaunches = []
        this.updateReplayPauseButton()
        if (this.replayInspectorElement) {
            this.replayInspectorElement.hidden = true
            this.replayInspectorElement.replaceChildren()
        }
        if (this.canvas) delete this.canvas.dataset.panning
    }

    private setBusy(busy: boolean) {
        this.busy = busy
        this.rebuildButton.disabled = busy || this.levelBots.length === 0
        this.botSelect.disabled = busy || this.userBots.length === 0
        this.editBotButton.disabled = busy
        this.cancelButton.disabled = !busy
        this.updateProgressionControl()
    }

    private updateSelectedBotControl() {
        const botScript = this.botSelect.value
        this.progressRestoreRevision++
        this.currentProgressionLevelIndex = 0
        this.failure = undefined
        this.failureElement.hidden = true
        this.failureElement.classList.remove("success")
        this.editBotButton.disabled = Boolean(this.abortController)
        this.editBotButton.textContent = botScript
            ? `Modifier ${scriptName(botScript)}`
            : "Créer un bot"
        if (this.levels && !this.abortController) {
            const firstLevel = this.levels.levels[0]
            const levelCount = this.progressionLevelCount(botScript)
            this.showLevelProgress(0, levelCount, firstLevel?.powerCount ?? 0, "Prêt à jouer")
            this.detailElement.textContent = `${levelCount} niveaux de combat · ${this.levels.levels.length} paliers de pouvoir × ${this.levelBots.length} bots · ${this.levels.width} × ${this.levels.height}`
        }
        this.updateProgressionControl()
    }

    private updateProgressionControl() {
        const levelCount = this.progressionLevelCount()
        this.currentProgressionLevelIndex = Math.max(
            0,
            Math.min(Math.max(0, levelCount - 1), this.currentProgressionLevelIndex)
        )
        this.launchButton.textContent = `Jouer le niveau ${this.currentProgressionLevelIndex + 1}`
        this.launchButton.disabled = this.busy
            || !this.levels
            || this.userBots.length === 0
            || levelCount === 0
    }

    private async runProgressionLevel(levelIndex = this.currentProgressionLevelIndex) {
        const levelCount = this.progressionLevelCount()
        if (levelCount === 0) {
            this.setStatus("Aucun niveau disponible pour ce bot.", true)
            return
        }
        this.currentProgressionLevelIndex = Math.max(0, Math.min(levelCount - 1, Math.trunc(levelIndex)))
        this.updateProgressionControl()
        await this.queueProgrammingProgress(
            this.botSelect.value,
            this.currentProgressionLevelIndex,
            false
        )
        if (this.destroyed) return
        await this.runSelectedBot(this.currentProgressionLevelIndex)
    }

    private progressionLevelCount(botScript = this.botSelect.value) {
        if (!this.levels) return 0
        return gameProgressionLevelCount(this.levels, botScript)
    }

    private progressionLevelAt(botScript: string, progressionLevelIndex: number) {
        if (!this.levels) return undefined
        let currentIndex = 0
        for (const level of this.levels.levels) {
            for (const opponentScript of level.ranking.filter(script => script !== botScript)) {
                if (currentIndex === progressionLevelIndex) {
                    return { powerCount: level.powerCount, opponentScript }
                }
                currentIndex++
            }
        }
        return undefined
    }

    private showLevelProgress(
        levelIndex: number,
        levelCount: number,
        powerCount: number,
        detail: string
    ) {
        const safeCount = Math.max(0, levelCount)
        const displayedIndex = safeCount === 0
            ? 0
            : Math.min(safeCount, Math.max(1, levelIndex + 1))
        this.levelElement.innerHTML = `
            <span>Progression</span>
            <strong>Niveau ${displayedIndex}/${safeCount}</strong>
            <small>${powerCount} pouvoir${powerCount > 1 ? "s" : ""} · ${escapeHtml(detail)}</small>
        `
    }

    private showLevelPreparation(
        powerIndex: number,
        powerCount: number,
        enabledPowerCount: number,
        detail: string
    ) {
        const progressionLevelCount = powerCount * this.levelBots.length
        this.levelElement.innerHTML = `
            <span>Préparation des ${progressionLevelCount} niveaux</span>
            <strong>Palier de pouvoir ${powerIndex + 1}/${powerCount}</strong>
            <small>${enabledPowerCount} pouvoir${enabledPowerCount > 1 ? "s" : ""} · ${escapeHtml(detail)}</small>
        `
    }

    private failureLevelLabel(failure: BatchFailure) {
        return `Niveau ${failure.levelIndex + 1}/${failure.levelCount} · ${failure.powerCount} pouvoir${failure.powerCount > 1 ? "s" : ""}`
    }

    private setStatus(message: string, error = false) {
        this.statusElement.textContent = message
        this.statusElement.style.color = error ? "#a3253c" : "#42516a"
    }

    private async openManualGame() {
        this.destroy()
        const marker = globalThis as typeof globalThis & { __algofightSkipAutoInstall?: boolean }
        marker.__algofightSkipAutoInstall = true
        try {
            const { installManualGame } = await import("./game-manual")
            installManualGame(document.body)
        } finally {
            delete marker.__algofightSkipAutoInstall
        }
    }

    private async openSelectedBotEditor(
        botScript = this.botSelect.value
    ) {
        try {
            const { installBotsDev } = await import("./bots-dev")
            const levels = this.levels
            const resumeLevelIndex = this.failure?.levelIndex ?? this.currentProgressionLevelIndex
            let originalSource: string | undefined
            if (botScript) {
                try {
                    originalSource = await readSource(botScript)
                } catch {
                    // En cas d'échec de lecture, le retour proposera les deux reprises par sécurité.
                }
            }
            this.destroy()
            await installBotsDev(document.body, async () => {
                let sourceChanged = Boolean(botScript)
                if (botScript && originalSource !== undefined) {
                    try {
                        sourceChanged = await readSource(botScript) !== originalSource
                    } catch {
                        sourceChanged = true
                    }
                }
                installGame(document.body, botScript ? {
                    selectedBot: botScript,
                    ...(sourceChanged && levels
                        ? { initialLevels: levels, editedBotResumeLevel: resumeLevelIndex }
                        : {})
                } : {})
            }, botScript ? {
                initialFile: botScript,
                focusedFile: true,
                backLabel: "Enregistrer et retourner au jeu"
            } : {
                backLabel: "Retour au mode progression"
            })
        } catch (error) {
            this.setStatus(`Impossible d’ouvrir l’éditeur : ${this.errorMessage(error)}`, true)
        }
    }

    private showBotEditChoice(requestedResumeLevelIndex: number) {
        const levelCount = this.progressionLevelCount()
        if (levelCount === 0) return
        const resumeLevelIndex = Math.max(0, Math.min(
            levelCount - 1,
            Math.trunc(requestedResumeLevelIndex)
        ))
        const overlay = document.createElement("section")
        overlay.className = "program-edit-choice"
        overlay.setAttribute("role", "dialog")
        overlay.setAttribute("aria-modal", "true")
        overlay.innerHTML = `
            <div class="program-edit-choice-card">
                <h2>Bot modifié et enregistré</h2>
                <p>Voulez-vous réévaluer la progression depuis le niveau atteint ou recommencer tous les combats depuis le début ?</p>
                <div class="program-edit-choice-actions">
                    <button class="program-button primary" data-choice="resume">Reprendre au niveau ${resumeLevelIndex + 1}</button>
                    <button class="program-button" data-choice="restart">Tout recommencer au niveau 1</button>
                </div>
            </div>
        `
        const choose = (levelIndex: number) => {
            overlay.querySelectorAll<HTMLButtonElement>("button")
                .forEach(button => button.disabled = true)
            overlay.remove()
            this.currentProgressionLevelIndex = levelIndex
            this.updateProgressionControl()
            void this.runProgressionLevel(levelIndex)
        }
        overlay.querySelector<HTMLButtonElement>("[data-choice=resume]")
            ?.addEventListener("click", () => choose(resumeLevelIndex))
        overlay.querySelector<HTMLButtonElement>("[data-choice=restart]")
            ?.addEventListener("click", () => choose(0))
        this.root.append(overlay)
    }

    private errorMessage(error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const compact = message.replace(/\s+/g, " ").trim()
        return compact.length > 260 ? `${compact.slice(0, 257)}…` : compact
    }

    private handleResize = () => {
        if (!this.visualizationElement?.hidden) this.drawReplay()
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.abortController?.abort()
        this.stopReplay()
        window.removeEventListener("resize", this.handleResize)
        document.body.style.overflow = ""
    }
}

let currentGame: AlgoFightProgrammingGame | undefined

export function installGame(
    container: HTMLElement = document.body,
    options: ProgrammingGameOptions = {}
) {
    currentGame?.destroy()
    const game = new AlgoFightProgrammingGame(options)
    container.replaceChildren(game.createInterface())
    game.init()
    currentGame = game
    return game
}

function installInBody() {
    installGame(document.body)
}

if (typeof document !== "undefined") {
    const marker = globalThis as typeof globalThis & { __algofightSkipAutoInstall?: boolean }
    if (!marker.__algofightSkipAutoInstall) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", installInBody, { once: true })
        } else {
            installInBody()
        }
    }
}
