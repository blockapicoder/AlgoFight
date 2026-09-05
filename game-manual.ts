import {
    DEFAULT_CONFIG,
    type Config,
    Drone,
    Energie,
    Element as GameElement,
    Joueur,
    type Log as BotState,
    Position,
    type SetTargetRef,
    Technologie,
    Usine,
    Vie
} from "./algofight-entity-model"
import {
    isGeneratedBotSourcePath,
    listBotsScript
} from "./bots-script-tools"
import { entityToJsonData, type JsonData } from "./entity-model"
import {
    GAME_LEVELS_SOURCE as CAMPAIGN_LEVELS_SOURCE,
    GAME_POWER_LEVELS as CAMPAIGN_POWER_LEVELS,
    GAME_PROGRESS_SOURCE as CAMPAIGN_PROGRESS_SOURCE,
    createSymmetricLevelWorld,
    gameBotSignature,
    gameProgressionLevelCount,
    levelConfig,
    readGameLevels,
    readGameProgress,
    writeGameLevels,
    writeGameProgress,
    type GameLevelData as CampaignLevel,
    type GameLevelsData as CampaignLevelsFile,
    type GameProgressData as CampaignProgressFile
} from "./game-batch"
import { GestionMonde, type CombatResult } from "./gestion-algofight-entity-model"

type PlayerKey = "A" | "B"
type WorkerState = "offline" | "loading" | "active" | "error" | "pending" | "winner" | "loser" | "draw"
type DroneIntent = "idle" | "attack" | "collect" | "repair" | "capture"
type ResourceSpriteState = "energy" | "life"
type DroneVisualActionType =
    | "attack-drone"
    | "attack-factory"
    | "collect-energy"
    | "collect-life"
    | "repair-factory"
    | "capture-factory"

interface ActiveDroneAction {
    type: DroneVisualActionType
    target: Drone | Usine | Energie | Vie
}

interface CanvasView {
    scale: number
    offsetX: number
    offsetY: number
}

interface CanvasInput {
    clientX: number
    clientY: number
    pointerType?: string
}

interface CanvasGesture {
    id: number | string
    pointerType: string
    startX: number
    startY: number
    lastX: number
    lastY: number
    dragging: boolean
}

interface ManualQueuedTarget {
    targetId: string
    position: Position
    label: string
}

interface WorldMemory {
    drones: Map<string, RememberedDrone>
    usineOwners: Map<string, string | undefined>
}

interface RememberedDrone {
    ref: Drone
    position: Position
    color: string
    angle: number
}

interface ExplosionParticle {
    angle: number
    speed: number
    size: number
    delay: number
    rotation: number
    rotationSpeed: number
    color: string
    kind: "spark" | "fragment" | "smoke"
}

interface DroneExplosion {
    position: Position
    startedAt: number
    duration: number
    particles: ExplosionParticle[]
}

interface DroneLaunchAnimation {
    position: Position
    color: string
    startedAt: number
    duration: number
}

interface TournamentStanding {
    script: string
    played: number
    wins: number
    draws: number
    losses: number
    points: number
    dronesFor: number
    dronesAgainst: number
}

interface TournamentOutcome {
    winner: PlayerKey | "draw"
    tick: number
    droneCountA: number
    droneCountB: number
    reason: "elimination" | "time" | "worker-error"
}

interface CampaignSave {
    version: 2
    botSignature: string
    width: number
    height: number
    levels: CampaignLevel[]
    levelIndex: number
    opponentIndex: number
    completed: boolean
}

const PLAYER_A_COLOR = "#37e686"
const PLAYER_B_COLOR = "#4f86ff"
const NEUTRAL_COLOR = "#8691aa"
const TOURNAMENT_STEP_BATCH = 50
const MANUAL_CONTROLLER = "__manual__"
const DRONE_APPEARANCES = {
    scout: {
        label: "Éclaireur",
        url: new URL("./assets/drones/16bit/idle.png", import.meta.url).href
    },
    striker: {
        label: "Intercepteur",
        url: new URL("./assets/drones/16bit/attack.png", import.meta.url).href
    },
    carrier: {
        label: "Collecteur",
        url: new URL("./assets/drones/16bit/collect.png", import.meta.url).href
    },
    sentinel: {
        label: "Sentinelle",
        url: new URL("./assets/drones/16bit/capture.png", import.meta.url).href
    },
    engineer: {
        label: "Ingénieur",
        url: new URL("./assets/drones/16bit/repair.png", import.meta.url).href
    }
} as const
type DroneAppearance = keyof typeof DRONE_APPEARANCES
const DEFAULT_DRONE_APPEARANCE: Record<PlayerKey, DroneAppearance> = {
    A: "engineer",
    B: "striker"
}
const FACTORY_SPRITE_URLS = {
    idle: new URL("./assets/factories/16bit/factory-idle.png", import.meta.url).href,
    building: new URL("./assets/factories/16bit/factory-building.png", import.meta.url).href
} as const
type FactorySpriteState = keyof typeof FACTORY_SPRITE_URLS
const RESOURCE_SPRITE_URLS: Record<ResourceSpriteState, string> = {
    energy: new URL("./assets/resources/16bit/energy.png", import.meta.url).href,
    life: new URL("./assets/resources/16bit/life.png", import.meta.url).href
}
const TECHNOLOGIES: readonly Technologie[] = [
    "Population",
    "Vitesse",
    "Porte",
    "Transport",
    "Puissance"
]
const TECHNOLOGY_VISUALS: Record<Technologie, { label: string; effect: string; color: string; url: string }> = {
    Population: {
        label: "Population",
        effect: `+${DEFAULT_CONFIG.POPULATION_FACTOR} drones maximum · production -${DEFAULT_CONFIG.BUILD_FACTOR} ticks`,
        color: "#ff55df",
        url: new URL("./assets/technologies/16bit/population.png", import.meta.url).href
    },
    Vitesse: {
        label: "Vitesse",
        effect: "+2 vitesse",
        color: "#26dfff",
        url: new URL("./assets/technologies/16bit/speed.png", import.meta.url).href
    },
    Porte: {
        label: "Portée",
        effect: "+10 de portée",
        color: "#b36cff",
        url: new URL("./assets/technologies/16bit/range.png", import.meta.url).href
    },
    Transport: {
        label: "Transport",
        effect: "+1 ressource transportée",
        color: "#ffad32",
        url: new URL("./assets/technologies/16bit/transport.png", import.meta.url).href
    },
    Puissance: {
        label: "Puissance",
        effect: "+1 dégât",
        color: "#ff553d",
        url: new URL("./assets/technologies/16bit/power.png", import.meta.url).href
    }
}

function shortId(id: string) {
    return id.slice(0, 7)
}

function scriptName(path: string) {
    return (path.split("/").filter(Boolean).at(-1) ?? path).replace(/\.ts$/i, "")
}

function scriptWorkerUrl(path: string, player: PlayerKey) {
    const javascriptPath = path.replace(/\.ts$/i, ".js")
    const separator = javascriptPath.includes("?") ? "&" : "?"
    return `${javascriptPath}${separator}player=${player}&t=${Date.now()}`
}

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
        return '<div class="game-bot-state-empty">Aucune information transmise</div>'
    }
    return entries
        .map(([key, value]) => `
            <label class="game-bot-state-field">
                <span title="${escapeHtml(key)}">${escapeHtml(key)}</span>
                <output>${escapeHtml(value)}</output>
            </label>
        `)
        .join("")
}

function droneAppearanceOptions(selected: DroneAppearance) {
    return (Object.entries(DRONE_APPEARANCES) as [DroneAppearance, typeof DRONE_APPEARANCES[DroneAppearance]][])
        .map(([key, appearance]) => `
            <option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(appearance.label)}</option>
        `)
        .join("")
}

export class AlgoFightManualGame {
    root!: HTMLDivElement
    canvas!: HTMLCanvasElement
    private ctx!: CanvasRenderingContext2D
    private gestionMonde!: GestionMonde

    private widthInput!: HTMLInputElement
    private heightInput!: HTMLInputElement
    private speedInput!: HTMLInputElement
    private speedValue!: HTMLElement
    private botASelect!: HTMLSelectElement
    private botBSelect!: HTMLSelectElement
    private droneAppearanceASelect!: HTMLSelectElement
    private droneAppearanceBSelect!: HTMLSelectElement
    private droneAppearancePreviewA!: HTMLImageElement
    private droneAppearancePreviewB!: HTMLImageElement
    private botAState!: HTMLElement
    private botBState!: HTMLElement
    private statusElement!: HTMLElement
    private scoreElement!: HTMLElement
    private statsElement!: HTMLElement
    private inspectorModalElement!: HTMLElement
    private inspectorElement!: HTMLElement
    private eventsElement!: HTMLElement
    private hudAElement!: HTMLElement
    private hudBElement!: HTMLElement
    private hudUpgradesAElement!: HTMLElement
    private hudUpgradesBElement!: HTMLElement
    private hudBotStateAElement!: HTMLElement
    private hudBotStateBElement!: HTMLElement
    private hudTimeElement!: HTMLElement
    private hudTimeLabelElement!: HTMLElement
    private selectedDroneInfoElement!: HTMLElement
    private startButton!: HTMLButtonElement
    private tournamentButton!: HTMLButtonElement
    private campaignButton!: HTMLButtonElement
    private campaignResetButton!: HTMLButtonElement
    private restartButton!: HTMLButtonElement
    private continueButton!: HTMLButtonElement
    private targetToggleButton!: HTMLButtonElement
    private zoomResetButton!: HTMLButtonElement
    private manualDroneListElement!: HTMLElement
    private manualDroneCountElement!: HTMLElement
    private retargetableDroneListElement!: HTMLElement
    private retargetableDroneCountElement!: HTMLElement
    private sequenceResetButton!: HTMLButtonElement
    private campaignHudElement!: HTMLElement
    private tournamentTitleElement!: HTMLElement
    private tournamentSubtitleElement!: HTMLElement
    private tournamentProgressElement!: HTMLElement
    private tournamentCurrentElement!: HTMLElement
    private tournamentTableElement!: HTMLElement
    private tournamentResultsElement!: HTMLElement
    private tournamentExitButton!: HTMLButtonElement

    private workerA?: Worker
    private workerB?: Worker
    private workerGeneration = 0
    private responseCountA = 0
    private responseCountB = 0
    private botsLoaded = false
    private botScripts: string[] = []
    private botSignature = ""
    private tournamentRunId = 0
    private tournamentRunning = false
    private campaignEvaluating = false
    private campaignActive = false
    private campaign?: CampaignSave
    private campaignSaving = false

    private worldWidth = 1200
    private worldHeight = 720
    private tick = 0
    private running = false
    private manualTurnPaused = false
    private requestId?: number
    private lastFrame = 0
    private accumulator = 0
    private stepInFlight = false
    private lastUiUpdate = 0
    private view: CanvasView = { scale: 1, offsetX: 0, offsetY: 0 }
    private zoom = 1
    private camera: Position = { x: this.worldWidth / 2, y: this.worldHeight / 2 }
    private showManualTargets = false
    private manualDroneListSignature = ""
    private canvasGesture?: CanvasGesture
    private manualTargetQueues = new Map<string, ManualQueuedTarget[]>()
    private hovered?: GameElement
    private manualPlayer?: PlayerKey
    private manualSelectedDrone?: Drone
    private manualSelectedFactory?: Usine
    private memory: WorldMemory = { drones: new Map(), usineOwners: new Map() }
    private cooldownByDrone = new Map<string, number>()
    private activeDroneActions = new Map<string, ActiveDroneAction>()
    private pendingDroneDestructions = new Map<string, RememberedDrone>()
    private explosions: DroneExplosion[] = []
    private launches: DroneLaunchAnimation[] = []
    private droneSprite?: HTMLImageElement
    private droneSprites = new Map<DroneAppearance, HTMLImageElement>()
    private playerDroneSprites = new Map<PlayerKey, HTMLImageElement>()
    private factorySprites = new Map<FactorySpriteState, HTMLImageElement>()
    private resourceSprites = new Map<ResourceSpriteState, HTMLImageElement>()
    private technologySprites = new Map<Technologie, HTMLImageElement>()
    private spriteLoadPromise: Promise<void> = Promise.resolve()
    private events: string[] = []
    private previousBodyOverflow?: string
    private manualHelpElement!: HTMLElement

    constructor() {}

    createInterface() {
        const manualMode = true
        this.root = document.createElement("div")
        this.root.className = "algofight-game"
        this.root.dataset.mode = "lobby"
        this.root.dataset.gameMode = "manual"
        this.root.innerHTML = `
            <style>
                .algofight-game {
                    --background: #e5e8ec;
                    --surface: #f8f9fb;
                    --surface-2: #eef1f4;
                    --border: rgba(48, 60, 78, .24);
                    --text: #182234;
                    --muted: #5d697c;
                    --a: ${PLAYER_A_COLOR};
                    --b: ${PLAYER_B_COLOR};
                    min-height: 100vh;
                    width: 100%;
                    padding: 16px;
                    box-sizing: border-box;
                    color: var(--text);
                    background:
                        radial-gradient(circle at 10% 0, rgba(56, 160, 220, .13), transparent 28%),
                        radial-gradient(circle at 90% 0, rgba(120, 135, 180, .12), transparent 28%),
                        var(--background);
                    font: 17px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
                }
                .algofight-game * { box-sizing: border-box; }
                .game-appearance-preview,
                .game-hud-upgrade img,
                .game-tech img {
                    image-rendering: crisp-edges;
                    image-rendering: pixelated;
                }
                .game-header, .game-controls, .game-panel, .game-arena, .game-events {
                    border: 1px solid var(--border);
                    background: rgba(248, 249, 251, .96);
                    box-shadow: 0 12px 30px rgba(34, 44, 60, .12);
                }
                .game-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 20px;
                    padding: 16px 19px;
                    border-radius: 15px 15px 0 0;
                }
                .game-title { font-size: 27px; font-weight: 900; letter-spacing: .04em; }
                .game-subtitle { margin-top: 2px; color: var(--muted); font-size: 16px; }
                .game-score { display: flex; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
                .game-chip {
                    padding: 7px 10px;
                    border: 1px solid var(--border);
                    border-radius: 999px;
                    color: var(--muted);
                    background: rgba(255, 255, 255, .7);
                    font-size: 15px;
                }
                .game-chip strong { color: var(--text); }
                .game-controls {
                    display: flex;
                    align-items: center;
                    gap: 9px;
                    flex-wrap: wrap;
                    padding: 10px 13px;
                    margin-bottom: 13px;
                    border-top: 0;
                    border-radius: 0 0 15px 15px;
                }
                .game-field { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 15px; }
                .game-input, .game-select {
                    min-width: 0;
                    padding: 8px 9px;
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    outline: none;
                    color: var(--text);
                    background: #ffffff;
                    font: inherit;
                }
                .game-input[type=number] { width: 82px; }
                .game-input[type=range] { width: 120px; padding: 0; accent-color: #6678ff; }
                .game-button {
                    min-height: 44px;
                    padding: 8px 12px;
                    border: 1px solid var(--border);
                    border-radius: 9px;
                    color: var(--text);
                    background: linear-gradient(180deg, #ffffff, #e4e8ee);
                    font-family: inherit;
                    font-size: 15px;
                    font-weight: 800;
                    cursor: pointer;
                    touch-action: manipulation;
                }
                .game-input, .game-select { min-height: 44px; touch-action: manipulation; }
                .game-button:hover { border-color: #7e91c5; transform: translateY(-1px); }
                .game-button.primary { color: #fff; background: linear-gradient(180deg, #6173ff, #3d4fd4); }
                .game-button:disabled { cursor: wait; opacity: .55; transform: none; }
                .game-button[hidden] { display: none; }
                .game-layout {
                    display: grid;
                    grid-template-columns: minmax(285px, 325px) minmax(500px, 1fr) minmax(270px, 325px);
                    gap: 13px;
                    align-items: stretch;
                }
                .game-panel { padding: 14px; border-radius: 13px; background: rgba(248, 249, 251, .98); }
                .game-panel h2, .game-panel h3 {
                    margin: 0 0 11px;
                    color: #42516a;
                    font-size: 15px;
                    letter-spacing: .12em;
                    text-transform: uppercase;
                }
                .game-bot-card {
                    margin-bottom: 11px;
                    padding: 12px;
                    border: 1px solid var(--border);
                    border-radius: 11px;
                    background: #ffffff;
                }
                .game-bot-card.a { border-left: 4px solid var(--a); }
                .game-bot-card.b { border-left: 4px solid var(--b); }
                .game-bot-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 9px; font-weight: 900; }
                .game-appearance-picker {
                    display: grid;
                    grid-template-columns: 62px minmax(0, 1fr);
                    align-items: center;
                    gap: 10px;
                    margin-top: 10px;
                    padding-top: 10px;
                    border-top: 1px solid rgba(143, 164, 211, .14);
                }
                .game-appearance-preview {
                    display: block;
                    width: 58px;
                    height: 58px;
                    object-fit: contain;
                }
                .game-appearance-preview { filter: drop-shadow(0 0 5px rgba(220, 232, 255, .34)); }
                .game-appearance-picker label { color: var(--muted); font-size: 14px; }
                .game-worker-state {
                    padding: 4px 7px;
                    border-radius: 999px;
                    color: var(--muted);
                    background: rgba(134, 145, 170, .14);
                    font-size: 13px;
                    text-transform: uppercase;
                }
                .game-worker-state[data-state=active] { color: #087747; background: rgba(20, 145, 88, .12); }
                .game-worker-state[data-state=loading], .game-worker-state[data-state=pending] { color: #8a6100; }
                .game-worker-state[data-state=error] { color: #b4233c; background: rgba(190, 40, 68, .1); }
                .game-worker-state[data-state=winner] { color: #087747; background: rgba(20, 145, 88, .14); }
                .game-worker-state[data-state=loser] { color: #b4233c; background: rgba(190, 40, 68, .1); }
                .game-worker-state[data-state=draw] { color: #8a6100; background: rgba(180, 125, 0, .1); }
                .game-select { width: 100%; margin-top: 5px; }
                .game-fixed-controller {
                    padding: 9px 10px;
                    border: 1px solid rgba(55, 230, 134, .36);
                    border-radius: 8px;
                    color: #087747;
                    background: rgba(20, 145, 88, .08);
                    font-weight: 900;
                }
                .game-start { width: 100%; padding: 12px; margin-top: 2px; font-size: 16px; }
                .game-status {
                    min-height: 52px;
                    margin-top: 11px;
                    padding: 10px;
                    border-radius: 9px;
                    color: var(--muted);
                    background: rgba(45, 57, 75, .07);
                }
                .game-arena { position: relative; min-height: 650px; overflow: hidden; border-radius: 13px; background: #c8cdd4; }
                .game-canvas {
                    display: block;
                    width: 100%;
                    height: 650px;
                    -webkit-touch-callout: none;
                    -webkit-user-select: none;
                    user-select: none;
                }
                .game-canvas[data-manual=true] { cursor: grab; touch-action: none; }
                .game-canvas[data-panning=true] { cursor: grabbing; }
                .game-manual-help {
                    position: absolute;
                    right: 246px;
                    bottom: 16px;
                    left: 16px;
                    z-index: 6;
                    padding: 10px 14px;
                    border: 2px solid #536178;
                    border-radius: 8px;
                    color: #182234;
                    background: rgba(255, 255, 255, .94);
                    box-shadow: 3px 3px 0 rgba(35, 47, 65, .24);
                    font-size: 16px;
                    font-weight: 900;
                    text-align: center;
                    pointer-events: none;
                }
                .game-manual-help[data-state=selected] { border-color: #6173ff; color: #283ab8; }
                .game-manual-help[data-state=success] { border-color: #20a864; color: #087747; }
                .game-manual-help[data-state=error] { border-color: #cf334f; color: #a31d36; }
                .game-hud {
                    position: absolute;
                    inset: 14px 14px auto;
                    z-index: 3;
                    display: none;
                    grid-template-columns: minmax(150px, 1fr) auto minmax(150px, 1fr) minmax(180px, auto) auto auto;
                    align-items: center;
                    gap: 10px;
                    pointer-events: none;
                }
                .game-hud-card {
                    min-width: 0;
                    padding: 10px 14px;
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    background: rgba(255, 255, 255, .93);
                    box-shadow: 0 7px 20px rgba(32, 43, 60, .14);
                    backdrop-filter: blur(8px);
                }
                .game-hud-card.a { border-left: 4px solid var(--a); }
                .game-hud-card.b { border-right: 4px solid var(--b); text-align: right; }
                .game-hud-card span, .game-hud-time span {
                    display: block;
                    color: var(--muted);
                    font-size: 13px;
                    font-weight: 800;
                    letter-spacing: .1em;
                    text-transform: uppercase;
                }
                .game-hud-card strong { display: block; margin-top: 2px; font-size: 20px; }
                .game-hud-upgrades {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    flex-wrap: wrap;
                    margin-top: 7px;
                }
                .game-hud-card.b .game-hud-upgrades { justify-content: flex-end; }
                .game-hud-upgrade {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 3px 6px;
                    border: 1px solid rgba(143, 164, 211, .2);
                    border-radius: 6px;
                    color: #71809e;
                    background: rgba(55, 68, 88, .07);
                    font-size: 12px;
                    font-weight: 800;
                    line-height: 1.1;
                    letter-spacing: .02em;
                    white-space: nowrap;
                }
                .game-hud-upgrade img { width: 19px; height: 19px; object-fit: contain; }
                .game-hud-upgrade b { color: #8795b2; font-size: 14px; }
                .game-hud-upgrade[data-enabled=false] { opacity: .45; filter: grayscale(1); }
                .game-hud-card.a .game-hud-upgrade[data-active=true] { color: #08643b; border-color: ${PLAYER_A_COLOR}99; background: ${PLAYER_A_COLOR}20; }
                .game-hud-card.a .game-hud-upgrade[data-active=true] b { color: var(--a); }
                .game-hud-card.b .game-hud-upgrade[data-active=true] { color: #244eaa; border-color: ${PLAYER_B_COLOR}99; background: ${PLAYER_B_COLOR}20; }
                .game-hud-card.b .game-hud-upgrade[data-active=true] b { color: var(--b); }
                .game-bot-state {
                    display: grid;
                    gap: 5px;
                    max-height: 130px;
                    margin-top: 8px;
                    overflow-y: auto;
                }
                .game-bot-state-field {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(52px, auto);
                    align-items: center;
                    gap: 8px;
                    padding: 5px 7px;
                    border: 1px solid rgba(48, 60, 78, .2);
                    border-radius: 6px;
                    background: #fff;
                }
                .game-bot-state-field span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 13px; font-weight: 900; letter-spacing: normal; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
                .game-bot-state-field output { color: var(--text); font: 900 14px/1.2 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; text-align: right; }
                .game-hud-card.b .game-bot-state-field { text-align: left; }
                .game-bot-state-empty { padding: 6px; border: 1px dashed rgba(48, 60, 78, .25); border-radius: 6px; color: var(--muted); font-size: 12px; font-weight: 800; text-align: center; }
                .game-hud-time { min-width: 150px; text-align: center; }
                .game-hud-time strong { display: block; color: var(--text); font: 900 27px/1 ui-monospace, monospace; }
                .game-campaign-hud {
                    display: block;
                    max-width: 260px;
                    margin-top: 6px;
                    color: #3d4fd4;
                    font-size: 12px;
                    font-weight: 900;
                    line-height: 1.25;
                }
                .game-campaign-hud[hidden] { display: none; }
                .game-hud .game-button { padding: 11px 15px; pointer-events: auto; }
                .game-selected-drone-info {
                    min-width: 180px;
                    padding: 8px 11px;
                    border: 2px solid #536178;
                    border-radius: 9px;
                    background: #fff;
                    box-shadow: 3px 3px 0 rgba(35, 47, 65, .18);
                    font-size: 15px;
                    line-height: 1.35;
                    pointer-events: auto;
                }
                .game-selected-drone-info[hidden] { display: none; }
                .game-selected-drone-info strong { display: block; color: #26334a; font-size: 16px; }
                .game-selected-drone-info span { display: inline-block; margin-right: 10px; font-weight: 800; }
                .game-continue { min-width: 150px; font-size: 16px; font-weight: 900; }
                .game-continue:disabled { cursor: not-allowed; }
                .game-inspector-panel {
                    z-index: 4;
                    min-width: 0;
                    min-height: 0;
                    padding: 16px 13px;
                    overflow-y: auto;
                    border-right: 2px solid rgba(48, 60, 78, .24);
                    color: var(--text);
                    background: #f4f6f8;
                    pointer-events: auto;
                }
                .game-inspector-modal {
                    position: absolute;
                    top: 14px;
                    left: 14px;
                    z-index: 9;
                    width: min(360px, calc(100% - 28px));
                    max-height: calc(100% - 28px);
                    padding: 12px;
                    overflow-y: auto;
                    border: 2px solid rgba(48, 60, 78, .32);
                    border-radius: 12px;
                    color: var(--text);
                    background: rgba(244, 246, 248, .97);
                    box-shadow: 6px 7px 0 rgba(35, 47, 65, .2);
                    pointer-events: none;
                }
                .game-inspector-modal[hidden] { display: none; }
                .game-inspector-title {
                    margin-bottom: 12px;
                    color: #26334a;
                    font-size: 14px;
                    font-weight: 900;
                    letter-spacing: .1em;
                    text-transform: uppercase;
                }
                .game-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
                .game-kpi { padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: rgba(54, 67, 87, .06); }
                .game-kpi span { display: block; color: var(--muted); font-size: 13px; text-transform: uppercase; }
                .game-kpi strong { display: block; margin-top: 2px; font-size: 21px; }
                .game-player-stats { margin-top: 11px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; }
                .game-player-stats.a { border-left: 3px solid var(--a); }
                .game-player-stats.b { border-left: 3px solid var(--b); }
                .game-player-title { display: flex; justify-content: space-between; font-weight: 900; }
                .game-small-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 8px; }
                .game-small-grid div { padding: 6px; border-radius: 6px; color: var(--muted); background: rgba(54, 67, 87, .07); font-size: 13px; }
                .game-small-grid strong { display: block; color: var(--text); font-size: 17px; }
                .game-tech { width: 100%; margin-top: 7px; border-collapse: collapse; font-size: 14px; }
                .game-tech td { padding: 4px 2px; border-top: 1px solid rgba(143, 164, 211, .12); }
                .game-tech td:last-child { text-align: right; font-weight: 900; }
                .game-inspector {
                    min-height: 120px;
                    padding: 13px 12px;
                    border: 1px solid var(--border);
                    border-left: 5px solid #7d8795;
                    border-radius: 10px;
                    color: var(--muted);
                    background: #fff;
                    box-shadow: 3px 3px 0 rgba(35, 47, 65, .13);
                    font-size: 16px;
                    line-height: 1.45;
                    overflow-wrap: anywhere;
                }
                .game-inspector[data-owner=A] { border-left-color: var(--a); }
                .game-inspector[data-owner=B] { border-left-color: var(--b); }
                .game-inspector[data-kind=energy] { border-left-color: #ff9f1c; }
                .game-inspector[data-kind=life] { border-left-color: #20b987; }
                .game-inspector strong { display: block; margin-bottom: 10px; color: var(--text); font-size: 18px; line-height: 1.25; }
                .game-inspector-grid { display: grid; gap: 7px; }
                .game-inspector-row {
                    display: flex;
                    justify-content: space-between;
                    gap: 8px;
                    padding-bottom: 6px;
                    border-bottom: 1px solid rgba(48, 60, 78, .12);
                }
                .game-inspector-row:last-child { padding-bottom: 0; border-bottom: 0; }
                .game-inspector-row span { color: var(--muted); }
                .game-inspector-row b { color: var(--text); text-align: right; }
                .game-inspector-actions { display: grid; gap: 8px; margin-bottom: 14px; }
                .game-inspector-actions .game-button { width: 100%; padding: 8px 9px; font-size: 14px; }
                .game-drone-list-section { margin-top: 16px; }
                .game-drone-list-title {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    margin-bottom: 8px;
                    color: #26334a;
                    font-size: 13px;
                    font-weight: 900;
                    letter-spacing: .06em;
                    text-transform: uppercase;
                }
                .game-drone-list-count {
                    min-width: 26px;
                    padding: 2px 7px;
                    border-radius: 999px;
                    color: #fff;
                    background: #52617a;
                    text-align: center;
                }
                .game-drone-list { display: grid; gap: 6px; }
                .game-drone-list-empty { color: var(--muted); font-size: 13px; }
                .game-drone-list-button {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) auto;
                    align-items: center;
                    gap: 7px;
                    width: 100%;
                    min-height: 42px;
                    padding: 7px 8px;
                    border: 2px solid #77c99e;
                    border-radius: 8px;
                    color: #173a2b;
                    background: #eaf8f0;
                    font: 800 13px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
                    text-align: left;
                    touch-action: manipulation;
                }
                .game-drone-list-button:hover,
                .game-drone-list-button[data-selected=true] { border-color: #1da866; background: #d9f5e5; }
                .game-drone-list-button small { color: #23744e; font-size: 11px; }
                .game-drone-list-button[data-state=modifiable] {
                    border-color: #e2a73c;
                    color: #54370c;
                    background: #fff4dc;
                }
                .game-drone-list-button[data-state=modifiable]:hover,
                .game-drone-list-button[data-state=modifiable][data-selected=true] {
                    border-color: #c78012;
                    background: #ffe9bd;
                }
                .game-drone-list-button[data-state=modifiable] small { color: #875811; }
                .game-separator { height: 1px; margin: 13px 0; background: var(--border); }
                .game-events { margin-top: 13px; padding: 13px; border-radius: 13px; }
                .game-events h2 { margin: 0 0 9px; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; }
                .game-event-list { display: flex; gap: 7px; overflow-x: auto; }
                .game-event { min-width: 230px; padding: 8px 9px; border-radius: 8px; color: var(--muted); background: rgba(54, 67, 87, .07); font-size: 14px; }
                .game-event strong { color: var(--text); }
                .game-tournament {
                    display: none;
                    max-width: 1100px;
                    margin: 24px auto;
                    padding: 22px;
                    border: 1px solid var(--border);
                    border-radius: 15px;
                    background: rgba(248, 249, 251, .98);
                    box-shadow: 0 12px 30px rgba(34, 44, 60, .12);
                }
                .game-tournament-header {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 18px;
                    margin-bottom: 17px;
                }
                .game-tournament h2 { margin: 0; font-size: 25px; }
                .game-tournament-subtitle { margin-top: 4px; color: var(--muted); font-size: 16px; }
                .game-tournament-progress {
                    height: 14px;
                    overflow: hidden;
                    border: 1px solid var(--border);
                    border-radius: 999px;
                    background: #dce1e8;
                }
                .game-tournament-progress > div {
                    width: 0;
                    height: 100%;
                    border-radius: inherit;
                    background: linear-gradient(90deg, #6173ff, #37c77c);
                    transition: width .18s ease;
                }
                .game-tournament-current {
                    min-height: 31px;
                    margin: 10px 0 17px;
                    color: #42516a;
                    font-size: 17px;
                    font-weight: 800;
                }
                .game-tournament-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 15px; }
                .game-ranking, .game-tournament-results {
                    overflow: hidden;
                    border: 1px solid var(--border);
                    border-radius: 11px;
                    background: #fff;
                }
                .game-ranking table { width: 100%; border-collapse: collapse; font-size: 16px; }
                .game-ranking th, .game-ranking td { padding: 10px 9px; border-bottom: 1px solid rgba(48, 60, 78, .13); text-align: right; }
                .game-ranking th { color: var(--muted); background: #edf0f4; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; }
                .game-ranking th:nth-child(2), .game-ranking td:nth-child(2) { text-align: left; }
                .game-ranking tr:last-child td { border-bottom: 0; }
                .game-ranking-position { width: 48px; text-align: center !important; font-size: 20px; font-weight: 900; }
                .game-ranking-name { font-weight: 900; }
                .game-ranking-points { color: #3d4fd4; font-size: 19px; font-weight: 900; }
                .game-tournament-results { padding: 12px; }
                .game-tournament-results h3 { margin: 0 0 9px; color: #42516a; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; }
                .game-tournament-result { padding: 8px 4px; border-bottom: 1px solid rgba(48, 60, 78, .12); color: var(--muted); font-size: 14px; }
                .game-tournament-result:last-child { border-bottom: 0; }
                .game-tournament-result strong { display: block; color: var(--text); font-size: 15px; }
                @media (max-width: 1120px) {
                    .game-layout { grid-template-columns: 285px 1fr; }
                    .game-layout > aside:last-child { grid-column: 1 / -1; }
                }
                @media (max-width: 760px) {
                    .algofight-game { padding: 7px; }
                    .game-layout { grid-template-columns: 1fr; }
                    .game-layout > aside:last-child { grid-column: auto; }
                    .game-header { align-items: flex-start; flex-direction: column; }
                    .game-arena, .game-canvas { min-height: 500px; height: 500px; }
                }
                .algofight-game[data-mode=lobby] .game-score,
                .algofight-game[data-mode=lobby] .game-events,
                .algofight-game[data-mode=lobby] .game-arena,
                .algofight-game[data-mode=lobby] .game-layout > aside:last-child { display: none; }
                .algofight-game[data-mode=lobby] .game-layout {
                    display: block;
                    max-width: 720px;
                    margin: 45px auto 0;
                }
                .algofight-game[data-mode=lobby] .game-panel { padding: 22px; }
                .algofight-game[data-mode=tournament] > .game-controls,
                .algofight-game[data-mode=tournament] > .game-layout,
                .algofight-game[data-mode=tournament] > .game-events,
                .algofight-game[data-mode=tournament] .game-score { display: none; }
                .algofight-game[data-mode=tournament] .game-tournament { display: block; }
                .algofight-game[data-mode=playing] {
                    position: fixed;
                    inset: 0;
                    z-index: 2147483000;
                    min-height: 0;
                    padding: 0;
                    overflow: hidden;
                }
                .algofight-game[data-mode=playing] > .game-header,
                .algofight-game[data-mode=playing] > .game-controls,
                .algofight-game[data-mode=playing] > .game-events,
                .algofight-game[data-mode=playing] .game-layout > aside { display: none; }
                .algofight-game[data-mode=playing] .game-layout {
                    display: block;
                    width: 100%;
                    height: 100%;
                }
                .algofight-game[data-mode=playing] .game-arena {
                    --game-sidebar-width: clamp(210px, 19vw, 280px);
                    display: grid;
                    grid-template-columns: var(--game-sidebar-width) minmax(0, 1fr);
                    grid-template-rows: auto minmax(0, 1fr) auto;
                    width: 100%;
                    height: 100%;
                    min-height: 0;
                    border: 0;
                    border-radius: 0;
                }
                .algofight-game[data-mode=playing] .game-canvas {
                    grid-row: 2;
                    grid-column: 2;
                    width: 100%;
                    height: 100%;
                    min-height: 0;
                }
                .algofight-game[data-mode=playing] .game-hud {
                    position: static;
                    inset: auto;
                    grid-row: 1;
                    grid-column: 1 / -1;
                    display: grid;
                    width: 100%;
                    padding: 12px 14px;
                    border-bottom: 1px solid var(--border);
                    background: #e5e8ec;
                }
                .algofight-game[data-mode=playing] .game-inspector-panel {
                    position: static;
                    grid-row: 2 / 4;
                    grid-column: 1;
                    width: auto;
                    border-radius: 0;
                }
                .algofight-game[data-mode=playing] .game-inspector-modal {
                    grid-row: 2 / 4;
                    grid-column: 1;
                    inset: auto auto 10px 10px;
                    width: calc(var(--game-sidebar-width) - 20px);
                    max-width: calc(100vw - 20px);
                    max-height: min(48vh, calc(100% - 20px));
                }
                .algofight-game[data-mode=playing] .game-manual-help {
                    position: static;
                    inset: auto;
                    grid-row: 3;
                    grid-column: 2;
                    z-index: 4;
                    margin: 0;
                    padding: 10px 14px;
                    border-width: 2px 0 0;
                    border-radius: 0;
                    box-shadow: none;
                    background: #f7f8fa;
                    font-size: 16px;
                }
                @media (max-width: 760px) {
                    .algofight-game[data-mode=playing] { padding: 0; }
                    .algofight-game[data-mode=playing] .game-hud {
                        grid-template-columns: 1fr 1fr;
                        inset: 8px 8px auto;
                        padding: 8px;
                    }
                    .game-hud-time { order: -1; grid-column: 1 / -1; }
                    .game-hud .game-button { grid-column: 1 / -1; }
                    .algofight-game[data-mode=playing] .game-arena {
                        --game-sidebar-width: 170px;
                        grid-template-columns: var(--game-sidebar-width) minmax(0, 1fr);
                    }
                    .game-manual-help { left: 186px; right: 16px; font-size: 14px; }
                    .game-inspector-panel { padding: 10px 8px; }
                    .algofight-game[data-mode=playing] .game-inspector-modal {
                        inset: auto auto 6px 6px;
                        width: calc(var(--game-sidebar-width) - 12px);
                        max-width: calc(100vw - 12px);
                        max-height: min(48vh, calc(100% - 12px));
                        padding: 9px;
                    }
                    .game-inspector-title { font-size: 11px; }
                    .game-inspector { padding: 9px 8px; font-size: 13px; }
                    .game-inspector strong { font-size: 15px; }
                    .game-inspector-row { display: grid; gap: 1px; }
                    .game-inspector-row b { text-align: left; }
                    .game-tournament-header { flex-direction: column; }
                    .game-tournament-grid { grid-template-columns: 1fr; }
                    .game-ranking { overflow-x: auto; }
                    .game-ranking table { min-width: 660px; }
                }
            </style>

            <header class="game-header">
                <div>
                    <div class="game-title">${manualMode ? "ALGOFIGHT · MODE MANUEL" : "ALGOFIGHT · BOT ARENA"}</div>
                    <div class="game-subtitle">${manualMode
                        ? "Jouez à la souris ou au tactile contre les bots et progressez dans les niveaux sauvegardés"
                        : "Deux scripts autonomes s’affrontent selon les règles de GestionMonde"}</div>
                </div>
                <div class="game-score" data-role="score"></div>
            </header>

            <div class="game-controls">
                <label class="game-field">Largeur <input class="game-input" data-role="width" type="number" min="300" max="4000" step="50" value="1200"></label>
                <label class="game-field">Hauteur <input class="game-input" data-role="height" type="number" min="300" max="3000" step="50" value="720"></label>
                <label class="game-field">Vitesse <input class="game-input" data-role="speed" type="range" min="1" max="240" value="30"><strong data-role="speed-value">30/s</strong></label>
            </div>

            <main class="game-layout">
                <aside class="game-panel">
                    <h2>${manualMode ? "Partie manuelle" : "Contrôle des joueurs"}</h2>
                    <div class="game-bot-card a">
                        <div class="game-bot-head"><span>Joueur A</span><span class="game-worker-state" data-role="bot-a-state" data-state="offline">hors ligne</span></div>
                        ${manualMode
                            ? '<div class="game-fixed-controller">Manuel · souris ou écran tactile</div><select data-role="bot-a" hidden aria-label="Joueur A manuel"></select>'
                            : '<label>Script<select class="game-select" data-role="bot-a" aria-label="Script du joueur A"></select></label>'}
                        <div class="game-appearance-picker">
                            <img class="game-appearance-preview" data-role="appearance-preview-a" src="${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.A].url}" alt="Apparence du drone A">
                            <label>Apparence du drone<select class="game-select" data-role="appearance-a" aria-label="Apparence du drone du joueur A">${droneAppearanceOptions(DEFAULT_DRONE_APPEARANCE.A)}</select></label>
                        </div>
                    </div>
                    <div class="game-bot-card b">
                        <div class="game-bot-head"><span>Joueur B</span><span class="game-worker-state" data-role="bot-b-state" data-state="offline">hors ligne</span></div>
                        <label>${manualMode ? "Bot adverse" : "Script"}<select class="game-select" data-role="bot-b" aria-label="Script du joueur B"></select></label>
                        <div class="game-appearance-picker">
                            <img class="game-appearance-preview" data-role="appearance-preview-b" src="${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.B].url}" alt="Apparence du drone B">
                            <label>Apparence du drone<select class="game-select" data-role="appearance-b" aria-label="Apparence du drone du joueur B">${droneAppearanceOptions(DEFAULT_DRONE_APPEARANCE.B)}</select></label>
                        </div>
                    </div>
                    <button class="game-button primary game-start" data-role="start">${manualMode ? "Lancer la partie manuelle" : "Lancer le combat programmé"}</button>
                    <button class="game-button primary game-start" data-role="campaign" ${manualMode ? "" : "hidden"}>Mode progression</button>
                    <button class="game-button game-start" data-role="campaign-reset" hidden>Recommencer la progression</button>
                    <button class="game-button game-start" data-role="tournament" ${manualMode ? "hidden" : ""}>Battle royale</button>
                    <button class="game-button game-start" data-role="home">Retour au menu d’accueil</button>
                    <div class="game-status" data-role="status">Chargement des bots…</div>
                </aside>

                <section class="game-arena">
                    <aside class="game-inspector-panel">
                        <div class="game-inspector-actions">
                            <button class="game-button" data-role="toggle-targets" type="button" aria-pressed="false">Afficher les cibles</button>
                            <button class="game-button" data-role="zoom-reset" type="button" title="Utilisez la molette sur le terrain pour zoomer">Zoom 100 %</button>
                            <button class="game-button" data-role="sequence-reset" type="button" disabled>Vider la pile</button>
                        </div>
                        <div class="game-drone-list-section">
                            <div class="game-drone-list-title">Drones disponibles <span class="game-drone-list-count" data-role="manual-drone-count">0</span></div>
                            <div class="game-drone-list" data-role="manual-drone-list"><span class="game-drone-list-empty">Aucun drone disponible</span></div>
                        </div>
                        <div class="game-drone-list-section">
                            <div class="game-drone-list-title">Drones occupés <span class="game-drone-list-count" data-role="retargetable-drone-count">0</span></div>
                            <div class="game-drone-list" data-role="retargetable-drone-list"><span class="game-drone-list-empty">Aucun drone en déplacement</span></div>
                        </div>
                    </aside>
                    <div class="game-inspector-modal" data-role="inspector-modal" hidden>
                        <div class="game-inspector-title">Détails de l’élément</div>
                        <div class="game-inspector" data-role="inspector"></div>
                    </div>
                    <canvas class="game-canvas" data-role="canvas"></canvas>
                    <div class="game-manual-help" data-role="manual-help" hidden></div>
                    <div class="game-hud">
                        <div class="game-hud-card a">
                            <span>Joueur A</span>
                            <strong data-role="hud-a">0 usine · 0 drone</strong>
                            <div class="game-hud-upgrades" data-role="hud-upgrades-a"></div>
                            <div class="game-bot-state" data-role="hud-bot-state-a"><div class="game-bot-state-empty">Aucune information transmise</div></div>
                        </div>
                        <div class="game-hud-time"><span data-role="hud-time-label">Temps restant</span><strong data-role="hud-time">10:00</strong><small class="game-campaign-hud" data-role="campaign-hud" hidden></small></div>
                        <div class="game-hud-card b">
                            <span>Joueur B</span>
                            <strong data-role="hud-b">0 usine · 0 drone</strong>
                            <div class="game-hud-upgrades" data-role="hud-upgrades-b"></div>
                            <div class="game-bot-state" data-role="hud-bot-state-b"><div class="game-bot-state-empty">Aucune information transmise</div></div>
                        </div>
                        <div class="game-selected-drone-info" data-role="selected-drone-info" hidden></div>
                        <button class="game-button primary game-continue" data-role="continue" hidden>Continuer</button>
                        <button class="game-button" data-role="restart">Redémarrer</button>
                    </div>
                </section>

                <aside class="game-panel">
                    <h2>État du jeu</h2>
                    <div data-role="stats"></div>
                </aside>
            </main>

            <section class="game-events">
                <h2>Événements de la partie</h2>
                <div class="game-event-list" data-role="events"></div>
            </section>

            <section class="game-tournament">
                <div class="game-tournament-header">
                    <div>
                        <h2 data-role="tournament-title">Battle royale</h2>
                        <div class="game-tournament-subtitle" data-role="tournament-subtitle">Championnat complet aller-retour entre tous les bots</div>
                    </div>
                    <button class="game-button" data-role="tournament-exit">Arrêter le tournoi</button>
                </div>
                <div class="game-tournament-progress" aria-label="Progression du tournoi"><div data-role="tournament-progress"></div></div>
                <div class="game-tournament-current" data-role="tournament-current">Préparation du tournoi…</div>
                <div class="game-tournament-grid">
                    <div class="game-ranking" data-role="tournament-table"></div>
                    <div class="game-tournament-results" data-role="tournament-results"><h3>Derniers combats</h3></div>
                </div>
            </section>
        `
        return this.root
    }

    init() {
        this.canvas = this.role<HTMLCanvasElement>("canvas")
        this.ctx = this.canvas.getContext("2d")!
        this.widthInput = this.role<HTMLInputElement>("width")
        this.heightInput = this.role<HTMLInputElement>("height")
        this.speedInput = this.role<HTMLInputElement>("speed")
        this.speedValue = this.role<HTMLElement>("speed-value")
        this.botASelect = this.role<HTMLSelectElement>("bot-a")
        this.botBSelect = this.role<HTMLSelectElement>("bot-b")
        this.droneAppearanceASelect = this.role<HTMLSelectElement>("appearance-a")
        this.droneAppearanceBSelect = this.role<HTMLSelectElement>("appearance-b")
        this.droneAppearancePreviewA = this.role<HTMLImageElement>("appearance-preview-a")
        this.droneAppearancePreviewB = this.role<HTMLImageElement>("appearance-preview-b")
        this.botAState = this.role<HTMLElement>("bot-a-state")
        this.botBState = this.role<HTMLElement>("bot-b-state")
        this.statusElement = this.role<HTMLElement>("status")
        this.scoreElement = this.role<HTMLElement>("score")
        this.statsElement = this.role<HTMLElement>("stats")
        this.inspectorModalElement = this.role<HTMLElement>("inspector-modal")
        this.inspectorElement = this.role<HTMLElement>("inspector")
        this.eventsElement = this.role<HTMLElement>("events")
        this.hudAElement = this.role<HTMLElement>("hud-a")
        this.hudBElement = this.role<HTMLElement>("hud-b")
        this.hudUpgradesAElement = this.role<HTMLElement>("hud-upgrades-a")
        this.hudUpgradesBElement = this.role<HTMLElement>("hud-upgrades-b")
        this.hudBotStateAElement = this.role<HTMLElement>("hud-bot-state-a")
        this.hudBotStateBElement = this.role<HTMLElement>("hud-bot-state-b")
        this.hudTimeElement = this.role<HTMLElement>("hud-time")
        this.hudTimeLabelElement = this.role<HTMLElement>("hud-time-label")
        this.selectedDroneInfoElement = this.role<HTMLElement>("selected-drone-info")
        this.startButton = this.role<HTMLButtonElement>("start")
        this.tournamentButton = this.role<HTMLButtonElement>("tournament")
        this.campaignButton = this.role<HTMLButtonElement>("campaign")
        this.campaignResetButton = this.role<HTMLButtonElement>("campaign-reset")
        this.restartButton = this.role<HTMLButtonElement>("restart")
        this.continueButton = this.role<HTMLButtonElement>("continue")
        this.targetToggleButton = this.role<HTMLButtonElement>("toggle-targets")
        this.zoomResetButton = this.role<HTMLButtonElement>("zoom-reset")
        this.manualDroneListElement = this.role<HTMLElement>("manual-drone-list")
        this.manualDroneCountElement = this.role<HTMLElement>("manual-drone-count")
        this.retargetableDroneListElement = this.role<HTMLElement>("retargetable-drone-list")
        this.retargetableDroneCountElement = this.role<HTMLElement>("retargetable-drone-count")
        this.sequenceResetButton = this.role<HTMLButtonElement>("sequence-reset")
        this.campaignHudElement = this.role<HTMLElement>("campaign-hud")
        this.tournamentTitleElement = this.role<HTMLElement>("tournament-title")
        this.tournamentSubtitleElement = this.role<HTMLElement>("tournament-subtitle")
        this.tournamentProgressElement = this.role<HTMLElement>("tournament-progress")
        this.tournamentCurrentElement = this.role<HTMLElement>("tournament-current")
        this.tournamentTableElement = this.role<HTMLElement>("tournament-table")
        this.tournamentResultsElement = this.role<HTMLElement>("tournament-results")
        this.tournamentExitButton = this.role<HTMLButtonElement>("tournament-exit")
        this.manualHelpElement = this.role<HTMLElement>("manual-help")
        this.startButton.disabled = true
        this.tournamentButton.disabled = true
        this.campaignButton.disabled = true
        this.spriteLoadPromise = this.loadSprites()

        this.startButton.addEventListener("click", () => this.startMatch())
        this.tournamentButton.addEventListener("click", () => void this.startTournament())
        this.campaignButton.addEventListener("click", () => void this.startCampaign())
        this.campaignResetButton.addEventListener("click", () => void this.resetCampaign())
        this.tournamentExitButton.addEventListener("click", () => this.exitTournament())
        this.role<HTMLButtonElement>("home").addEventListener("click", () => void this.returnToHome())
        this.restartButton.addEventListener("click", () => this.handleRestart())
        this.continueButton.addEventListener("click", () => this.toggleManualSimulation())
        this.targetToggleButton.addEventListener("click", () => this.toggleManualTargets())
        this.zoomResetButton.addEventListener("click", () => this.resetZoom())
        this.manualDroneListElement.addEventListener("click", event => this.selectDroneFromList(event))
        this.retargetableDroneListElement.addEventListener("click", event => this.selectDroneFromList(event))
        this.sequenceResetButton.addEventListener("click", () => this.clearSelectedDroneSequence())
        this.speedInput.addEventListener("input", () => {
            this.speedValue.textContent = `${this.stepsPerSecond()}/s`
        })
        this.botASelect.addEventListener("change", () => this.changeController("A"))
        this.botBSelect.addEventListener("change", () => this.changeController("B"))
        this.droneAppearanceASelect.addEventListener("change", () => this.changeDroneAppearance("A"))
        this.droneAppearanceBSelect.addEventListener("change", () => this.changeDroneAppearance("B"))
        this.installCanvasInputEvents()

        this.createWorld()
        this.updateDroneAppearanceUi()
        void this.loadBots()
        this.lastFrame = performance.now()
        this.requestId = requestAnimationFrame(time => this.frame(time))
    }

    private role<T extends globalThis.Element>(name: string) {
        const element = this.root.querySelector(`[data-role="${name}"]`)
        if (!element) throw new Error(`Élément de jeu '${name}' introuvable`)
        return element as T
    }

    private installCanvasInputEvents() {
        const clearHover = () => {
            this.hovered = undefined
            this.updateInspector()
        }

        this.canvas.addEventListener("wheel", event => this.handleCanvasWheel(event), { passive: false })

        if ("PointerEvent" in window) {
            this.canvas.addEventListener("pointerdown", event => {
                if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return
                event.preventDefault()
                try {
                    this.canvas.setPointerCapture(event.pointerId)
                } catch {
                    // Certaines WebView ne permettent pas la capture du pointeur.
                }
                this.beginCanvasGesture(event, event.pointerId)
            })
            this.canvas.addEventListener("pointermove", event => {
                if (this.moveCanvasGesture(event, event.pointerId)) event.preventDefault()
                else this.inspectPointer(event)
            })
            this.canvas.addEventListener("pointerup", event => {
                if (!event.isPrimary) return
                event.preventDefault()
                this.endCanvasGesture(event, event.pointerId)
            })
            this.canvas.addEventListener("pointerleave", event => {
                // Un écran tactile n'a pas de survol : son dernier appui reste
                // affiché jusqu'au prochain. La souris, elle, efface le panneau
                // lorsqu'elle quitte la carte.
                if (!this.canvasGesture && event.pointerType === "mouse") clearHover()
            })
            this.canvas.addEventListener("pointercancel", event => {
                this.cancelCanvasGesture(event.pointerId)
                if (event.pointerType === "mouse") clearHover()
            })
            return
        }

        // Compatibilité avec les anciennes WebView tactiles qui n'émettent
        // pas de PointerEvent. Le listener doit être non passif pour empêcher
        // le défilement de la page pendant un ordre manuel.
        this.canvas.addEventListener("touchstart", event => {
            const touch = event.changedTouches[0]
            if (!touch) return
            event.preventDefault()
            this.beginCanvasGesture({
                clientX: touch.clientX,
                clientY: touch.clientY,
                pointerType: "touch"
            }, touch.identifier)
        }, { passive: false })
        this.canvas.addEventListener("touchmove", event => {
            const gesture = this.canvasGesture
            if (!gesture || gesture.pointerType !== "touch") return
            const touch = Array.from(event.touches).find(value => value.identifier === gesture.id)
            if (!touch) return
            event.preventDefault()
            this.moveCanvasGesture({
                clientX: touch.clientX,
                clientY: touch.clientY,
                pointerType: "touch"
            }, touch.identifier)
        }, { passive: false })
        this.canvas.addEventListener("touchend", event => {
            const gesture = this.canvasGesture
            if (!gesture || gesture.pointerType !== "touch") return
            const touch = Array.from(event.changedTouches).find(value => value.identifier === gesture.id)
            if (!touch) return
            event.preventDefault()
            this.endCanvasGesture({
                clientX: touch.clientX,
                clientY: touch.clientY,
                pointerType: "touch"
            }, touch.identifier)
        }, { passive: false })
        this.canvas.addEventListener("mousedown", event => {
            if (event.button !== 0) return
            this.beginCanvasGesture({
                clientX: event.clientX,
                clientY: event.clientY,
                pointerType: "mouse"
            }, "mouse")
        })
        this.canvas.addEventListener("mousemove", event => {
            const input: CanvasInput = {
                clientX: event.clientX,
                clientY: event.clientY,
                pointerType: "mouse"
            }
            if (!this.moveCanvasGesture(input, "mouse")) this.inspectPointer(input)
        })
        this.canvas.addEventListener("mouseup", event => this.endCanvasGesture({
            clientX: event.clientX,
            clientY: event.clientY,
            pointerType: "mouse"
        }, "mouse"))
        this.canvas.addEventListener("mouseleave", () => {
            this.cancelCanvasGesture("mouse")
            clearHover()
        })
    }

    private async loadBots() {
        this.setStatus("Recherche des scripts dans /bots…")
        try {
            const scriptsPromise = listBotsScript()
            await this.spriteLoadPromise
            const scripts = (await scriptsPromise).filter(path => /\.ts$/i.test(path))
            this.botScripts = scripts
            this.botSignature = await this.computeBotSignature(scripts)
            this.fillSelect(this.botASelect, scripts, "manual")
            this.fillSelect(this.botBSelect, scripts, "bot")
            if (scripts.length === 0) {
                this.setWorkerState("A", "aucun bot", "error")
                this.setWorkerState("B", "aucun bot", "error")
                this.setStatus("Aucun fichier TypeScript trouvé dans /bots.", true)
                return
            }

            this.botASelect.value = MANUAL_CONTROLLER
            this.botBSelect.value = scripts[1] ?? scripts[0]
            this.botsLoaded = true
            this.startButton.disabled = false
            this.campaign = await this.loadCampaignSave()
            this.campaignButton.disabled = false
            this.updateCampaignButtons()
            this.tournamentButton.disabled = true
            this.tournamentButton.textContent = scripts.length < 2
                ? "Battle royale · 2 bots minimum"
                : `Battle royale · ${scripts.length * (scripts.length - 1)} combats`
            this.setWorkerState("A", "prêt", "pending")
            this.setWorkerState("B", "prêt", "pending")
            this.setStatus(this.campaignIsCompatible(this.campaign)
                ? `Niveaux chargés depuis ${CAMPAIGN_LEVELS_SOURCE}. Choisissez une partie libre ou reprenez la progression.`
                : "Première partie manuelle : lancement automatique de l’évaluation des bots.")
            if (!this.campaignIsCompatible(this.campaign)) {
                queueMicrotask(() => void this.startCampaign())
            }
        } catch (error) {
            this.startButton.disabled = true
            this.tournamentButton.disabled = true
            this.campaignButton.disabled = true
            this.setWorkerState("A", "erreur", "error")
            this.setWorkerState("B", "erreur", "error")
            this.setStatus(`Impossible de lister les bots : ${this.errorMessage(error)}`, true)
        }
    }

    private fillSelect(select: HTMLSelectElement, scripts: string[], controller: "bot" | "manual") {
        select.replaceChildren()
        if (controller === "manual") {
            select.add(new Option("Manuel — souris ou tactile", MANUAL_CONTROLLER))
            select.value = MANUAL_CONTROLLER
            select.disabled = true
            return
        }
        if (scripts.length === 0) {
            select.add(new Option("Aucun bot disponible", ""))
            select.disabled = true
            return
        }
        for (const script of scripts) {
            const origin = isGeneratedBotSourcePath(script) ? "intégré" : "utilisateur"
            select.add(new Option(`${scriptName(script)} · ${origin} — ${script}`, script))
        }
        select.disabled = false
    }

    private async returnToHome() {
        this.destroy()
        const marker = globalThis as typeof globalThis & { __algofightSkipAutoInstall?: boolean }
        marker.__algofightSkipAutoInstall = true
        try {
            const { installGame } = await import("./game")
            installGame(document.body)
        } finally {
            delete marker.__algofightSkipAutoInstall
        }
    }

    private changeController(player: PlayerKey) {
        const selected = player === "A" ? this.botASelect : this.botBSelect
        const other = player === "A" ? this.botBSelect : this.botASelect
        let message = "Les contrôles ont changé. Cliquez sur « Lancer le combat »."
        if (selected.value === MANUAL_CONTROLLER && other.value === MANUAL_CONTROLLER) {
            other.value = this.botScripts[0] ?? ""
            message = `Le mode manuel est réservé au joueur ${player}. L’autre joueur utilisera ${scriptName(other.value)}.`
        }
        this.markPendingRestart(message)
    }

    private createWorld() {
        this.worldWidth = Math.max(300, Number(this.widthInput.value) || 1200)
        this.worldHeight = Math.max(300, Number(this.heightInput.value) || 720)
        this.widthInput.value = String(this.worldWidth)
        this.heightInput.value = String(this.worldHeight)
        this.gestionMonde = new GestionMonde([], DEFAULT_CONFIG)
        this.gestionMonde.createWorld(this.worldWidth, this.worldHeight)
        this.resetWorldPresentation(`Monde ${this.worldWidth} × ${this.worldHeight} créé`)
    }

    private resetWorldPresentation(initialEvent: string) {
        this.tick = 0
        this.accumulator = 0
        this.running = false
        this.manualTurnPaused = false
        if (this.continueButton) this.continueButton.hidden = true
        if (this.selectedDroneInfoElement) this.selectedDroneInfoElement.hidden = true
        this.events = []
        this.activeDroneActions.clear()
        this.pendingDroneDestructions.clear()
        this.explosions = []
        this.launches = []
        this.manualTargetQueues.clear()
        this.manualDroneListSignature = ""
        this.resetZoom()
        this.clearManualSelection()
        this.rememberWorld()
        this.addEvent(initialEvent)
        this.refreshUi()
    }

    private startMatch() {
        if (!this.botsLoaded || !this.botASelect.value || !this.botBSelect.value) {
            this.setStatus("Choisissez un contrôle pour les deux joueurs.", true)
            return
        }
        const manualA = this.botASelect.value === MANUAL_CONTROLLER
        const manualB = this.botBSelect.value === MANUAL_CONTROLLER
        if (manualA && manualB) {
            this.setStatus("Un seul joueur peut utiliser le mode manuel.", true)
            return
        }

        this.campaignActive = false
        this.campaignHudElement.hidden = true
        this.restartButton.textContent = "Redémarrer"
        this.stopWorkers()
        this.createWorld()
        const scriptA = this.botASelect.value
        const scriptB = this.botBSelect.value
        this.manualPlayer = manualA ? "A" : manualB ? "B" : undefined
        this.clearManualSelection()
        const generation = ++this.workerGeneration
        this.responseCountA = 0
        this.responseCountB = 0
        this.setWorkerState("A", manualA ? "manuel · prêt" : "démarrage…", manualA ? "active" : "loading")
        this.setWorkerState("B", manualB ? "manuel · prêt" : "démarrage…", manualB ? "active" : "loading")

        let workerA: Worker | undefined
        let workerB: Worker | undefined
        try {
            if (!manualA) workerA = this.createWorker("A", scriptA, generation)
            if (!manualB) workerB = this.createWorker("B", scriptB, generation)
            this.workerA = workerA
            this.workerB = workerB
            if (workerA) this.gestionMonde.setWorkerA(workerA)
            if (workerB) this.gestionMonde.setWorkerB(workerB)
            if (workerA) this.setWorkerState("A", "actif · 0 ordre", "active")
            if (workerB) this.setWorkerState("B", "actif · 0 ordre", "active")
            this.running = true
            this.accumulator = 0
            this.enterArena()
            const controllerA = manualA ? "Manuel" : scriptName(scriptA)
            const controllerB = manualB ? "Manuel" : scriptName(scriptB)
            this.updateManualHelp()
            this.setStatus(`${controllerA} affronte ${controllerB}.`)
            this.addEvent(`Combat lancé : ${controllerA} (A) contre ${controllerB} (B)`)
            this.pauseForManualOrdersIfNeeded()
        } catch (error) {
            workerA?.terminate()
            workerB?.terminate()
            this.workerA = undefined
            this.workerB = undefined
            this.manualPlayer = undefined
            this.clearManualSelection()
            this.running = false
            this.showLobby()
            this.setWorkerState("A", "erreur", "error")
            this.setWorkerState("B", "erreur", "error")
            this.setStatus(`Impossible de lancer les workers : ${this.errorMessage(error)}`, true)
        }
        this.refreshUi()
    }

    private campaignBotSignature() {
        return this.botSignature || this.botScripts.join("\n")
    }

    private async computeBotSignature(scripts: string[]) {
        return gameBotSignature(scripts)
    }

    private campaignConfig(powerCount: number): Config {
        return levelConfig(powerCount)
    }

    private async loadCampaignSave(): Promise<CampaignSave | undefined> {
        try {
            const levels = await readGameLevels()

            let progress: CampaignProgressFile | undefined
            try {
                const value = await readGameProgress()
                if (value.botSignature === levels.botSignature) {
                    progress = value
                }
            } catch {
                progress = undefined
            }

            const save: CampaignSave = {
                ...levels,
                levelIndex: progress?.levelIndex ?? 0,
                opponentIndex: progress?.opponentIndex ?? 0,
                completed: progress?.completed ?? false
            }
            if (save.botSignature !== this.campaignBotSignature()) return save
            let shouldWriteProgress = !progress
            const currentLevel = save.levels[save.levelIndex]
            if (!save.completed && (
                !currentLevel
                || save.opponentIndex < 0
                || save.opponentIndex >= currentLevel.ranking.length
            )) {
                save.levelIndex = 0
                save.opponentIndex = 0
                shouldWriteProgress = true
            }
            if (shouldWriteProgress) await this.writeCampaignProgress(save)
            return save
        } catch {
            return undefined
        }
    }

    private campaignIsCompatible(save: CampaignSave | undefined): save is CampaignSave {
        if (!save || save.botSignature !== this.campaignBotSignature()) return false
        if (save.levels.length !== CAMPAIGN_POWER_LEVELS.length) return false
        return save.levels.every((level, index) =>
            level.powerCount === CAMPAIGN_POWER_LEVELS[index]
            && level.ranking.length === this.botScripts.length
            && level.ranking.every(script => this.botScripts.includes(script))
        )
    }

    private campaignLevelCount(save: CampaignSave) {
        return gameProgressionLevelCount(save)
    }

    private campaignLevelIndex(save: CampaignSave) {
        if (save.completed) return this.campaignLevelCount(save)
        const completedPowers = save.levels
            .slice(0, save.levelIndex)
            .reduce((total, level) => total + level.ranking.length, 0)
        return completedPowers + save.opponentIndex + 1
    }

    private campaignLevelLabel(save: CampaignSave) {
        const levelCount = this.campaignLevelCount(save)
        const levelIndex = Math.min(levelCount, this.campaignLevelIndex(save))
        return `Niveau ${levelIndex}/${levelCount}`
    }

    private async writeCampaignProgress(save: CampaignSave) {
        const progress: CampaignProgressFile = {
            version: 1,
            botSignature: save.botSignature,
            levelIndex: save.levelIndex,
            opponentIndex: save.opponentIndex,
            completed: save.completed
        }
        await writeGameProgress(progress)
    }

    private async persistCampaign(save: CampaignSave, includeLevels = false) {
        if (includeLevels) {
            const levels: CampaignLevelsFile = {
                version: 2,
                botSignature: save.botSignature,
                width: save.width,
                height: save.height,
                levels: save.levels
            }
            await writeGameLevels(levels)
        }
        await this.writeCampaignProgress(save)
        this.campaign = save
        this.updateCampaignButtons()
    }

    private updateCampaignButtons() {
        const save = this.campaignIsCompatible(this.campaign) ? this.campaign : undefined
        this.campaignResetButton.hidden = !this.campaign
        if (!save) {
            this.campaignButton.textContent = "Mode progression · première évaluation"
            return
        }
        if (save.completed) {
            this.campaignButton.textContent = "Mode progression · terminée"
            return
        }
        const level = save.levels[save.levelIndex]
        const opponent = level?.ranking[save.opponentIndex]
        this.campaignButton.textContent = opponent
            ? `Reprendre · ${this.campaignLevelLabel(save)} · ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""} · ${scriptName(opponent)}`
            : "Reprendre le mode progression"
    }

    private async resetCampaign() {
        if (!window.confirm("Recommencer la progression ? Les mondes et leurs classements seront conservés.")) return
        const save = this.campaignIsCompatible(this.campaign) ? this.campaign : undefined
        if (!save) {
            this.campaign = undefined
            this.updateCampaignButtons()
            this.setStatus("Aucun niveau sauvegardé : la prochaine partie les calculera.")
            return
        }
        const previous = {
            levelIndex: save.levelIndex,
            opponentIndex: save.opponentIndex,
            completed: save.completed
        }
        save.levelIndex = 0
        save.opponentIndex = 0
        save.completed = false
        try {
            await this.persistCampaign(save)
            this.setStatus(`Progression réinitialisée dans ${CAMPAIGN_PROGRESS_SOURCE}. Les niveaux sont conservés.`)
        } catch (error) {
            save.levelIndex = previous.levelIndex
            save.opponentIndex = previous.opponentIndex
            save.completed = previous.completed
            this.updateCampaignButtons()
            this.setStatus(`Impossible d’enregistrer la progression : ${this.errorMessage(error)}`, true)
        }
    }

    private async startCampaign() {
        if (!this.botsLoaded || this.botScripts.length === 0) {
            this.setStatus("Il faut au moins un bot pour lancer le mode progression.", true)
            return
        }

        let save = this.campaignIsCompatible(this.campaign) ? this.campaign : undefined
        if (!save) save = await this.evaluateCampaign()
        if (!save) return
        if (save.completed) {
            this.showLobby()
            this.setStatus("La campagne est terminée. Réinitialisez la progression pour la recommencer.")
            return
        }
        this.startCampaignEncounter()
    }

    private async evaluateCampaign(): Promise<CampaignSave | undefined> {
        this.stopWorkers()
        this.manualPlayer = undefined
        this.clearManualSelection()
        this.running = false
        this.manualTurnPaused = false
        this.continueButton.hidden = true
        this.selectedDroneInfoElement.hidden = true
        this.accumulator = 0
        const runId = ++this.tournamentRunId
        this.tournamentRunning = true
        this.campaignEvaluating = true
        this.worldWidth = Math.max(300, Number(this.widthInput.value) || 1200)
        this.worldHeight = Math.max(300, Number(this.heightInput.value) || 720)
        this.widthInput.value = String(this.worldWidth)
        this.heightInput.value = String(this.worldHeight)
        this.showTournament()
        this.tournamentTitleElement.textContent = "Évaluation de la campagne"
        this.tournamentSubtitleElement.textContent = "Génération et classement des bots sur les niveaux de 0 à 5 pouvoirs"
        this.tournamentExitButton.textContent = "Arrêter l’évaluation"

        const matchesPerLevel = this.botScripts.length * (this.botScripts.length - 1)
        const totalMatches = matchesPerLevel * CAMPAIGN_POWER_LEVELS.length
        const levels: CampaignLevel[] = []
        const recentResults: string[] = []
        let completedMatches = 0

        this.tournamentProgressElement.style.width = "0%"
        this.tournamentCurrentElement.textContent = "Génération des mondes de campagne…"
        this.tournamentTableElement.innerHTML = ""
        this.tournamentResultsElement.innerHTML = "<h3>Derniers combats</h3>"

        try {
            for (const powerCount of CAMPAIGN_POWER_LEVELS) {
                if (runId !== this.tournamentRunId) return undefined
                const config = this.campaignConfig(powerCount)
                const initialWorld = createSymmetricLevelWorld(
                    this.worldWidth,
                    this.worldHeight,
                    config
                )
                const initialData = entityToJsonData(initialWorld.save())
                const standings = new Map<string, TournamentStanding>(
                    this.botScripts.map(script => [script, {
                        script,
                        played: 0,
                        wins: 0,
                        draws: 0,
                        losses: 0,
                        points: 0,
                        dronesFor: 0,
                        dronesAgainst: 0
                    }])
                )
                this.renderTournamentStandings(standings, recentResults)

                for (let first = 0; first < this.botScripts.length; first++) {
                    for (let second = first + 1; second < this.botScripts.length; second++) {
                        const pair = [
                            [this.botScripts[first], this.botScripts[second]],
                            [this.botScripts[second], this.botScripts[first]]
                        ] as const
                        for (const [scriptA, scriptB] of pair) {
                            if (runId !== this.tournamentRunId) return undefined
                            const label = `Niveau ${powerCount} · ${scriptName(scriptA)} (A) contre ${scriptName(scriptB)} (B)`
                            this.tournamentCurrentElement.textContent = `Combat ${completedMatches + 1} / ${totalMatches} · ${label}`
                            const outcome = await this.runTournamentMatch(
                                scriptA,
                                scriptB,
                                initialData,
                                runId,
                                completedMatches,
                                totalMatches,
                                label,
                                config
                            )
                            if (!outcome || runId !== this.tournamentRunId) return undefined
                            completedMatches++
                            this.recordTournamentOutcome(standings, scriptA, scriptB, outcome)
                            const winner = outcome.winner === "A" ? scriptName(scriptA)
                                : outcome.winner === "B" ? scriptName(scriptB)
                                    : "Match nul"
                            recentResults.unshift(`${label}|${winner} · T${outcome.tick}`)
                            if (recentResults.length > 10) recentResults.pop()
                            this.tournamentProgressElement.style.width = totalMatches === 0
                                ? `${(powerCount + 1) / CAMPAIGN_POWER_LEVELS.length * 100}%`
                                : `${completedMatches / totalMatches * 100}%`
                            this.renderTournamentStandings(standings, recentResults)
                        }
                    }
                }

                const ranking = this.sortedTournamentStandings(standings)
                    .map(standing => standing.script)
                    .reverse()
                levels.push({ powerCount, world: initialData, ranking })
                if (totalMatches === 0) {
                    this.tournamentProgressElement.style.width = `${levels.length / CAMPAIGN_POWER_LEVELS.length * 100}%`
                }
                this.tournamentCurrentElement.textContent = `Niveau ${powerCount} calculé · ordre du plus faible au plus fort enregistré.`
                await this.tournamentYield()
            }

            if (runId !== this.tournamentRunId) return undefined
            const save: CampaignSave = {
                version: 2,
                botSignature: this.campaignBotSignature(),
                width: this.worldWidth,
                height: this.worldHeight,
                levels,
                levelIndex: 0,
                opponentIndex: 0,
                completed: false
            }
            await this.persistCampaign(save, true)
            this.tournamentRunning = false
            this.campaignEvaluating = false
            this.stopWorkers()
            this.tournamentProgressElement.style.width = "100%"
            this.tournamentCurrentElement.textContent = `Évaluation terminée · ${completedMatches} combats · niveaux et progression enregistrés en JSON.`
            this.tournamentExitButton.textContent = "Retour au menu"
            return save
        } catch (error) {
            if (runId !== this.tournamentRunId) return undefined
            this.tournamentRunning = false
            this.campaignEvaluating = false
            this.stopWorkers()
            this.tournamentCurrentElement.textContent = `Évaluation interrompue : ${this.errorMessage(error)}`
            this.tournamentExitButton.textContent = "Retour au menu"
            return undefined
        }
    }

    private startCampaignEncounter() {
        const save = this.campaignIsCompatible(this.campaign) ? this.campaign : undefined
        const level = save?.levels[save.levelIndex]
        const opponent = level?.ranking[save!.opponentIndex]
        if (!save || !level || !opponent || save.completed) {
            this.campaignActive = false
            this.showLobby()
            this.setStatus("La progression enregistrée est incomplète. Relancez son évaluation.", true)
            return
        }

        this.stopWorkers()
        this.campaignActive = true
        this.manualPlayer = "A"
        this.worldWidth = save.width
        this.worldHeight = save.height
        this.gestionMonde = new GestionMonde([], this.campaignConfig(level.powerCount))
        this.gestionMonde.load(level.world)
        this.resetWorldPresentation(`Campagne · ${this.campaignLevelLabel(save)} · ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""} · adversaire ${scriptName(opponent)}`)
        this.manualPlayer = "A"
        this.responseCountA = 0
        this.responseCountB = 0
        const generation = ++this.workerGeneration
        this.setWorkerState("A", "manuel · prêt", "active")
        this.setWorkerState("B", "démarrage…", "loading")

        try {
            this.workerB = this.createWorker("B", opponent, generation)
            this.gestionMonde.setWorkerB(this.workerB)
            this.setWorkerState("B", "actif · 0 ordre", "active")
            this.running = true
            this.accumulator = 0
            this.restartButton.textContent = "Quitter la campagne"
            this.enterArena()
            this.updateCampaignHud()
            this.updateManualHelp()
            this.setStatus(`Campagne : ${this.campaignLevelLabel(save)}, joueur manuel contre ${scriptName(opponent)} avec ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""}.`)
            this.addEvent(`Affrontement de campagne lancé contre ${scriptName(opponent)}`)
            this.pauseForManualOrdersIfNeeded()
        } catch (error) {
            this.workerB?.terminate()
            this.workerB = undefined
            this.campaignActive = false
            this.manualPlayer = undefined
            this.running = false
            this.showLobby()
            this.setStatus(`Impossible de lancer l’adversaire : ${this.errorMessage(error)}`, true)
        }
        this.refreshUi()
    }

    private updateCampaignHud(message?: string) {
        const save = this.campaignIsCompatible(this.campaign) ? this.campaign : undefined
        const level = save?.levels[save.levelIndex]
        const opponent = level?.ranking[save!.opponentIndex]
        this.campaignHudElement.hidden = !this.campaignActive
        if (!this.campaignActive) return
        this.campaignHudElement.textContent = message ?? (save?.completed
            ? "Campagne terminée"
            : level && opponent
                ? `Campagne · ${this.campaignLevelLabel(save)} · ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""} · ${scriptName(opponent)}`
                : "Campagne")
    }

    private handleRestart() {
        if (this.campaignSaving) return
        if (!this.campaignActive) {
            this.returnToLobby()
            return
        }
        if (!this.gestionMonde.combatResult || this.campaign?.completed) {
            this.returnToLobby()
            return
        }
        this.startCampaignEncounter()
    }

    private async startTournament() {
        this.setStatus("Utilisez le mode progression pour recalculer les niveaux.", true)
        return
        if (!this.botsLoaded || this.botScripts.length < 2) {
            this.setStatus("Il faut au moins deux bots pour lancer la Battle royale.", true)
            return
        }

        this.campaignActive = false
        this.campaignEvaluating = false
        this.campaignHudElement.hidden = true
        this.stopWorkers()
        this.manualPlayer = undefined
        this.clearManualSelection()
        this.running = false
        this.accumulator = 0
        const runId = ++this.tournamentRunId
        this.tournamentRunning = true
        this.worldWidth = Math.max(300, Number(this.widthInput.value) || 1200)
        this.worldHeight = Math.max(300, Number(this.heightInput.value) || 720)
        this.widthInput.value = String(this.worldWidth)
        this.heightInput.value = String(this.worldHeight)
        this.showTournament()
        this.tournamentTitleElement.textContent = "Battle royale"
        this.tournamentSubtitleElement.textContent = "Championnat complet aller-retour entre tous les bots"

        const standings = new Map<string, TournamentStanding>(
            this.botScripts.map(script => [script, {
                script,
                played: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                points: 0,
                dronesFor: 0,
                dronesAgainst: 0
            }])
        )
        const recentResults: string[] = []
        const totalMatches = this.botScripts.length * (this.botScripts.length - 1)
        let completedMatches = 0

        this.tournamentProgressElement.style.width = "0%"
        this.tournamentExitButton.textContent = "Arrêter le tournoi"
        this.tournamentCurrentElement.textContent = `0 / ${totalMatches} combats · préparation des mondes…`
        this.renderTournamentStandings(standings, recentResults)

        try {
            for (let first = 0; first < this.botScripts.length; first++) {
                for (let second = first + 1; second < this.botScripts.length; second++) {
                    if (runId !== this.tournamentRunId) return

                    // Les manches aller et retour partagent le même monde initial.
                    const initialWorld = new GestionMonde([], DEFAULT_CONFIG)
                    initialWorld.createWorld(this.worldWidth, this.worldHeight)
                    const initialData = entityToJsonData(initialWorld.save())
                    const pair = [
                        [this.botScripts[first], this.botScripts[second]],
                        [this.botScripts[second], this.botScripts[first]]
                    ] as const

                    for (const [scriptA, scriptB] of pair) {
                        if (runId !== this.tournamentRunId) return
                        const matchNumber = completedMatches + 1
                        const label = `${scriptName(scriptA)} (A) contre ${scriptName(scriptB)} (B)`
                        this.tournamentCurrentElement.textContent = `Combat ${matchNumber} / ${totalMatches} · ${label}`

                        const outcome = await this.runTournamentMatch(
                            scriptA,
                            scriptB,
                            initialData,
                            runId,
                            completedMatches,
                            totalMatches,
                            label
                        )
                        if (!outcome) return
                        if (runId !== this.tournamentRunId) return
                        const completedOutcome = outcome as TournamentOutcome

                        completedMatches++
                        this.recordTournamentOutcome(standings, scriptA, scriptB, completedOutcome)
                        const winner = completedOutcome.winner === "A" ? scriptName(scriptA)
                            : completedOutcome.winner === "B" ? scriptName(scriptB)
                                : "Match nul"
                        const reason = completedOutcome.reason === "worker-error" ? "erreur d’un worker"
                            : completedOutcome.reason === "time" ? "temps écoulé"
                                : "élimination"
                        recentResults.unshift(
                            `${scriptName(scriptA)} (A) × ${scriptName(scriptB)} (B)|${winner} · T${completedOutcome.tick} · ${reason}`
                        )
                        if (recentResults.length > 10) recentResults.pop()
                        this.tournamentProgressElement.style.width = `${completedMatches / totalMatches * 100}%`
                        this.renderTournamentStandings(standings, recentResults)
                    }
                }
            }

            if (runId !== this.tournamentRunId) return
            this.tournamentRunning = false
            this.stopWorkers()
            const ranking = this.sortedTournamentStandings(standings)
            const champion = ranking[0]
            this.tournamentProgressElement.style.width = "100%"
            this.tournamentCurrentElement.textContent = champion
                ? `Tournoi terminé · ${completedMatches} combats · champion : ${scriptName(champion.script)} avec ${champion.points} points`
                : "Tournoi terminé."
            this.tournamentExitButton.textContent = "Retour aux duels"
            this.renderTournamentStandings(standings, recentResults)
        } catch (error) {
            if (runId !== this.tournamentRunId) return
            this.tournamentRunning = false
            this.stopWorkers()
            this.tournamentCurrentElement.textContent = `Tournoi interrompu : ${this.errorMessage(error)}`
            this.tournamentExitButton.textContent = "Retour aux duels"
        }
    }

    private async runTournamentMatch(
        scriptA: string,
        scriptB: string,
        initialData: JsonData,
        runId: number,
        completedMatches: number,
        totalMatches: number,
        label: string,
        config: Config = DEFAULT_CONFIG
    ): Promise<TournamentOutcome | undefined> {
        this.stopWorkers()
        const game = new GestionMonde([], config)
        game.load(initialData)
        this.gestionMonde = game
        this.tick = 0

        let failedA = false
        let failedB = false
        const createTournamentWorker = (player: PlayerKey, script: string) => {
            const worker = new Worker(scriptWorkerUrl(script, player), {
                type: "module",
                name: `Battle royale ${player} · ${scriptName(script)}`
            })
            const markFailed = () => {
                if (player === "A") failedA = true
                else failedB = true
            }
            worker.addEventListener("error", event => {
                event.preventDefault()
                markFailed()
            })
            worker.addEventListener("messageerror", markFailed)
            return worker
        }

        try {
            this.workerA = createTournamentWorker("A", scriptA)
            this.workerB = createTournamentWorker("B", scriptB)
            game.setWorkerA(this.workerA)
            game.setWorkerB(this.workerB)

            // Laisse aux modules workers le temps d'installer leur gestionnaire start().
            await this.tournamentYield(16)
            let batchCount = 0
            while (!game.combatResult) {
                if (runId !== this.tournamentRunId) return undefined
                if (failedA || failedB) {
                    const dronesA = game.drones().filter(drone => drone.joueur === game.joueurA).length
                    const dronesB = game.drones().filter(drone => drone.joueur === game.joueurB).length
                    return {
                        winner: failedA === failedB ? "draw" : failedA ? "B" : "A",
                        tick: game.combatTick,
                        droneCountA: dronesA,
                        droneCountB: dronesB,
                        reason: "worker-error"
                    }
                }

                for (let index = 0; index < TOURNAMENT_STEP_BATCH && !game.combatResult; index++) {
                    await game.step()
                }
                this.tick = game.combatTick
                batchCount++
                if (batchCount % 4 === 0) {
                    const matchProgress = game.combatTick / game.config.COMBAT_TIME
                    this.tournamentProgressElement.style.width = `${(completedMatches + matchProgress) / totalMatches * 100}%`
                    this.tournamentCurrentElement.textContent = `Combat ${completedMatches + 1} / ${totalMatches} · ${label} · tick ${game.combatTick}`
                }
                await this.tournamentYield()
            }

            const result = game.combatResult
            return {
                winner: !result?.winner ? "draw" : result.winner === game.joueurA ? "A" : "B",
                tick: result?.tick ?? game.combatTick,
                droneCountA: result?.droneCountA ?? 0,
                droneCountB: result?.droneCountB ?? 0,
                reason: result?.reason ?? "time"
            }
        } finally {
            if (this.gestionMonde === game) this.stopWorkers()
        }
    }

    private tournamentYield(delay = 0) {
        return new Promise<void>(resolve => setTimeout(resolve, delay))
    }

    private recordTournamentOutcome(
        standings: Map<string, TournamentStanding>,
        scriptA: string,
        scriptB: string,
        outcome: TournamentOutcome
    ) {
        const standingA = standings.get(scriptA)!
        const standingB = standings.get(scriptB)!
        standingA.played++
        standingB.played++
        standingA.dronesFor += outcome.droneCountA
        standingA.dronesAgainst += outcome.droneCountB
        standingB.dronesFor += outcome.droneCountB
        standingB.dronesAgainst += outcome.droneCountA

        if (outcome.winner === "draw") {
            standingA.draws++
            standingB.draws++
            standingA.points++
            standingB.points++
        } else if (outcome.winner === "A") {
            standingA.wins++
            standingA.points += 3
            standingB.losses++
        } else {
            standingB.wins++
            standingB.points += 3
            standingA.losses++
        }
    }

    private sortedTournamentStandings(standings: Map<string, TournamentStanding>) {
        return [...standings.values()].sort((a, b) =>
            b.points - a.points
            || b.wins - a.wins
            || (b.dronesFor - b.dronesAgainst) - (a.dronesFor - a.dronesAgainst)
            || b.dronesFor - a.dronesFor
            || scriptName(a.script).localeCompare(scriptName(b.script), "fr")
        )
    }

    private renderTournamentStandings(
        standings: Map<string, TournamentStanding>,
        recentResults: string[]
    ) {
        const ranking = this.sortedTournamentStandings(standings)
        this.tournamentTableElement.innerHTML = `
            <table>
                <thead><tr><th>#</th><th>Bot</th><th>Pts</th><th>J</th><th>V</th><th>N</th><th>D</th><th>Diff. drones</th></tr></thead>
                <tbody>${ranking.map((standing, index) => {
                    const difference = standing.dronesFor - standing.dronesAgainst
                    return `<tr>
                        <td class="game-ranking-position">${index + 1}</td>
                        <td class="game-ranking-name">${escapeHtml(scriptName(standing.script))}</td>
                        <td class="game-ranking-points">${standing.points}</td>
                        <td>${standing.played}</td><td>${standing.wins}</td><td>${standing.draws}</td><td>${standing.losses}</td>
                        <td>${difference > 0 ? "+" : ""}${difference}</td>
                    </tr>`
                }).join("")}</tbody>
            </table>
        `
        this.tournamentResultsElement.innerHTML = `
            <h3>Derniers combats</h3>
            ${recentResults.length === 0
                ? `<div class="game-tournament-result">Aucun résultat pour le moment.</div>`
                : recentResults.map(entry => {
                    const [match, result] = entry.split("|")
                    return `<div class="game-tournament-result"><strong>${escapeHtml(match)}</strong>${escapeHtml(result)}</div>`
                }).join("")}
        `
    }

    private createWorker(player: PlayerKey, script: string, generation: number) {
        const worker = new Worker(scriptWorkerUrl(script, player), {
            type: "module",
            name: `AlgoFight ${player} · ${scriptName(script)}`
        })
        worker.addEventListener("message", () => {
            if (generation !== this.workerGeneration) return
            if (player === "A") this.responseCountA++
            else this.responseCountB++
            const count = player === "A" ? this.responseCountA : this.responseCountB
            this.setWorkerState(player, `actif · ${count} ordre${count > 1 ? "s" : ""}`, "active")
        })
        worker.addEventListener("error", event => {
            if (generation !== this.workerGeneration) return
            this.setWorkerState(player, "erreur worker", "error")
            this.setStatus(`Erreur du bot ${player} (${scriptName(script)}) : ${event.message || "chargement impossible"}`, true)
            this.addEvent(`Erreur du worker ${player} : ${event.message || script}`)
        })
        worker.addEventListener("messageerror", () => {
            if (generation !== this.workerGeneration) return
            this.setWorkerState(player, "message invalide", "error")
            this.setStatus(`Le bot ${player} a envoyé un message illisible.`, true)
        })
        return worker
    }

    private frame(time: number) {
        const elapsed = Math.min(250, time - this.lastFrame)
        this.lastFrame = time
        if (this.running && this.gestionMonde) {
            this.accumulator += elapsed * this.stepsPerSecond() / 1000
            if (this.accumulator >= 1 && this.running && !this.stepInFlight) {
                void this.executeStep()
                this.accumulator--
            }
        }
        if (this.root.dataset.mode === "playing") this.draw(time)
        if (time - this.lastUiUpdate >= 160) {
            this.refreshUi()
            this.lastUiUpdate = time
        }
        this.requestId = requestAnimationFrame(next => this.frame(next))
    }

    private async executeStep() {
        if (this.gestionMonde.combatResult || this.stepInFlight) return
        this.stepInFlight = true
        try {
            const result = await this.gestionMonde.step()
            this.tick = this.gestionMonde.combatTick
            this.detectWorldEvents()
            if (result) {
                this.finishMatch(result)
                return
            }
            this.dispatchManualTargetQueues()
            this.pauseForManualOrdersIfNeeded()
        } finally {
            this.stepInFlight = false
        }
    }

    private manualWaitingDrones() {
        const joueur = this.manualJoueur()
        if (!joueur) return []
        return this.gestionMonde.droneStates
            .filter(state => state.ref.joueur === joueur && state.type === "wait")
            .map(state => state.ref)
    }

    private toggleManualTargets() {
        this.showManualTargets = !this.showManualTargets
        this.targetToggleButton.setAttribute("aria-pressed", String(this.showManualTargets))
        this.targetToggleButton.textContent = this.showManualTargets
            ? "Masquer les cibles"
            : "Afficher les cibles"
    }

    private manualTargetLabel(target: GameElement) {
        if (target instanceof Drone) return `Drone ${this.playerName(target.joueur)} #${shortId(target.id)}`
        if (target instanceof Usine) return `Usine · ${TECHNOLOGY_VISUALS[target.technologie].label}`
        if (target instanceof Energie) return `Énergie #${shortId(target.id)}`
        return `Vie #${shortId(target.id)}`
    }

    private enqueueManualTarget(drone: Drone, target: GameElement) {
        const queue = this.manualTargetQueues.get(drone.id) ?? []
        const activeTarget = drone.cible?.cible
        const targetAlreadyScheduled = (
            activeTarget instanceof GameElement
            && activeTarget.id === target.id
        ) || queue.some(queued => queued.targetId === target.id)
        if (targetAlreadyScheduled) return undefined

        queue.push({
            targetId: target.id,
            position: { x: target.position.x, y: target.position.y },
            label: this.manualTargetLabel(target)
        })
        this.manualTargetQueues.set(drone.id, queue)
        return queue.length
    }

    private validQueuedTarget(target: GameElement | undefined, joueur: Joueur) {
        if (!target || !this.gestionMonde.entities.includes(target)) return false
        if (target instanceof Drone && target.joueur === joueur) return false
        if ((target instanceof Energie || target instanceof Vie) && target.proprietaire) return false
        return true
    }

    private dispatchManualTargetQueues() {
        const joueur = this.manualJoueur()
        if (!joueur) return
        for (const [droneId, queue] of [...this.manualTargetQueues]) {
            const drone = this.gestionMonde.drones().find(value =>
                value.id === droneId && value.joueur === joueur
            )
            if (!drone) {
                this.manualTargetQueues.delete(droneId)
                continue
            }
            if (!this.droneIsReadyForManualOrder(drone) || drone.cible) continue

            let assigned = false
            while (queue.length > 0 && !assigned) {
                const next = queue.shift()!
                const target = this.gestionMonde.entities.find(value => value.id === next.targetId)
                if (!this.validQueuedTarget(target, joueur)) continue
                assigned = this.gestionMonde.initDroneState(joueur, drone.id, target!.id)
                if (assigned) {
                    const player = this.manualPlayer!
                    const count = player === "A" ? ++this.responseCountA : ++this.responseCountB
                    this.setWorkerState(player, `manuel · ${count} ordre${count > 1 ? "s" : ""}`, "active")
                    this.addEvent(
                        `Séquence manuelle ${player} : drone #${shortId(drone.id)} vers ${this.manualTargetLabel(target!)}`
                    )
                }
            }
            if (queue.length === 0) this.manualTargetQueues.delete(droneId)
        }
        this.updateManualSequenceControl()
    }

    private manualRoute(drone: Drone) {
        const route: Array<ManualQueuedTarget & { active: boolean }> = []
        const activeTarget = drone.cible?.cible
        if (activeTarget instanceof GameElement) {
            route.push({
                targetId: activeTarget.id,
                position: { x: activeTarget.position.x, y: activeTarget.position.y },
                label: this.manualTargetLabel(activeTarget),
                active: true
            })
        }
        for (const queued of this.manualTargetQueues.get(drone.id) ?? []) {
            const currentTarget = this.gestionMonde.entities.find(value => value.id === queued.targetId)
            route.push({
                ...queued,
                position: currentTarget
                    ? { x: currentTarget.position.x, y: currentTarget.position.y }
                    : queued.position,
                active: false
            })
        }
        return route
    }

    private updateManualSequenceControl() {
        if (!this.sequenceResetButton) return
        const drone = this.manualSelectedDrone
        if (!drone || !this.gestionMonde.entities.includes(drone)) {
            this.sequenceResetButton.disabled = true
            this.sequenceResetButton.textContent = "Vider la pile"
            return
        }
        const queuedCount = this.manualTargetQueues.get(drone.id)?.length ?? 0
        this.sequenceResetButton.disabled = queuedCount === 0
        this.sequenceResetButton.textContent = queuedCount > 0
            ? `Vider la pile (${queuedCount})`
            : "Pile vide"
    }

    private clearSelectedDroneSequence() {
        const drone = this.manualSelectedDrone
        if (!drone) return
        const removed = this.manualTargetQueues.get(drone.id)?.length ?? 0
        this.manualTargetQueues.delete(drone.id)
        this.updateManualSequenceControl()
        this.updateManualHelp(
            removed > 0
                ? `${removed} cible${removed > 1 ? "s" : ""} suivante${removed > 1 ? "s" : ""} supprimée${removed > 1 ? "s" : ""}. La cible active est conservée.`
                : "La pile de cibles est déjà vide.",
            removed > 0 ? "success" : "idle"
        )
    }

    private updateManualDroneList() {
        const joueur = this.manualJoueur()
        const ownDrones = joueur
            ? this.gestionMonde.drones()
                .filter(drone => drone.joueur === joueur)
                .sort((a, b) => a.id.localeCompare(b.id))
            : []
        const availableDrones = ownDrones.filter(drone => this.droneIsReadyForManualOrder(drone))
        const busyDrones = ownDrones.filter(drone => !this.droneIsReadyForManualOrder(drone))
        this.manualDroneCountElement.textContent = String(availableDrones.length)
        this.retargetableDroneCountElement.textContent = String(busyDrones.length)
        const droneSignature = (drone: Drone) => [
            drone.id,
            drone.energieCount,
            drone.vieCount,
            this.manualSelectedDrone === drone
        ].join(":")
        const signature = `D:${availableDrones.map(droneSignature).join("|")}`
            + `;M:${busyDrones.map(droneSignature).join("|")}`
        if (signature === this.manualDroneListSignature) return
        this.manualDroneListSignature = signature
        const availableHtml = availableDrones.length === 0
            ? '<span class="game-drone-list-empty">Aucun drone disponible</span>'
            : availableDrones.map(drone => {
                const mission = this.droneCanAttackManually(drone) ? "ATTAQUE" : "RESSOURCE"
                return `
                    <button class="game-drone-list-button" type="button"
                        data-drone-id="${escapeHtml(drone.id)}"
                        data-selected="${this.manualSelectedDrone === drone}">
                        <span>Drone #${shortId(drone.id)}</span>
                        <small>${mission} · E${drone.energieCount} V${drone.vieCount}</small>
                    </button>
                `
            }).join("")
        const retargetableHtml = busyDrones.length === 0
            ? '<span class="game-drone-list-empty">Aucun drone occupé</span>'
            : busyDrones.map(drone => `
                <button class="game-drone-list-button" type="button"
                    data-state="modifiable"
                    data-drone-id="${escapeHtml(drone.id)}"
                    data-selected="${this.manualSelectedDrone === drone}">
                    <span>Drone #${shortId(drone.id)}</span>
                    <small>AJOUTER À LA PILE · E${drone.energieCount} V${drone.vieCount}</small>
                </button>
            `).join("")
        this.manualDroneListElement.innerHTML = availableHtml
        this.retargetableDroneListElement.innerHTML = retargetableHtml
    }

    private selectDroneFromList(event: Event) {
        const origin = event.target
        if (!(origin instanceof globalThis.Element)) return
        const button = origin.closest<HTMLButtonElement>("button[data-drone-id]")
        if (!button) return
        const joueur = this.manualJoueur()
        if (!joueur) return
        const drone = this.gestionMonde.drones().find(value =>
            value.id === button.dataset.droneId && value.joueur === joueur
        )
        if (!drone) {
            this.updateManualHelp("Ce drone n’est plus disponible.", "error")
            this.updateManualDroneList()
            return
        }
        this.hovered = drone
        this.updateInspector()
        this.selectManualSource(drone, joueur)
        this.updateManualDroneList()
    }

    private manualFactoriesWithNewDrone() {
        const joueur = this.manualJoueur()
        if (!joueur) return []
        return this.gestionMonde.usines().filter(usine => {
            const newDrone = usine.etat?.joueur === joueur ? usine.etat.newDrone : undefined
            return Boolean(
                newDrone
                && this.gestionMonde.entities.includes(newDrone)
                && this.droneIsReadyForManualOrder(newDrone)
            )
        })
    }

    private manualDecisionNeeded() {
        return this.manualFactoriesWithNewDrone().length > 0 || this.manualWaitingDrones().length > 0
    }

    private allManualDronesHaveTarget() {
        const joueur = this.manualJoueur()
        if (!joueur) return false
        const drones = this.gestionMonde.drones().filter(drone => drone.joueur === joueur)
        return drones.length > 0 && drones.every(drone => Boolean(drone.cible))
    }

    private pauseForManualOrdersIfNeeded() {
        if (!this.manualPlayer || !this.running || this.gestionMonde.combatResult || !this.manualDecisionNeeded()) return
        this.running = false
        this.manualTurnPaused = true
        this.accumulator = 0
        this.clearManualSelection(false)
        this.updateContinueControl()
        this.updateManualHelp(
            "Tour en pause · donnez une cible à chaque drone disponible, puis cliquez sur Continuer.",
            "selected"
        )
        this.refreshUi()
    }

    private updateContinueControl() {
        const activeManualMatch = Boolean(
            this.manualPlayer
            && !this.gestionMonde.combatResult
            && this.root.dataset.mode === "playing"
            && (this.running || this.manualTurnPaused)
        )
        this.continueButton.hidden = !activeManualMatch
        if (!activeManualMatch) {
            this.continueButton.disabled = true
            this.continueButton.textContent = "Continuer"
            this.continueButton.title = ""
            return
        }
        if (this.running) {
            const hasDrones = this.gestionMonde.drones().length > 0
            this.continueButton.disabled = !hasDrones
            this.continueButton.textContent = "Pause"
            this.continueButton.title = hasDrones
                ? "Mettre la simulation en pause pour modifier les ordres"
                : "La pause sera disponible dès qu’un drone sera présent"
            return
        }

        const ready = this.allManualDronesHaveTarget()
        this.continueButton.disabled = !ready
        this.continueButton.textContent = ready ? "Continuer" : "Cibles manquantes"
        this.continueButton.title = ready
            ? "Reprendre la simulation"
            : "Tous les drones du joueur doivent avoir une cible"
    }

    private toggleManualSimulation() {
        if (!this.manualPlayer || this.gestionMonde.combatResult) return
        if (!this.running) {
            this.continueManualTurn()
            return
        }
        if (this.gestionMonde.drones().length === 0) return

        this.running = false
        this.manualTurnPaused = true
        this.accumulator = 0
        this.updateContinueControl()
        this.updateManualHelp(
            "Simulation en pause · sélectionnez un drone pour consulter ou compléter sa pile de cibles.",
            "selected"
        )
        this.refreshUi()
    }

    private continueManualTurn() {
        if (!this.manualTurnPaused || this.gestionMonde.combatResult) return
        if (!this.allManualDronesHaveTarget()) {
            this.updateManualHelp("Impossible de continuer : au moins un drone attend encore une cible.", "error")
            this.updateContinueControl()
            return
        }
        this.manualTurnPaused = false
        this.clearManualSelection(false)
        this.running = true
        this.accumulator = 0
        this.updateManualHelp("Simulation reprise.", "success")
        this.refreshUi()
    }

    private stepsPerSecond() {
        return Math.max(1, Number(this.speedInput.value) || 1)
    }

    private remainingTime() {
        const remainingTicks = Math.max(0, this.gestionMonde.config.COMBAT_TIME - this.tick)
        const remainingSeconds = Math.ceil(remainingTicks / this.stepsPerSecond())
        const minutes = Math.floor(remainingSeconds / 60)
        const seconds = remainingSeconds % 60
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    }

    private refreshUi() {
        if (!this.gestionMonde) return
        if (this.root.dataset.mode === "tournament") return
        const result = this.gestionMonde.combatResult
        this.speedValue.textContent = `${this.stepsPerSecond()}/s`
        const a = this.playerSummary(this.gestionMonde.joueurA)
        const b = this.playerSummary(this.gestionMonde.joueurB)
        const moving = this.gestionMonde.droneStates.filter(state => state.type === "move").length
        const mode = result ? "TERMINÉ" : this.running ? "LIVE" : "PAUSE"
        const resultChip = result
            ? `<span class="game-chip">Résultat <strong>${result.winner ? `Victoire ${this.playerName(result.winner)}` : "Match nul"}</strong></span>`
            : ""
        this.scoreElement.innerHTML = `
            <span class="game-chip">Tick <strong>${this.tick}</strong></span>
            <span class="game-chip">Durée <strong>${Math.min(this.tick, this.gestionMonde.config.COMBAT_TIME)} / ${this.gestionMonde.config.COMBAT_TIME}</strong></span>
            <span class="game-chip">Mode <strong>${mode}</strong></span>
            <span class="game-chip" style="border-color:${PLAYER_A_COLOR}66">A <strong>${a.usines}U · ${a.drones}D</strong></span>
            <span class="game-chip" style="border-color:${PLAYER_B_COLOR}66">B <strong>${b.usines}U · ${b.drones}D</strong></span>
            <span class="game-chip">En mouvement <strong>${moving}</strong></span>
            ${resultChip}
        `
        this.statsElement.innerHTML = this.statsHtml(a, b)
        this.hudAElement.textContent = `${a.usines} usine${a.usines > 1 ? "s" : ""} · ${a.drones} drone${a.drones > 1 ? "s" : ""}`
        this.hudBElement.textContent = `${b.usines} usine${b.usines > 1 ? "s" : ""} · ${b.drones} drone${b.drones > 1 ? "s" : ""}`
        this.hudUpgradesAElement.innerHTML = this.hudUpgradesHtml(a)
        this.hudUpgradesBElement.innerHTML = this.hudUpgradesHtml(b)
        this.hudBotStateAElement.innerHTML = botStateFormHtml(this.gestionMonde.dataLogA)
        this.hudBotStateBElement.innerHTML = botStateFormHtml(this.gestionMonde.dataLogB)
        this.hudTimeElement.textContent = this.remainingTime()
        this.hudTimeLabelElement.textContent = result
            ? result.winner
                ? `Victoire joueur ${this.playerName(result.winner)}`
                : "Match nul"
            : "Temps restant"
        this.updateInspector()
        this.updateManualDroneList()
        this.updateManualSequenceControl()
        this.updateContinueControl()
        this.eventsElement.innerHTML = this.events
            .slice(-24)
            .reverse()
            .map(event => `<div class="game-event"><strong>T${event.split("|")[0]}</strong> · ${escapeHtml(event.split("|").slice(1).join("|"))}</div>`)
            .join("")
    }

    private playerSummary(player: Joueur) {
        const usines = this.gestionMonde.usines().filter(usine => usine.etat?.joueur === player)
        const drones = this.gestionMonde.drones().filter(drone => drone.joueur === player)
        return {
            usines: usines.length,
            drones: drones.length,
            energie: drones.reduce((sum, drone) => sum + drone.energieCount, 0),
            vie: drones.reduce((sum, drone) => sum + drone.vieCount, 0),
            stock: usines.reduce((sum, usine) => sum + (usine.etat?.vieCount ?? 0), 0),
            technologies: TECHNOLOGIES.map(technologie => ({
                technologie,
                count: usines.filter(usine => usine.technologie === technologie).length,
                enabled: this.gestionMonde.isTechnologyEnabled(technologie)
            }))
        }
    }

    private hudUpgradesHtml(stats: ReturnType<AlgoFightManualGame["playerSummary"]>) {
        return stats.technologies
            .map(({ technologie, count, enabled }) => {
                const visual = TECHNOLOGY_VISUALS[technologie]
                return `
                <div class="game-hud-upgrade" data-enabled="${enabled}" data-active="${enabled && count > 0}" title="${enabled ? escapeHtml(visual.effect) : "Pouvoir verrouillé pour ce niveau"}">
                    <img src="${visual.url}" alt="">
                    ${escapeHtml(visual.label)} <b>${enabled ? `+${count}` : "🔒"}</b>
                </div>
            `
            })
            .join("")
    }

    private statsHtml(a: ReturnType<AlgoFightManualGame["playerSummary"]>, b: ReturnType<AlgoFightManualGame["playerSummary"]>) {
        const resources = this.gestionMonde.ressources()
        const freeEnergy = resources.filter(value => value instanceof Energie && !value.proprietaire).length
        const freeLife = resources.filter(value => value instanceof Vie && !value.proprietaire).length
        return `
            <div class="game-kpis">
                <div class="game-kpi"><span>Usines neutres</span><strong>${this.gestionMonde.usines().filter(usine => !usine.etat).length}</strong></div>
                <div class="game-kpi"><span>Drones</span><strong>${this.gestionMonde.drones().length}</strong></div>
                <div class="game-kpi"><span>Énergies libres</span><strong>${freeEnergy}</strong></div>
                <div class="game-kpi"><span>Vies libres</span><strong>${freeLife}</strong></div>
            </div>
            ${this.playerStatsHtml("A", a)}
            ${this.playerStatsHtml("B", b)}
        `
    }

    private playerStatsHtml(player: PlayerKey, stats: ReturnType<AlgoFightManualGame["playerSummary"]>) {
        return `
            <div class="game-player-stats ${player.toLowerCase()}">
                <div class="game-player-title"><span>Joueur ${player}</span><span>${stats.usines} usine${stats.usines > 1 ? "s" : ""}</span></div>
                <div class="game-small-grid">
                    <div><strong>${stats.drones}</strong>Drones</div>
                    <div><strong>${stats.energie}</strong>Énergie</div>
                    <div><strong>${stats.vie}</strong>Vie</div>
                    <div><strong>${stats.stock}</strong>Stock usine</div>
                    <div><strong>${player === "A" ? this.responseCountA : this.responseCountB}</strong>Ordres</div>
                    <div><strong>${stats.usines + stats.drones}</strong>Score</div>
                </div>
                <table class="game-tech"><tbody>
                    ${stats.technologies.map(value => {
                        const visual = TECHNOLOGY_VISUALS[value.technologie]
                        return `<tr><td><img src="${visual.url}" alt="" width="20" height="20" style="vertical-align:middle;object-fit:contain;margin-right:5px;${value.enabled ? "" : "filter:grayscale(1);opacity:.45"}">${visual.label}</td><td>${value.enabled ? value.count : "🔒"}</td></tr>`
                    }).join("")}
                </tbody></table>
            </div>
        `
    }

    private draw(time: number) {
        if (!this.gestionMonde) return
        const rect = this.canvas.getBoundingClientRect()
        const width = Math.max(1, rect.width)
        const height = Math.max(1, rect.height)
        const dpr = window.devicePixelRatio || 1
        const pixelWidth = Math.round(width * dpr)
        const pixelHeight = Math.round(height * dpr)
        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.ctx.imageSmoothingEnabled = false
        this.ctx.fillStyle = "#c8cdd4"
        this.ctx.fillRect(0, 0, width, height)

        const scale = this.fittedScale(width, height) * this.zoom
        this.syncCanvasView(width, height, scale)
        const { offsetX, offsetY } = this.view

        this.ctx.save()
        this.ctx.translate(offsetX, offsetY)
        this.ctx.scale(scale, scale)
        this.drawGrid(scale)
        this.drawResources(scale)
        this.drawFactories(time, scale)
        this.drawManualTargetArrows(time, scale)
        this.drawResourceActions(time, scale)
        this.drawDrones(scale)
        this.drawManualAvailabilityIndicators(time, scale)
        this.drawManualSelection(time, scale)
        this.drawPendingDestroyedDrones(time, scale)
        this.drawDroneLaunches(time, scale)
        this.drawFactoryActions(time, scale)
        this.drawAttackLasers(time, scale)
        this.drawExplosions(time, scale)
        this.ctx.restore()
    }

    private drawGrid(scale: number) {
        this.ctx.fillStyle = "#d3d7dc"
        this.ctx.fillRect(0, 0, this.worldWidth, this.worldHeight)
        this.ctx.strokeStyle = "rgba(50, 63, 80, .18)"
        this.ctx.lineWidth = 1 / scale
        for (let x = 0; x <= this.worldWidth; x += 50) {
            this.ctx.beginPath()
            this.ctx.moveTo(x, 0)
            this.ctx.lineTo(x, this.worldHeight)
            this.ctx.stroke()
        }
        for (let y = 0; y <= this.worldHeight; y += 50) {
            this.ctx.beginPath()
            this.ctx.moveTo(0, y)
            this.ctx.lineTo(this.worldWidth, y)
            this.ctx.stroke()
        }
        this.ctx.strokeStyle = "rgba(48, 59, 74, .68)"
        this.ctx.lineWidth = 2 / scale
        this.ctx.strokeRect(0, 0, this.worldWidth, this.worldHeight)
    }

    private drawResources(scale: number) {
        for (const resource of this.gestionMonde.ressources()) {
            if (resource.proprietaire) continue
            const color = resource instanceof Energie ? "#ffad32" : "#5ce6bd"
            const state: ResourceSpriteState = resource instanceof Energie ? "energy" : "life"
            const sprite = this.resourceSprites.get(state)
            const hovered = this.hovered === resource
            const size = (hovered ? 36 : 30) / scale

            this.ctx.save()
            this.ctx.translate(resource.position.x, resource.position.y)
            this.ctx.globalAlpha = 1
            this.ctx.globalCompositeOperation = "source-over"
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = (hovered ? 5 : 2) / scale
            if (sprite?.complete && sprite.naturalWidth > 0) {
                this.ctx.drawImage(sprite, -size / 2, -size / 2, size, size)
            }
            this.ctx.restore()
        }
    }

    private drawFactories(time: number, scale: number) {
        for (const usine of this.gestionMonde.usines()) {
            const color = usine.etat ? this.playerColor(usine.etat.joueur) : NEUTRAL_COLOR
            const hovered = this.hovered === usine
            const building = this.factoryIsBuilding(usine)
            const spriteState: FactorySpriteState = building ? "building" : "idle"
            const sprite = this.factorySprites.get(spriteState)
            const pulse = building ? 1 + Math.sin(time / 105 + usine.position.x) * .035 : 1
            const size = (hovered ? 72 : 64) * pulse / scale

            this.ctx.save()
            this.ctx.translate(usine.position.x, usine.position.y)
            this.ctx.shadowColor = building ? "#ffb52e" : color
            this.ctx.shadowBlur = (building ? 8 : hovered ? 5 : 2) / scale

            if (sprite?.complete && sprite.naturalWidth > 0) {
                this.ctx.globalAlpha = 1
                this.ctx.drawImage(sprite, -size / 2, -size / 2, size, size)
            } else {
                const radius = size * .32
                this.ctx.globalAlpha = 1
                this.ctx.fillStyle = color
                this.ctx.strokeStyle = hovered ? "#ffffff" : color
                this.ctx.lineWidth = (hovered ? 3 : 2) / scale
                this.ctx.beginPath()
                for (let side = 0; side < 6; side++) {
                    const angle = Math.PI / 3 * side - Math.PI / 2
                    const x = Math.cos(angle) * radius
                    const y = Math.sin(angle) * radius
                    if (side === 0) this.ctx.moveTo(x, y)
                    else this.ctx.lineTo(x, y)
                }
                this.ctx.closePath()
                this.ctx.fill()
                this.ctx.stroke()
            }

            this.ctx.globalAlpha = 1
            this.ctx.shadowBlur = 0
            this.ctx.strokeStyle = hovered ? "#ffffff" : color
            this.ctx.lineWidth = (hovered ? 2.5 : 1.8) / scale
            this.ctx.beginPath()
            for (let side = 0; side < 6; side++) {
                const angle = Math.PI / 3 * side - Math.PI / 2
                const radius = size * .43
                const x = Math.cos(angle) * radius
                const y = Math.sin(angle) * radius
                if (side === 0) this.ctx.moveTo(x, y)
                else this.ctx.lineTo(x, y)
            }
            this.ctx.closePath()
            this.ctx.stroke()

            // Un anneau extérieur, réservé aux usines possédées, permet de
            // reconnaître immédiatement leur joueur sans masquer le sprite
            // ni l'icône de technologie placée au centre.
            if (usine.etat) {
                const ownerRingRadius = size * .57
                this.ctx.save()
                this.ctx.globalAlpha = 1
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 4 / scale
                this.ctx.strokeStyle = "rgba(24, 34, 52, .82)"
                this.ctx.lineWidth = 7 / scale
                this.ctx.beginPath()
                this.ctx.arc(0, 0, ownerRingRadius, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.shadowBlur = 0
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 4 / scale
                this.ctx.beginPath()
                this.ctx.arc(0, 0, ownerRingRadius, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.restore()
            }

            const technologySprite = this.technologySprites.get(usine.technologie)
            if (technologySprite?.complete && technologySprite.naturalWidth > 0) {
                const technologyEnabled = this.gestionMonde.isTechnologyEnabled(usine.technologie)
                const technologyColor = TECHNOLOGY_VISUALS[usine.technologie].color
                const iconSize = (hovered ? 25 : 22) / scale
                const backingRadius = (hovered ? 14 : 12.5) / scale
                this.ctx.save()
                this.ctx.shadowBlur = 0
                this.ctx.fillStyle = "rgba(2, 6, 14, .88)"
                this.ctx.strokeStyle = technologyEnabled ? technologyColor : "#6c7481"
                this.ctx.lineWidth = 1.4 / scale
                this.ctx.beginPath()
                this.ctx.arc(0, 0, backingRadius, 0, Math.PI * 2)
                this.ctx.fill()
                this.ctx.stroke()
                this.ctx.shadowColor = technologyEnabled ? technologyColor : "transparent"
                this.ctx.shadowBlur = technologyEnabled ? 5 / scale : 0
                this.ctx.globalAlpha = technologyEnabled ? 1 : .32
                this.ctx.drawImage(technologySprite, -iconSize / 2, -iconSize / 2, iconSize, iconSize)
                if (!technologyEnabled) {
                    this.ctx.globalAlpha = 1
                    this.ctx.strokeStyle = "#dce1e8"
                    this.ctx.lineWidth = 2 / scale
                    this.ctx.beginPath()
                    this.ctx.moveTo(-7 / scale, -7 / scale)
                    this.ctx.lineTo(7 / scale, 7 / scale)
                    this.ctx.moveTo(7 / scale, -7 / scale)
                    this.ctx.lineTo(-7 / scale, 7 / scale)
                    this.ctx.stroke()
                }
                this.ctx.restore()
            }

            if (building && usine.etat) {
                const buildDuration = Math.max(1, this.gestionMonde.buildTime(usine.etat.joueur))
                const progress = 1 - Math.min(1, Math.max(0, usine.etat.time) / buildDuration)
                const constructionRadius = size * .49
                this.ctx.rotate(time / 520)
                this.ctx.strokeStyle = "#ffd166"
                this.ctx.lineWidth = 2.5 / scale
                this.ctx.setLineDash([7 / scale, 6 / scale])
                this.ctx.beginPath()
                this.ctx.arc(0, 0, constructionRadius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
                this.ctx.stroke()
                this.ctx.setLineDash([])

                for (let index = 0; index < 6; index++) {
                    const angle = index * Math.PI / 3 + time / 310
                    const sparkRadius = constructionRadius * (.78 + .12 * Math.sin(time / 90 + index))
                    this.ctx.fillStyle = index % 2 === 0 ? "#ffffff" : "#ffb52e"
                    this.ctx.beginPath()
                    this.ctx.arc(
                        Math.cos(angle) * sparkRadius,
                        Math.sin(angle) * sparkRadius,
                        (index % 2 === 0 ? 1.8 : 2.7) / scale,
                        0,
                        Math.PI * 2
                    )
                    this.ctx.fill()
                }
            }
            this.ctx.restore()
        }
    }

    private factoryIsBuilding(usine: Usine) {
        return Boolean(
            usine.etat
            && !usine.etat.newDrone
            && usine.etat.populationCount < this.gestionMonde.getDronePopulation(usine.etat.joueur)
        )
    }

    private drawManualTargetArrows(time: number, scale: number) {
        if (!this.manualPlayer) return
        const joueur = this.manualJoueur()
        if (!joueur) return
        const color = this.manualPlayer === "A" ? PLAYER_A_COLOR : PLAYER_B_COLOR
        const pulse = .72 + Math.sin(time / 230) * .08
        const drones = this.showManualTargets
            ? this.gestionMonde.drones().filter(drone => drone.joueur === joueur)
            : this.manualSelectedDrone?.joueur === joueur ? [this.manualSelectedDrone] : []

        for (const drone of drones) {
            let origin = drone.position
            const route = this.manualRoute(drone)
            for (let index = 0; index < route.length; index++) {
                const target = route[index]
                this.drawManualRouteSegment(
                    origin,
                    target.position,
                    index === 0 ? 22 : 17,
                    19,
                    color,
                    target.active ? pulse : pulse * .78,
                    scale
                )
                this.drawManualRouteMarker(target.position, index + 1, color, target.active, scale)
                origin = target.position
            }
        }
    }

    private drawManualRouteSegment(
        origin: Position,
        target: Position,
        startPaddingPixels: number,
        endPaddingPixels: number,
        color: string,
        alpha: number,
        scale: number
    ) {
            const dx = target.x - origin.x
            const dy = target.y - origin.y
            const length = Math.hypot(dx, dy)
            if (length < .001) return
            const ux = dx / length
            const uy = dy / length
            const startPadding = startPaddingPixels / scale
            const endPadding = endPaddingPixels / scale
            if (length <= startPadding + endPadding) return
            const startX = origin.x + ux * startPadding
            const startY = origin.y + uy * startPadding
            const endX = target.x - ux * endPadding
            const endY = target.y - uy * endPadding
            const arrowSize = 11 / scale

            this.ctx.save()
            this.ctx.globalAlpha = alpha
            this.ctx.lineCap = "round"
            this.ctx.lineJoin = "round"
            this.ctx.setLineDash([])
            this.ctx.shadowColor = "rgba(24, 34, 52, .7)"
            this.ctx.shadowBlur = 3 / scale
            this.ctx.strokeStyle = "rgba(24, 34, 52, .86)"
            this.ctx.lineWidth = 6 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(startX, startY)
            this.ctx.lineTo(endX, endY)
            this.ctx.stroke()
            this.ctx.shadowBlur = 0
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 3 / scale
            this.ctx.stroke()

            this.ctx.fillStyle = "rgba(24, 34, 52, .9)"
            this.ctx.beginPath()
            this.ctx.moveTo(endX + ux * 3 / scale, endY + uy * 3 / scale)
            this.ctx.lineTo(
                endX - ux * arrowSize - uy * arrowSize * .65,
                endY - uy * arrowSize + ux * arrowSize * .65
            )
            this.ctx.lineTo(
                endX - ux * arrowSize + uy * arrowSize * .65,
                endY - uy * arrowSize - ux * arrowSize * .65
            )
            this.ctx.closePath()
            this.ctx.fill()
            this.ctx.fillStyle = color
            this.ctx.globalAlpha = 1
            this.ctx.beginPath()
            this.ctx.moveTo(endX, endY)
            this.ctx.lineTo(
                endX - ux * arrowSize - uy * arrowSize * .5,
                endY - uy * arrowSize + ux * arrowSize * .5
            )
            this.ctx.lineTo(
                endX - ux * arrowSize + uy * arrowSize * .5,
                endY - uy * arrowSize - ux * arrowSize * .5
            )
            this.ctx.closePath()
            this.ctx.fill()
            this.ctx.restore()
    }

    private drawManualRouteMarker(
        position: Position,
        index: number,
        color: string,
        active: boolean,
        scale: number
    ) {
        const radius = (active ? 11 : 10) / scale
        this.ctx.save()
        this.ctx.translate(position.x, position.y)
        this.ctx.fillStyle = "rgba(24, 34, 52, .9)"
        this.ctx.beginPath()
        this.ctx.arc(0, 0, radius + 2 / scale, 0, Math.PI * 2)
        this.ctx.fill()
        this.ctx.fillStyle = color
        this.ctx.beginPath()
        this.ctx.arc(0, 0, radius, 0, Math.PI * 2)
        this.ctx.fill()
        this.ctx.fillStyle = "#fff"
        this.ctx.font = `900 ${10 / scale}px ui-monospace, SFMono-Regular, Consolas, monospace`
        this.ctx.textAlign = "center"
        this.ctx.textBaseline = "middle"
        this.ctx.fillText(String(index), 0, .5 / scale)
        this.ctx.restore()
    }

    private drawDrones(scale: number) {
        for (const drone of this.gestionMonde.drones()) {
            const angle = this.droneAngle(drone)
            const hovered = this.hovered === drone
            this.ctx.save()
            this.ctx.translate(drone.position.x, drone.position.y)
            this.ctx.rotate(angle)
            const sprite = this.droneSpriteFor(drone.joueur)

            if (sprite) {
                const size = (hovered ? 44 : 38) / scale
                this.ctx.globalAlpha = 1
                this.ctx.globalCompositeOperation = "source-over"
                this.ctx.shadowColor = "rgba(235, 243, 255, .72)"
                this.ctx.shadowBlur = (hovered ? 5 : 0) / scale
                this.ctx.drawImage(sprite, -size / 2, -size / 2, size, size)
            }
            this.ctx.restore()
        }
    }

    private drawManualAvailabilityIndicators(time: number, scale: number) {
        if ((!this.running && !this.manualTurnPaused) || !this.manualPlayer || this.gestionMonde.combatResult) return
        const joueur = this.manualJoueur()
        if (!joueur) return
        const pulse = Math.sin(time / 180) * 1.5

        for (const usine of this.gestionMonde.usines()) {
            const newDrone = usine.etat?.joueur === joueur ? usine.etat.newDrone : undefined
            if (!newDrone || !this.droneIsReadyForManualOrder(newDrone)) continue
            this.drawManualBadge(usine.position, "D+", "#37e686", "#123e2b", 45 + pulse, scale)
        }

        for (const drone of this.gestionMonde.drones()) {
            if (drone.joueur !== joueur) continue
            if (this.droneCanBeRetargeted(drone)) {
                this.drawManualBadge(drone.position, "MOD", "#ffbd4a", "#805216", 27, scale)
            } else if (!this.droneIsReadyForManualOrder(drone)) {
                this.drawManualBadge(drone.position, "ACT", "#7b8797", "#394352", 27, scale)
            } else if (this.droneCanAttackManually(drone)) {
                this.drawManualBadge(drone.position, "ATK", "#37e686", "#12613a", 27 + pulse, scale)
            } else {
                this.drawManualBadge(drone.position, "RESS", "#37e686", "#12613a", 27 + pulse, scale)
            }
        }
    }

    private drawManualBadge(
        position: Position,
        label: string,
        borderColor: string,
        backgroundColor: string,
        offset: number,
        scale: number
    ) {
        const width = (label.length * 7 + 10) / scale
        const height = 18 / scale
        this.ctx.save()
        this.ctx.translate(position.x, position.y - offset / scale)
        this.ctx.globalAlpha = 1
        this.ctx.shadowBlur = 0
        this.ctx.fillStyle = "#172033"
        this.ctx.fillRect(-width / 2 - 2 / scale, -height / 2 - 2 / scale, width + 4 / scale, height + 4 / scale)
        this.ctx.fillStyle = backgroundColor
        this.ctx.fillRect(-width / 2, -height / 2, width, height)
        this.ctx.strokeStyle = borderColor
        this.ctx.lineWidth = 2 / scale
        this.ctx.strokeRect(-width / 2, -height / 2, width, height)
        this.ctx.fillStyle = "#ffffff"
        this.ctx.font = `900 ${10 / scale}px ui-monospace, SFMono-Regular, Consolas, monospace`
        this.ctx.textAlign = "center"
        this.ctx.textBaseline = "middle"
        this.ctx.fillText(label, 0, .5 / scale)
        this.ctx.restore()
    }

    private drawManualSelection(time: number, scale: number) {
        const drone = this.manualSelectedDrone
        if (!drone) return
        if (!this.gestionMonde.entities.includes(drone) || drone.joueur !== this.manualJoueur()) {
            this.clearManualSelection()
            this.updateManualHelp("L’unité sélectionnée n’est plus disponible.", "error")
            return
        }

        const source = this.manualSelectedFactory ?? drone
        const halfSize = ((source instanceof Usine ? 41 : 25) + Math.sin(time / 150) * 2) / scale
        const cornerLength = 9 / scale
        const color = this.manualPlayer === "A" ? PLAYER_A_COLOR : PLAYER_B_COLOR
        const drawCorners = () => {
            this.ctx.beginPath()
            this.ctx.moveTo(-halfSize, -halfSize + cornerLength)
            this.ctx.lineTo(-halfSize, -halfSize)
            this.ctx.lineTo(-halfSize + cornerLength, -halfSize)
            this.ctx.moveTo(halfSize - cornerLength, -halfSize)
            this.ctx.lineTo(halfSize, -halfSize)
            this.ctx.lineTo(halfSize, -halfSize + cornerLength)
            this.ctx.moveTo(halfSize, halfSize - cornerLength)
            this.ctx.lineTo(halfSize, halfSize)
            this.ctx.lineTo(halfSize - cornerLength, halfSize)
            this.ctx.moveTo(-halfSize + cornerLength, halfSize)
            this.ctx.lineTo(-halfSize, halfSize)
            this.ctx.lineTo(-halfSize, halfSize - cornerLength)
            this.ctx.stroke()
        }

        this.ctx.save()
        this.ctx.translate(source.position.x, source.position.y)
        this.ctx.setLineDash([])
        this.ctx.lineCap = "square"
        this.ctx.lineJoin = "miter"
        this.ctx.strokeStyle = "#172033"
        this.ctx.lineWidth = 6 / scale
        drawCorners()
        this.ctx.strokeStyle = color
        this.ctx.lineWidth = 3 / scale
        drawCorners()
        this.ctx.restore()
    }

    private droneAngle(drone: Drone) {
        const actionTarget = (drone.cible?.fireTime ?? 0) > 0 && drone.cible?.cible instanceof GameElement
            ? drone.cible.cible
            : undefined
        if (actionTarget) {
            const dx = actionTarget.position.x - drone.position.x
            const dy = actionTarget.position.y - drone.position.y
            if (Math.hypot(dx, dy) > .001) {
                return Math.atan2(dy, dx) + Math.PI / 2
            }
        }
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        const isMoving = state?.type === "move"
            && state.distance > 0
            && (drone.cible?.fireTime ?? 0) <= 0
            && Math.hypot(state.sx, state.sy) > 0
        if (isMoving) {
            return Math.atan2(state.sy, state.sx) + Math.PI / 2
        }
        const target = this.droneTargetPosition(drone)
        return target
            ? Math.atan2(target.y - drone.position.y, target.x - drone.position.x) + Math.PI / 2
            : 0
    }

    private drawPendingDestroyedDrones(time: number, scale: number) {
        for (const drone of this.pendingDroneDestructions.values()) {
            const attacker = this.gestionMonde.drones().find(value =>
                value.cible?.fireTime
                && value.cible.fireTime > 0
                && value.cible.cible === drone.ref
            )
            const fireTime = attacker?.cible?.fireTime ?? 0
            const progress = Math.min(1, Math.max(0, 1 - fireTime / this.gestionMonde.config.FIRE_TIME))
            const sprite = this.droneSpriteFor(drone.ref.joueur)
            if (!sprite) continue

            const size = 38 / scale
            this.ctx.save()
            this.ctx.translate(drone.position.x, drone.position.y)
            this.ctx.rotate(drone.angle)
            this.ctx.globalAlpha = 1
            this.ctx.globalCompositeOperation = "source-over"
            this.ctx.shadowColor = progress > .7 ? "#ff713d" : drone.color
            this.ctx.shadowBlur = (3 + progress * 7) / scale
            this.ctx.drawImage(sprite, -size / 2, -size / 2, size, size)

            if (progress > .68) {
                const warningProgress = (progress - .68) / .32
                this.ctx.rotate(-drone.angle + time / 260)
                this.ctx.globalAlpha = .35 + warningProgress * .55
                this.ctx.strokeStyle = "#ff8a3d"
                this.ctx.lineWidth = 2 / scale
                this.ctx.setLineDash([4 / scale, 5 / scale])
                this.ctx.beginPath()
                this.ctx.arc(0, 0, (20 + warningProgress * 4) / scale, 0, Math.PI * 2)
                this.ctx.stroke()
                this.ctx.setLineDash([])
            }
            this.ctx.restore()
        }
    }

    private drawDroneLaunches(time: number, scale: number) {
        const active: DroneLaunchAnimation[] = []
        for (const launch of this.launches) {
            const progress = (time - launch.startedAt) / launch.duration
            if (progress < 0 || progress >= 1) continue
            active.push(launch)

            const eased = 1 - Math.pow(1 - progress, 3)
            const radius = (8 + eased * 40) / scale
            this.ctx.save()
            this.ctx.globalAlpha = Math.pow(1 - progress, 2)
            this.ctx.strokeStyle = launch.color
            this.ctx.lineWidth = 3 / scale
            this.ctx.shadowColor = launch.color
            this.ctx.shadowBlur = 15 / scale
            this.ctx.beginPath()
            this.ctx.arc(launch.position.x, launch.position.y, radius, 0, Math.PI * 2)
            this.ctx.stroke()

            for (let index = 0; index < 12; index++) {
                const angle = index * Math.PI * 2 / 12 + progress * 1.8
                const distance = (10 + eased * (28 + index % 3 * 6)) / scale
                const px = launch.position.x + Math.cos(angle) * distance
                const py = launch.position.y + Math.sin(angle) * distance
                this.ctx.fillStyle = index % 3 === 0 ? "#ffffff" : launch.color
                this.ctx.beginPath()
                this.ctx.arc(px, py, (index % 3 === 0 ? 2.2 : 1.5) / scale, 0, Math.PI * 2)
                this.ctx.fill()
            }
            this.ctx.restore()
        }
        this.launches = active
    }

    private async loadSprites() {
        const [drones, factories, resources, technologies] = await Promise.all([
            Promise.all(
                (Object.keys(DRONE_APPEARANCES) as DroneAppearance[]).map(async appearance => {
                    return [appearance, await this.loadSprite(DRONE_APPEARANCES[appearance].url)] as const
                })
            ),
            Promise.all(
                (Object.keys(FACTORY_SPRITE_URLS) as FactorySpriteState[]).map(async state => {
                    return [state, await this.loadSprite(FACTORY_SPRITE_URLS[state])] as const
                })
            ),
            Promise.all(
                (Object.keys(RESOURCE_SPRITE_URLS) as ResourceSpriteState[]).map(async state => {
                    return [state, await this.loadSprite(RESOURCE_SPRITE_URLS[state])] as const
                })
            ),
            Promise.all(
                TECHNOLOGIES.map(async technology => {
                    return [technology, await this.loadSprite(TECHNOLOGY_VISUALS[technology].url)] as const
                })
            )
        ])
        this.droneSprites = new Map(drones)
        this.droneSprite = this.droneSprites.get("scout")
        this.factorySprites = new Map(factories)
        this.resourceSprites = new Map(resources)
        this.technologySprites = new Map(technologies)
        this.updatePlayerDroneSprites()
    }

    private selectedDroneAppearance(player: PlayerKey) {
        const value = (player === "A" ? this.droneAppearanceASelect : this.droneAppearanceBSelect).value
        return value in DRONE_APPEARANCES ? value as DroneAppearance : DEFAULT_DRONE_APPEARANCE[player]
    }

    private changeDroneAppearance(player: PlayerKey) {
        const selected = player === "A" ? this.droneAppearanceASelect : this.droneAppearanceBSelect
        const other = player === "A" ? this.droneAppearanceBSelect : this.droneAppearanceASelect
        if (selected.value === other.value) {
            const alternative = (Object.keys(DRONE_APPEARANCES) as DroneAppearance[])
                .find(appearance => appearance !== selected.value)
            if (alternative) other.value = alternative
        }
        this.updatePlayerDroneSprites()
        this.markPendingRestart("Les apparences ont changé. Cliquez sur « Lancer le combat ».")
    }

    private updatePlayerDroneSprites() {
        const spriteA = this.droneSprites.get(this.selectedDroneAppearance("A"))
        const spriteB = this.droneSprites.get(this.selectedDroneAppearance("B"))
        if (spriteA && spriteB) {
            this.playerDroneSprites = new Map([
                ["A", spriteA],
                ["B", spriteB]
            ])
        }
        this.updateDroneAppearanceUi()
    }

    private updateDroneAppearanceUi() {
        const appearanceA = this.selectedDroneAppearance("A")
        const appearanceB = this.selectedDroneAppearance("B")
        const previewA = DRONE_APPEARANCES[appearanceA].url
        const previewB = DRONE_APPEARANCES[appearanceB].url
        this.droneAppearancePreviewA.src = previewA
        this.droneAppearancePreviewB.src = previewB
    }

    private loadSprite(url: string) {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const sprite = new Image()
            sprite.decoding = "async"
            sprite.addEventListener("load", () => resolve(sprite), { once: true })
            sprite.addEventListener("error", () => reject(new Error(`Sprite introuvable : ${url}`)), { once: true })
            sprite.src = url
        })
    }

    private droneIntent(drone: Drone): DroneIntent {
        const target = drone.cible?.cible
        if (target instanceof Drone) return "attack"
        if (target instanceof Energie) return "collect"
        if (target instanceof Vie) return "repair"
        if (target instanceof Usine) {
            if (target.etat && target.etat.joueur !== drone.joueur) return "attack"
            return target.etat ? "collect" : "capture"
        }
        return "idle"
    }

    private drawResourceActions(time: number, scale: number) {
        for (const drone of this.gestionMonde.drones()) {
            const target = drone.cible?.cible
            const fireTime = drone.cible?.fireTime ?? 0
            if (!(target instanceof Energie || target instanceof Vie) || fireTime <= 0) continue

            const progress = Math.min(1, Math.max(0, 1 - fireTime / this.gestionMonde.config.FIRE_TIME))
            let dx = target.position.x - drone.position.x
            let dy = target.position.y - drone.position.y
            let distance = Math.hypot(dx, dy)
            if (distance < .001) {
                const fallbackAngle = drone.id.charCodeAt(0) % 2 === 0 ? -Math.PI / 3 : Math.PI / 3
                dx = Math.cos(fallbackAngle)
                dy = Math.sin(fallbackAngle)
                distance = 1
            }
            const ux = dx / distance
            const uy = dy / distance
            const px = -uy
            const py = ux
            const resourceX = target.position.x
            const resourceY = target.position.y
            const anchorX = drone.position.x
            const anchorY = drone.position.y
            const curveDirection = drone.id.charCodeAt(1) % 2 === 0 ? 1 : -1
            const curveOffset = Math.max(0, 72 / scale - distance) * .88 * curveDirection
                + Math.sin(time / 115 + progress * 8) * 1.8 / scale
            const controlX = (anchorX + resourceX) / 2 + px * curveOffset
            const controlY = (anchorY + resourceY) / 2 + py * curveOffset

            let extension: number
            if (progress < .42) {
                const phase = progress / .42
                extension = 1 - Math.pow(1 - phase, 3)
            } else if (progress < .58) {
                extension = 1
            } else {
                const phase = (progress - .58) / .42
                extension = 1 - phase * phase * (3 - 2 * phase)
            }

            const jointX = anchorX + (controlX - anchorX) * extension
            const jointY = anchorY + (controlY - anchorY) * extension
            const secondControlX = controlX + (resourceX - controlX) * extension
            const secondControlY = controlY + (resourceY - controlY) * extension
            const tipX = jointX + (secondControlX - jointX) * extension
            const tipY = jointY + (secondControlY - jointY) * extension
            const color = target instanceof Energie ? "#ffad32" : "#5ce6bd"

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.lineJoin = "round"
            this.ctx.strokeStyle = "#020713"
            this.ctx.lineWidth = 8 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(anchorX, anchorY)
            this.ctx.lineTo(jointX, jointY)
            this.ctx.lineTo(tipX, tipY)
            this.ctx.stroke()

            this.ctx.strokeStyle = "#9eacc2"
            this.ctx.lineWidth = 4 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(anchorX, anchorY)
            this.ctx.lineTo(jointX, jointY)
            this.ctx.lineTo(tipX, tipY)
            this.ctx.stroke()

            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 1.25 / scale
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 5 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(anchorX, anchorY)
            this.ctx.lineTo(jointX, jointY)
            this.ctx.lineTo(tipX, tipY)
            this.ctx.stroke()

            this.ctx.shadowBlur = 0
            for (const joint of [{ x: jointX, y: jointY }, { x: tipX, y: tipY }]) {
                this.ctx.fillStyle = "#101b2d"
                this.ctx.strokeStyle = "#d7e2f2"
                this.ctx.lineWidth = 1.5 / scale
                this.ctx.beginPath()
                this.ctx.arc(joint.x, joint.y, 3.4 / scale, 0, Math.PI * 2)
                this.ctx.fill()
                this.ctx.stroke()
            }

            const clawLength = 7 / scale
            const clawWidth = 5 / scale
            const clawDx = tipX - jointX
            const clawDy = tipY - jointY
            const clawDistance = Math.max(.001, Math.hypot(clawDx, clawDy))
            const clawUx = clawDx / clawDistance
            const clawUy = clawDy / clawDistance
            const clawPx = -clawUy
            const clawPy = clawUx
            this.ctx.strokeStyle = "#e9f1ff"
            this.ctx.lineWidth = 2 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(tipX, tipY)
            this.ctx.lineTo(
                tipX + clawUx * clawLength + clawPx * clawWidth,
                tipY + clawUy * clawLength + clawPy * clawWidth
            )
            this.ctx.moveTo(tipX, tipY)
            this.ctx.lineTo(
                tipX + clawUx * clawLength - clawPx * clawWidth,
                tipY + clawUy * clawLength - clawPy * clawWidth
            )
            this.ctx.stroke()

            const carried = progress >= .5
            const itemX = carried ? tipX : resourceX
            const itemY = carried ? tipY : resourceY
            const spriteState: ResourceSpriteState = target instanceof Energie ? "energy" : "life"
            const sprite = this.resourceSprites.get(spriteState)
            if (sprite?.complete && sprite.naturalWidth > 0) {
                const itemSize = (carried ? 23 : 29) / scale
                this.ctx.globalAlpha = 1
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 5 / scale
                this.ctx.drawImage(sprite, itemX - itemSize / 2, itemY - itemSize / 2, itemSize, itemSize)
            }
            this.ctx.restore()
        }
    }

    private drawFactoryActions(time: number, scale: number) {
        for (const drone of this.gestionMonde.drones()) {
            const action = this.activeDroneActions.get(drone.id)
            const fireTime = drone.cible?.fireTime ?? 0
            if (
                !action
                || !(action.target instanceof Usine)
                || fireTime <= 0
                || !this.gestionMonde.entities.includes(action.target)
            ) {
                continue
            }
            if (action.type !== "repair-factory" && action.type !== "capture-factory") continue

            const target = action.target
            const progress = Math.min(1, Math.max(0, 1 - fireTime / this.gestionMonde.config.FIRE_TIME))
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

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.lineJoin = "round"

            if (action.type === "repair-factory") {
                const color = "#56f29a"
                const pulse = .72 + Math.sin(time / 95 + drone.position.x) * .22

                this.ctx.globalAlpha = pulse
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 4 / scale
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 11 / scale
                this.ctx.setLineDash([3 / scale, 7 / scale])
                this.ctx.lineDashOffset = -time / 38 / scale
                this.ctx.beginPath()
                this.ctx.moveTo(startX, startY)
                this.ctx.lineTo(endX, endY)
                this.ctx.stroke()
                this.ctx.setLineDash([])

                for (let index = 0; index < 3; index++) {
                    const packetProgress = (time / 680 + index / 3) % 1
                    const x = startX + (endX - startX) * packetProgress
                    const y = startY + (endY - startY) * packetProgress
                    this.ctx.globalAlpha = .75 + Math.sin(time / 80 + index) * .2
                    this.ctx.fillStyle = index === 1 ? "#ffffff" : color
                    this.ctx.beginPath()
                    this.ctx.arc(x, y, (2.5 + index % 2) / scale, 0, Math.PI * 2)
                    this.ctx.fill()
                }

                const ringRadius = (37 + Math.sin(time / 120) * 2.5) / scale
                this.ctx.globalAlpha = .82
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 2.5 / scale
                this.ctx.beginPath()
                this.ctx.arc(target.position.x, target.position.y, ringRadius, 0, Math.PI * 2)
                this.ctx.stroke()

                const plusSize = 8 / scale
                const plusY = target.position.y - 40 / scale
                this.ctx.globalAlpha = 1
                this.ctx.strokeStyle = "#ffffff"
                this.ctx.lineWidth = 4.5 / scale
                this.ctx.beginPath()
                this.ctx.moveTo(target.position.x - plusSize, plusY)
                this.ctx.lineTo(target.position.x + plusSize, plusY)
                this.ctx.moveTo(target.position.x, plusY - plusSize)
                this.ctx.lineTo(target.position.x, plusY + plusSize)
                this.ctx.stroke()
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 2 / scale
                this.ctx.stroke()
            } else {
                const color = "#a66cff"
                const pulse = .7 + Math.sin(time / 82 + target.position.y) * .25

                this.ctx.globalAlpha = pulse
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 3.5 / scale
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 13 / scale
                this.ctx.setLineDash([8 / scale, 6 / scale])
                this.ctx.lineDashOffset = time / 44 / scale
                this.ctx.beginPath()
                this.ctx.moveTo(startX, startY)
                this.ctx.lineTo(endX, endY)
                this.ctx.stroke()
                this.ctx.setLineDash([])

                for (let index = 0; index < 3; index++) {
                    const packetProgress = (time / 760 + index / 3) % 1
                    const x = startX + (endX - startX) * packetProgress
                    const y = startY + (endY - startY) * packetProgress
                    const size = (3.5 + Math.sin(time / 90 + index) * .8) / scale
                    this.ctx.save()
                    this.ctx.translate(x, y)
                    this.ctx.rotate(time / 260 + index)
                    this.ctx.globalAlpha = .9
                    this.ctx.fillStyle = index === 1 ? "#ffffff" : color
                    this.ctx.fillRect(-size, -size, size * 2, size * 2)
                    this.ctx.restore()
                }

                this.ctx.globalAlpha = .95
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 3 / scale
                this.ctx.beginPath()
                this.ctx.arc(
                    target.position.x,
                    target.position.y,
                    42 / scale,
                    -Math.PI / 2,
                    -Math.PI / 2 + Math.PI * 2 * progress
                )
                this.ctx.stroke()

                this.ctx.translate(target.position.x, target.position.y)
                this.ctx.rotate(time / 360)
                this.ctx.globalAlpha = .72
                this.ctx.lineWidth = 2 / scale
                for (let index = 0; index < 6; index++) {
                    const angle = index * Math.PI / 3
                    this.ctx.beginPath()
                    this.ctx.arc(0, 0, 36 / scale, angle, angle + Math.PI / 5)
                    this.ctx.stroke()
                }
            }
            this.ctx.restore()
        }
    }

    private drawAttackLasers(time: number, scale: number) {
        for (const drone of this.gestionMonde.drones()) {
            const action = this.activeDroneActions.get(drone.id)
            const fireTime = drone.cible?.fireTime ?? 0
            if (
                !action
                || (action.type !== "attack-drone" && action.type !== "attack-factory")
                || fireTime <= 0
            ) {
                continue
            }
            const target = action.target
            if (!(target instanceof Drone || target instanceof Usine)) continue
            if (drone.cible?.cible !== target) continue
            const targetPendingDestruction = target instanceof Drone
                && [...this.pendingDroneDestructions.values()].some(value => value.ref === target)
            const targetIsHit = target instanceof Drone
                ? this.gestionMonde.entities.includes(target)
                    || targetPendingDestruction
                : this.gestionMonde.entities.includes(target)
            if (!targetIsHit) continue

            let dx = target.position.x - drone.position.x
            let dy = target.position.y - drone.position.y
            let distance = Math.hypot(dx, dy)
            const attackRange = this.gestionMonde.getDroneRange(drone.joueur)
            if (distance > attackRange + .01) continue
            if (distance < .001) {
                const fallbackAngle = drone.id.charCodeAt(0) % 2 === 0 ? 0 : Math.PI
                dx = Math.cos(fallbackAngle)
                dy = Math.sin(fallbackAngle)
                distance = 1
            }
            const ux = dx / distance
            const uy = dy / distance
            const startX = drone.position.x
            const startY = drone.position.y
            const visualDistance = Math.max(distance, 58 / scale)
            const endX = startX + ux * visualDistance
            const endY = startY + uy * visualDistance
            const progress = Math.min(1, Math.max(0, 1 - fireTime / this.gestionMonde.config.FIRE_TIME))
            const beamProgress = progress * progress * (3 - 2 * progress)
            const beamX = startX + (endX - startX) * beamProgress
            const beamY = startY + (endY - startY) * beamProgress
            const impactThreshold = Math.max(.18, Math.min(1, distance / visualDistance))
            const hasImpact = beamProgress >= impactThreshold
            const impactProgress = hasImpact
                ? Math.min(1, (beamProgress - impactThreshold) / Math.max(.001, 1 - impactThreshold))
                : 0
            const color = this.playerColor(drone.joueur)
            const pulse = .82 + Math.sin(time / 42 + fireTime * .35) * .18

            this.ctx.save()
            this.ctx.lineCap = "round"
            this.ctx.globalAlpha = pulse
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 8 / scale
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 18 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(startX, startY)
            this.ctx.lineTo(beamX, beamY)
            this.ctx.stroke()

            this.ctx.globalAlpha = 1
            this.ctx.strokeStyle = "#ffffff"
            this.ctx.lineWidth = 2.2 / scale
            this.ctx.shadowColor = "#ffffff"
            this.ctx.shadowBlur = 8 / scale
            this.ctx.beginPath()
            this.ctx.moveTo(startX, startY)
            this.ctx.lineTo(beamX, beamY)
            this.ctx.stroke()

            const packet = (time / 170) % 1
            const packetX = startX + (beamX - startX) * packet
            const packetY = startY + (beamY - startY) * packet
            this.ctx.fillStyle = "#ffffff"
            this.ctx.beginPath()
            this.ctx.arc(packetX, packetY, 3.2 / scale, 0, Math.PI * 2)
            this.ctx.fill()

            this.ctx.fillStyle = "#ffffff"
            this.ctx.shadowColor = color
            this.ctx.shadowBlur = 15 / scale
            this.ctx.beginPath()
            this.ctx.arc(beamX, beamY, (3.8 + pulse) / scale, 0, Math.PI * 2)
            this.ctx.fill()

            if (hasImpact) {
                this.ctx.globalAlpha = .45 + impactProgress * .55
                this.ctx.shadowColor = color
                this.ctx.shadowBlur = 12 / scale
                this.ctx.strokeStyle = color
                this.ctx.lineWidth = 2.5 / scale
                this.ctx.beginPath()
                this.ctx.arc(
                    target.position.x,
                    target.position.y,
                    (6 + impactProgress * 4 + Math.sin(time / 55) * 2) / scale,
                    0,
                    Math.PI * 2
                )
                this.ctx.stroke()

                for (let index = 0; index < 5; index++) {
                    const angle = time / 180 + index * Math.PI * 2 / 5
                    const inner = (6 + impactProgress * 2) / scale
                    const outer = (8 + impactProgress * (6 + (index % 2) * 4)) / scale
                    this.ctx.beginPath()
                    this.ctx.moveTo(
                        target.position.x + Math.cos(angle) * inner,
                        target.position.y + Math.sin(angle) * inner
                    )
                    this.ctx.lineTo(
                        target.position.x + Math.cos(angle) * outer,
                        target.position.y + Math.sin(angle) * outer
                    )
                    this.ctx.stroke()
                }

                if (target instanceof Drone) {
                    this.drawDroneHitAnimation(
                        time,
                        scale,
                        target,
                        impactProgress,
                        targetPendingDestruction
                    )
                }
            }
            this.ctx.restore()
        }
    }

    private drawDroneHitAnimation(
        time: number,
        scale: number,
        target: Drone,
        impactProgress: number,
        destroyed: boolean
    ) {
        const color = destroyed ? "#ff5a36" : "#ffd166"
        const pulse = .62 + Math.sin(time / 34 + target.position.x * .1) * .32
        const radius = (17 + impactProgress * 9 + pulse * 2) / scale

        this.ctx.save()
        this.ctx.globalCompositeOperation = "screen"
        this.ctx.globalAlpha = .62 + pulse * .25
        const flash = this.ctx.createRadialGradient(
            target.position.x,
            target.position.y,
            0,
            target.position.x,
            target.position.y,
            radius
        )
        flash.addColorStop(0, destroyed ? "rgba(255,255,255,.95)" : "rgba(255,248,210,.9)")
        flash.addColorStop(.28, destroyed ? "rgba(255,90,54,.65)" : "rgba(255,209,102,.52)")
        flash.addColorStop(1, "rgba(255,90,54,0)")
        this.ctx.fillStyle = flash
        this.ctx.beginPath()
        this.ctx.arc(target.position.x, target.position.y, radius, 0, Math.PI * 2)
        this.ctx.fill()

        if (!destroyed) {
            const sprite = this.droneSpriteFor(target.joueur)
            if (sprite) {
                const jitter = (1.2 + impactProgress * 1.8) / scale
                const jitterX = Math.sin(time / 18 + target.position.y) * jitter
                const jitterY = Math.cos(time / 21 + target.position.x) * jitter
                const size = 38 / scale
                this.ctx.save()
                this.ctx.translate(target.position.x + jitterX, target.position.y + jitterY)
                this.ctx.rotate(this.droneAngle(target))
                this.ctx.globalAlpha = .25 + pulse * .24
                this.ctx.shadowColor = "#ffffff"
                this.ctx.shadowBlur = 13 / scale
                this.ctx.drawImage(sprite, -size / 2, -size / 2, size, size)
                this.ctx.restore()
            }
        }

        this.ctx.globalCompositeOperation = "source-over"
        this.ctx.globalAlpha = .72 + pulse * .22
        this.ctx.strokeStyle = color
        this.ctx.lineWidth = (destroyed ? 3.2 : 2.4) / scale
        this.ctx.shadowColor = color
        this.ctx.shadowBlur = 10 / scale
        const ringRotation = time / (destroyed ? 95 : 170)
        for (let index = 0; index < 4; index++) {
            const start = ringRotation + index * Math.PI / 2
            const arcLength = destroyed ? Math.PI / 4 : Math.PI / 3
            this.ctx.beginPath()
            this.ctx.arc(target.position.x, target.position.y, radius, start, start + arcLength)
            this.ctx.stroke()
        }

        const sparkCount = destroyed ? 10 : 7
        for (let index = 0; index < sparkCount; index++) {
            const angle = index * Math.PI * 2 / sparkCount + time / (destroyed ? 105 : 190)
            const flicker = .55 + Math.sin(time / 31 + index * 2.1) * .35
            const inner = (11 + impactProgress * 5) / scale
            const outer = inner + (5 + impactProgress * 10 + index % 3 * 2) * flicker / scale
            this.ctx.globalAlpha = .5 + flicker * .45
            this.ctx.strokeStyle = index % 3 === 0 ? "#ffffff" : color
            this.ctx.lineWidth = (index % 3 === 0 ? 2.1 : 1.4) / scale
            this.ctx.beginPath()
            this.ctx.moveTo(
                target.position.x + Math.cos(angle) * inner,
                target.position.y + Math.sin(angle) * inner
            )
            this.ctx.lineTo(
                target.position.x + Math.cos(angle) * outer,
                target.position.y + Math.sin(angle) * outer
            )
            this.ctx.stroke()
        }

        if (destroyed) {
            this.ctx.globalAlpha = .88
            this.ctx.strokeStyle = "#fff4d6"
            this.ctx.lineWidth = 2 / scale
            this.ctx.shadowColor = "#ff5a36"
            this.ctx.shadowBlur = 8 / scale
            for (let index = 0; index < 3; index++) {
                const angle = index * Math.PI * 2 / 3 + .35
                const middle = 8 / scale
                const end = 15 / scale
                this.ctx.beginPath()
                this.ctx.moveTo(target.position.x, target.position.y)
                this.ctx.lineTo(
                    target.position.x + Math.cos(angle + .24) * middle,
                    target.position.y + Math.sin(angle + .24) * middle
                )
                this.ctx.lineTo(
                    target.position.x + Math.cos(angle) * end,
                    target.position.y + Math.sin(angle) * end
                )
                this.ctx.stroke()
            }
        }
        this.ctx.restore()
    }

    private drawExplosions(time: number, scale: number) {
        const active: DroneExplosion[] = []
        for (const explosion of this.explosions) {
            const progress = (time - explosion.startedAt) / explosion.duration
            if (progress < 0) {
                active.push(explosion)
                continue
            }
            if (progress >= 1) continue
            active.push(explosion)

            const x = explosion.position.x
            const y = explosion.position.y
            const haloProgress = Math.min(1, progress / .55)
            const haloRadius = (7 + 38 * (1 - Math.pow(1 - haloProgress, 3))) / scale

            this.ctx.save()
            this.ctx.globalAlpha = Math.pow(1 - haloProgress, 2) * .85
            this.ctx.strokeStyle = "#ffb347"
            this.ctx.lineWidth = 3 / scale
            this.ctx.shadowColor = "#ff7a32"
            this.ctx.shadowBlur = 18 / scale
            this.ctx.beginPath()
            this.ctx.arc(x, y, haloRadius, 0, Math.PI * 2)
            this.ctx.stroke()

            if (progress < .22) {
                const flash = 1 - progress / .22
                const radius = (4 + progress * 55) / scale
                const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius)
                gradient.addColorStop(0, `rgba(255,255,255,${flash})`)
                gradient.addColorStop(.35, `rgba(255,196,92,${flash * .9})`)
                gradient.addColorStop(1, "rgba(255,80,40,0)")
                this.ctx.globalAlpha = 1
                this.ctx.fillStyle = gradient
                this.ctx.beginPath()
                this.ctx.arc(x, y, radius, 0, Math.PI * 2)
                this.ctx.fill()
            }
            this.ctx.restore()

            for (const particle of explosion.particles) {
                const particleProgress = (progress - particle.delay) / (1 - particle.delay)
                if (particleProgress < 0 || particleProgress >= 1) continue

                const travel = 1 - Math.pow(1 - particleProgress, 2)
                const distance = particle.speed * travel / scale
                const px = x + Math.cos(particle.angle) * distance
                const py = y
                    + Math.sin(particle.angle) * distance
                    + 30 * particleProgress * particleProgress / scale
                const alpha = Math.pow(1 - particleProgress, particle.kind === "smoke" ? 1.4 : 2)

                this.ctx.save()
                this.ctx.globalAlpha = alpha
                if (particle.kind === "smoke") {
                    this.ctx.fillStyle = particle.color
                    this.ctx.beginPath()
                    this.ctx.arc(
                        px,
                        py,
                        particle.size * (1 + particleProgress * 2.2) / scale,
                        0,
                        Math.PI * 2
                    )
                    this.ctx.fill()
                } else if (particle.kind === "spark") {
                    const tail = (5 + particle.speed * .08) / scale
                    this.ctx.strokeStyle = particle.color
                    this.ctx.lineWidth = particle.size / scale
                    this.ctx.shadowColor = particle.color
                    this.ctx.shadowBlur = 7 / scale
                    this.ctx.beginPath()
                    this.ctx.moveTo(
                        px - Math.cos(particle.angle) * tail,
                        py - Math.sin(particle.angle) * tail
                    )
                    this.ctx.lineTo(px, py)
                    this.ctx.stroke()
                } else {
                    this.ctx.translate(px, py)
                    this.ctx.rotate(particle.rotation + particle.rotationSpeed * particleProgress)
                    this.ctx.fillStyle = particle.color
                    const size = particle.size / scale
                    this.ctx.fillRect(-size / 2, -size / 2, size, size * .65)
                }
                this.ctx.restore()
            }
        }
        this.explosions = active
    }

    private droneTargetPosition(drone: Drone): Position | undefined {
        const target = drone.cible?.cible
        if (!target) return undefined
        if (target instanceof GameElement) {
            return target.position
        }
        return target
    }

    private pointerWorldPosition(event: CanvasInput) {
        const rect = this.canvas.getBoundingClientRect()
        return {
            x: (event.clientX - rect.left - this.view.offsetX) / this.view.scale,
            y: (event.clientY - rect.top - this.view.offsetY) / this.view.scale
        }
    }

    private handleCanvasWheel(event: WheelEvent) {
        if (this.root.dataset.mode !== "playing") return
        event.preventDefault()
        const previousZoom = this.zoom
        const zoomFactor = event.deltaY < 0 ? 1.2 : 1 / 1.2
        const nextZoom = Math.min(5, Math.max(1, previousZoom * zoomFactor))
        if (Math.abs(nextZoom - previousZoom) < .001) return

        const rect = this.canvas.getBoundingClientRect()
        const baseScale = this.fittedScale(rect.width, rect.height)
        const currentScale = baseScale * previousZoom
        this.syncCanvasView(rect.width, rect.height, currentScale)
        const worldPoint = this.pointerWorldPosition(event)
        const nextScale = baseScale * nextZoom
        const canvasX = event.clientX - rect.left
        const canvasY = event.clientY - rect.top

        // Le point placé sous le curseur reste sous le curseur pendant le zoom.
        this.camera = {
            x: worldPoint.x + (rect.width / 2 - canvasX) / nextScale,
            y: worldPoint.y + (rect.height / 2 - canvasY) / nextScale
        }
        this.zoom = nextZoom
        this.syncCanvasView(rect.width, rect.height, nextScale)
        this.updateZoomButton()
    }

    private fittedScale(width: number, height: number) {
        const margin = 19
        return Math.max(.01, Math.min(
            (width - margin * 2) / this.worldWidth,
            (height - margin * 2) / this.worldHeight
        ))
    }

    private syncCanvasView(width: number, height: number, scale: number) {
        this.clampCamera(width, height, scale)
        this.view = {
            scale,
            offsetX: width / 2 - this.camera.x * scale,
            offsetY: height / 2 - this.camera.y * scale
        }
    }

    private clampCamera(width: number, height: number, scale: number) {
        const halfVisibleWidth = width / (2 * Math.max(.01, scale))
        const halfVisibleHeight = height / (2 * Math.max(.01, scale))
        this.camera.x = halfVisibleWidth >= this.worldWidth / 2
            ? this.worldWidth / 2
            : Math.min(this.worldWidth - halfVisibleWidth, Math.max(halfVisibleWidth, this.camera.x))
        this.camera.y = halfVisibleHeight >= this.worldHeight / 2
            ? this.worldHeight / 2
            : Math.min(this.worldHeight - halfVisibleHeight, Math.max(halfVisibleHeight, this.camera.y))
    }

    private resetZoom() {
        this.zoom = 1
        this.camera = { x: this.worldWidth / 2, y: this.worldHeight / 2 }
        this.updateZoomButton()
    }

    private updateZoomButton() {
        if (!this.zoomResetButton) return
        this.zoomResetButton.textContent = `Zoom ${Math.round(this.zoom * 100)} % · réinitialiser`
        this.zoomResetButton.disabled = this.zoom <= 1.001
    }

    private interactionRadius(baseRadius: number, event: CanvasInput) {
        const minimumScreenRadius = event.pointerType === "touch"
            ? 32
            : event.pointerType === "pen" ? 26 : 0
        return minimumScreenRadius > 0
            ? Math.max(baseRadius, minimumScreenRadius / Math.max(.01, this.view.scale))
            : baseRadius
    }

    private entityAtPointer(event: CanvasInput) {
        const { x, y } = this.pointerWorldPosition(event)
        let best: GameElement | undefined
        let bestDistance = Infinity
        for (const entity of this.gestionMonde.entities) {
            const baseRadius = entity instanceof Usine ? 34 : entity instanceof Drone ? 20 : 15
            const radius = this.interactionRadius(baseRadius, event)
            const distance = Math.hypot(entity.position.x - x, entity.position.y - y)
            if (distance <= radius && distance < bestDistance) {
                best = entity
                bestDistance = distance
            }
        }
        return best
    }

    private manualSourceAtPointer(event: CanvasInput, joueur: Joueur) {
        const { x, y } = this.pointerWorldPosition(event)
        const factoryNewDrones = new Set(
            this.gestionMonde.usines()
                .map(usine => usine.etat?.newDrone)
                .filter((drone): drone is Drone => Boolean(drone))
        )
        let bestWaitingDrone: Drone | undefined
        let bestDistance = Infinity
        for (const drone of this.gestionMonde.drones()) {
            if (
                drone.joueur !== joueur
                || factoryNewDrones.has(drone)
                || !this.droneIsReadyForManualOrder(drone)
            ) continue
            const distance = Math.hypot(drone.position.x - x, drone.position.y - y)
            if (distance <= this.interactionRadius(24, event) && distance < bestDistance) {
                bestWaitingDrone = drone
                bestDistance = distance
            }
        }
        if (bestWaitingDrone) return bestWaitingDrone

        let bestFactory: Usine | undefined
        bestDistance = Infinity
        for (const usine of this.manualFactoriesWithNewDrone()) {
            if (usine.etat?.joueur !== joueur) continue
            const distance = Math.hypot(usine.position.x - x, usine.position.y - y)
            if (distance <= this.interactionRadius(34, event) && distance < bestDistance) {
                bestFactory = usine
                bestDistance = distance
            }
        }
        if (bestFactory) return bestFactory

        let bestBusyDrone: Drone | undefined
        bestDistance = Infinity
        for (const drone of this.gestionMonde.drones()) {
            if (
                drone.joueur !== joueur
                || factoryNewDrones.has(drone)
                || this.droneIsReadyForManualOrder(drone)
            ) continue
            const distance = Math.hypot(drone.position.x - x, drone.position.y - y)
            if (distance <= this.interactionRadius(24, event) && distance < bestDistance) {
                bestBusyDrone = drone
                bestDistance = distance
            }
        }
        return bestBusyDrone
    }

    private inspectPointer(event: CanvasInput) {
        const best = this.entityAtPointer(event)
        if (best !== this.hovered) {
            this.hovered = best
            this.updateInspector()
        }
    }

    private beginCanvasGesture(event: CanvasInput, id: number | string) {
        if (this.root.dataset.mode !== "playing") return
        this.canvasGesture = {
            id,
            pointerType: event.pointerType ?? "mouse",
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            dragging: false
        }
        this.inspectPointer(event)
    }

    private moveCanvasGesture(event: CanvasInput, id: number | string) {
        const gesture = this.canvasGesture
        if (!gesture || gesture.id !== id) return false
        const threshold = gesture.pointerType === "touch" ? 9 : 5
        if (!gesture.dragging && Math.hypot(
            event.clientX - gesture.startX,
            event.clientY - gesture.startY
        ) >= threshold) {
            gesture.dragging = true
            this.canvas.dataset.panning = "true"
        }

        if (gesture.dragging) {
            const dx = event.clientX - gesture.lastX
            const dy = event.clientY - gesture.lastY
            const rect = this.canvas.getBoundingClientRect()
            const scale = this.fittedScale(rect.width, rect.height) * this.zoom
            this.camera.x -= dx / Math.max(.01, scale)
            this.camera.y -= dy / Math.max(.01, scale)
            this.syncCanvasView(rect.width, rect.height, scale)
        } else {
            this.inspectPointer(event)
        }
        gesture.lastX = event.clientX
        gesture.lastY = event.clientY
        return true
    }

    private endCanvasGesture(event: CanvasInput, id: number | string) {
        const gesture = this.canvasGesture
        if (!gesture || gesture.id !== id) return false
        this.canvasGesture = undefined
        delete this.canvas.dataset.panning
        if (gesture.dragging) {
            this.inspectPointer(event)
        } else {
            this.handleManualInput(event)
        }
        return true
    }

    private cancelCanvasGesture(id: number | string) {
        if (this.canvasGesture?.id !== id) return
        this.canvasGesture = undefined
        delete this.canvas.dataset.panning
    }

    private handleManualInput(event: CanvasInput) {
        const player = this.manualPlayer
        if ((!this.running && !this.manualTurnPaused) || !player || this.gestionMonde.combatResult) return
        const joueur = this.manualJoueur()
        if (!joueur) return
        const entity = !this.manualSelectedDrone
            ? this.manualSourceAtPointer(event, joueur) ?? this.entityAtPointer(event)
            : this.entityAtPointer(event)
        if (entity !== this.hovered) {
            this.hovered = entity
            this.updateInspector()
        }
        if (entity instanceof Drone) this.showDroneInfo(entity)

        if (!this.manualSelectedDrone) {
            if (!entity) {
                this.updateManualHelp("Sélectionnez d’abord un drone disponible ou une usine possédant un drone prêt.", "error")
                return
            }
            this.selectManualSource(entity, joueur)
            return
        }
        const selectedDrone = this.manualSelectedDrone

        if (!entity) {
            this.updateManualHelp("Aucune cible ici. Touchez ou cliquez directement sur une usine, une ressource ou un drone adverse.", "error")
            return
        }
        if (entity === selectedDrone) {
            this.clearManualSelection()
            return
        }
        if (entity instanceof Drone && entity.joueur === joueur) {
            this.updateManualHelp("Un drone allié ne peut pas être ciblé. Touchez ou cliquez sur une autre cible.", "error")
            return
        }
        if ((entity instanceof Energie || entity instanceof Vie) && entity.proprietaire) {
            this.updateManualHelp("Cette ressource n’est plus disponible.", "error")
            return
        }

        const order: SetTargetRef = {
            type:"setTargetRef",
            mobileRef: selectedDrone.id,
            targetRef: entity.id
        }
        const droneId = shortId(selectedDrone.id)
        const targetName = this.manualTargetLabel(entity)
        const pendingQueue = this.manualTargetQueues.get(selectedDrone.id)
        const canStartNow = this.droneIsReadyForManualOrder(selectedDrone)
            && !selectedDrone.cible
            && (!pendingQueue || pendingQueue.length === 0)
        let message: string
        if (canStartNow) {
            const accepted = this.submitManualSetTargetRef(joueur, order)
            if (!accepted) {
                this.updateManualHelp("Ordre refusé : la cible n’est plus disponible.", "error")
                return
            }
            const count = player === "A" ? ++this.responseCountA : ++this.responseCountB
            this.setWorkerState(player, `manuel · ${count} ordre${count > 1 ? "s" : ""}`, "active")
            this.addEvent(`Ordre manuel ${player} : drone #${droneId} vers ${targetName}`)
            this.manualSelectedFactory = undefined
            message = `Cible active : ${targetName}. Touchez ou cliquez sur une autre cible pour l’ajouter à la pile.`
        } else {
            const position = this.enqueueManualTarget(selectedDrone, entity)
            if (position === undefined) {
                this.updateManualHelp(
                    `${targetName} est déjà présente dans la séquence de ce drone.`,
                    "error"
                )
                return
            }
            this.addEvent(
                `Pile manuelle ${player} : ${targetName} ajouté en position ${position} pour le drone #${droneId}`
            )
            message = `${targetName} ajouté à la pile en position ${position}. Ajoutez une autre cible ou retouchez le drone pour terminer.`
        }

        this.updateContinueControl()
        this.updateManualSequenceControl()
        this.updateManualDroneList()
        this.updateManualHelp(message, "success")
    }

    private selectManualSource(entity: GameElement, joueur: Joueur) {
        let drone: Drone | undefined
        let factory: Usine | undefined
        if (entity instanceof Drone && entity.joueur === joueur) {
            drone = entity
        } else if (entity instanceof Usine && entity.etat?.joueur === joueur) {
            drone = entity.etat.newDrone
            factory = drone ? entity : undefined
            if (!drone) {
                this.updateManualHelp("Cette usine ne possède pas encore de newDrone prêt.", "error")
                return
            }
        } else {
            this.updateManualHelp(`Cette unité n’appartient pas au joueur ${this.manualPlayer}.`, "error")
            return
        }

        const addsToCurrentOrder = !this.droneIsReadyForManualOrder(drone)
        this.manualSelectedDrone = drone
        this.manualSelectedFactory = factory
        this.showDroneInfo(drone)
        this.updateManualSequenceControl()
        const source = factory ? `newDrone de l’usine #${shortId(factory.id)}` : `drone #${shortId(drone.id)}`
        this.updateManualHelp(
            `${source} sélectionné${addsToCurrentOrder ? " · les nouvelles cibles seront ajoutées après l’ordre actuel" : ""} · touchez ou cliquez successivement sur ses cibles.`,
            "selected"
        )
    }

    private droneIsReadyForManualOrder(drone: Drone) {
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        return state?.type === "wait" && (drone.cible?.fireTime ?? 0) <= 0
    }

    private droneCanBeRetargeted(drone: Drone) {
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        return state?.type === "move" && (drone.cible?.fireTime ?? 0) <= 0
    }

    private droneCanAttackManually(drone: Drone) {
        return this.droneIsReadyForManualOrder(drone) && drone.energieCount > 0
    }

    private submitManualSetTargetRef(joueur: Joueur, order: SetTargetRef) {
        return this.gestionMonde.initDroneState(joueur, order.mobileRef, order.targetRef)
    }

    private manualJoueur() {
        if (this.manualPlayer === "A") return this.gestionMonde.joueurA
        if (this.manualPlayer === "B") return this.gestionMonde.joueurB
        return undefined
    }

    private clearManualSelection(updateHelp = true) {
        this.manualSelectedDrone = undefined
        this.manualSelectedFactory = undefined
        this.updateManualSequenceControl()
        if (updateHelp) this.updateManualHelp()
    }

    private updateManualHelp(text?: string, state: "idle" | "selected" | "success" | "error" = "idle") {
        const active = Boolean(
            this.manualPlayer
            && (this.running || this.manualTurnPaused)
            && !this.gestionMonde?.combatResult
            && this.root.dataset.mode === "playing"
        )
        this.canvas.dataset.manual = String(active)
        this.manualHelpElement.hidden = !active
        if (!active) return

        this.manualHelpElement.dataset.state = state
        this.manualHelpElement.textContent = text ?? (
            this.manualSelectedDrone
                ? `Drone #${shortId(this.manualSelectedDrone.id)} sélectionné · chaque cible touchée ou cliquée est ajoutée à sa séquence.`
                : `Joueur ${this.manualPlayer} · glisser = déplacer la carte · molette = zoom · D+ = newDrone · ATK/RESS = disponible · sélectionnez aussi un drone occupé pour compléter sa pile.`
        )
    }

    private showDroneInfo(drone: Drone) {
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        this.selectedDroneInfoElement.hidden = false
        this.selectedDroneInfoElement.innerHTML = `
            <strong>Drone ${this.playerName(drone.joueur)} #${shortId(drone.id)}</strong>
            <span>Énergie : ${drone.energieCount}</span>
            <span>Vie : ${drone.vieCount}</span>
            <small>${state?.type === "wait" ? "En attente" : state?.type === "move" ? "En déplacement" : "En action"}</small>
        `
    }

    private updateInspector() {
        const entity = this.hovered
        delete this.inspectorElement.dataset.owner
        delete this.inspectorElement.dataset.kind
        if (!entity) {
            this.inspectorModalElement.hidden = true
            this.inspectorElement.replaceChildren()
            return
        }
        this.inspectorModalElement.hidden = false
        if (entity instanceof Drone) {
            const state = this.gestionMonde.droneStates.find(value => value.ref === entity)
            const owner = this.playerName(entity.joueur)
            if (owner === "A" || owner === "B") this.inspectorElement.dataset.owner = owner
            this.inspectorElement.dataset.kind = "drone"
            const status = state?.type === "wait"
                ? "Disponible"
                : state?.type === "move" ? "En déplacement" : state ? "En action" : "Absent"
            const target = entity.cible?.cible
            this.inspectorElement.innerHTML = `
                <strong>Drone du joueur ${owner}<br>#${shortId(entity.id)}</strong>
                <div class="game-inspector-grid">
                    <div class="game-inspector-row"><span>État</span><b>${status}</b></div>
                    <div class="game-inspector-row"><span>Énergie</span><b>${entity.energieCount}</b></div>
                    <div class="game-inspector-row"><span>Vie</span><b>${entity.vieCount}</b></div>
                    <div class="game-inspector-row"><span>Cargaison</span><b>${entity.energieCount + entity.vieCount} / ${this.gestionMonde.getDroneTransport(entity.joueur)}</b></div>
                    <div class="game-inspector-row"><span>Puissance</span><b>${this.gestionMonde.getDronePower(entity.joueur)}</b></div>
                    <div class="game-inspector-row"><span>Cible</span><b>${target ? this.shotTargetName(target) : "aucune"}</b></div>
                    <div class="game-inspector-row"><span>Cooldown</span><b>${entity.cible?.fireTime ?? 0}</b></div>
                    <div class="game-inspector-row"><span>Position</span><b>${entity.position.x.toFixed(0)}, ${entity.position.y.toFixed(0)}</b></div>
                </div>
            `
            return
        }
        if (entity instanceof Usine) {
            const technology = TECHNOLOGY_VISUALS[entity.technologie]
            const technologyEnabled = this.gestionMonde.isTechnologyEnabled(entity.technologie)
            const owner = entity.etat ? this.playerName(entity.etat.joueur) : "neutre"
            if (owner === "A" || owner === "B") this.inspectorElement.dataset.owner = owner
            this.inspectorElement.dataset.kind = "factory"
            const populationMaximum = entity.etat
                ? this.gestionMonde.getDronePopulation(entity.etat.joueur)
                : 0
            const buildDuration = entity.etat
                ? this.gestionMonde.buildTime(entity.etat.joueur)
                : 0
            const production = !entity.etat
                ? "inactive"
                : entity.etat.newDrone
                    ? "drone prêt"
                    : `${Math.max(0, entity.etat.time)} / ${buildDuration} ticks`
            this.inspectorElement.innerHTML = `
                <strong>Usine<br>${technology.label}</strong>
                <div class="game-inspector-grid">
                    <div class="game-inspector-row"><span>Propriétaire</span><b>${owner}</b></div>
                    <div class="game-inspector-row"><span>Pouvoir</span><b>${technologyEnabled ? technology.effect : "verrouillé"}</b></div>
                    <div class="game-inspector-row"><span>Vie de l’usine</span><b>${entity.etat?.vieCount ?? 0}</b></div>
                    <div class="game-inspector-row"><span>Production</span><b>${production}</b></div>
                    <div class="game-inspector-row"><span>Population</span><b>${entity.etat ? `${entity.etat.populationCount} / ${populationMaximum}` : "—"}</b></div>
                    <div class="game-inspector-row"><span>Drone prêt</span><b>${entity.etat?.newDrone ? "oui" : "non"}</b></div>
                </div>
            `
            return
        }
        const resource = entity as Energie | Vie
        const kind = entity instanceof Energie ? "energy" : "life"
        this.inspectorElement.dataset.kind = kind
        const owner = resource.proprietaire
        const ownerLabel = owner instanceof Drone
            ? `drone ${this.playerName(owner.joueur)} #${shortId(owner.id)}`
            : owner instanceof Usine
                ? `usine #${shortId(owner.id)}`
                : "aucun"
        this.inspectorElement.innerHTML = `
            <strong>Ressource ${entity instanceof Energie ? "Énergie" : "Vie"}<br>#${shortId(entity.id)}</strong>
            <div class="game-inspector-grid">
                <div class="game-inspector-row"><span>Disponible</span><b>${owner ? "non" : "oui"}</b></div>
                <div class="game-inspector-row"><span>Transportée par</span><b>${ownerLabel}</b></div>
                <div class="game-inspector-row"><span>Position</span><b>${entity.position.x.toFixed(0)}, ${entity.position.y.toFixed(0)}</b></div>
            </div>
        `
    }

    private rememberWorld() {
        this.memory = {
            drones: new Map(this.gestionMonde.drones().map(drone => [drone.id, {
                ref: drone,
                position: { x: drone.position.x, y: drone.position.y },
                color: this.playerColor(drone.joueur),
                angle: this.droneAngle(drone)
            }])),
            usineOwners: new Map(this.gestionMonde.usines().map(usine => [usine.id, usine.etat?.joueur.id]))
        }
        this.cooldownByDrone = new Map(
            this.gestionMonde.drones().map(drone => [drone.id, drone.cible?.fireTime ?? 0])
        )
    }

    private detectWorldEvents() {
        const nextCooldowns = new Map<string, number>()
        for (const drone of this.gestionMonde.drones()) {
            const previousCooldown = this.cooldownByDrone.get(drone.id) ?? 0
            const cooldown = drone.cible?.fireTime ?? 0
            nextCooldowns.set(drone.id, cooldown)
            if (cooldown > 0 && previousCooldown <= 0) {
                const action = this.classifyDroneAction(drone)
                if (action) {
                    this.activeDroneActions.set(drone.id, action)
                    this.logDroneAction(drone, action)
                }
            } else if (cooldown <= 0) {
                this.activeDroneActions.delete(drone.id)
            }
        }
        const liveDroneIds = new Set(this.gestionMonde.drones().map(drone => drone.id))
        for (const droneId of this.activeDroneActions.keys()) {
            if (!liveDroneIds.has(droneId)) this.activeDroneActions.delete(droneId)
        }
        this.cooldownByDrone = nextCooldowns

        const currentDrones = new Map(this.gestionMonde.drones().map(drone => [drone.id, {
            ref: drone,
            position: { x: drone.position.x, y: drone.position.y },
            color: this.playerColor(drone.joueur),
            angle: this.droneAngle(drone)
        }]))
        for (const drone of this.gestionMonde.drones()) {
            if (!this.memory.drones.has(drone.id)) {
                this.startDroneLaunch(drone)
                this.addEvent(`Joueur ${this.playerName(drone.joueur)} crée le drone ${shortId(drone.id)}`)
            }
        }
        for (const [id, drone] of this.memory.drones) {
            if (!currentDrones.has(id)) {
                if (this.droneIsUnderAttackCooldown(drone.ref)) {
                    this.pendingDroneDestructions.set(id, drone)
                } else {
                    this.startDroneExplosion(drone)
                    this.addEvent(`Drone ${shortId(id)} détruit`)
                }
            }
        }
        for (const [id, drone] of this.pendingDroneDestructions) {
            if (!this.droneIsUnderAttackCooldown(drone.ref)) {
                this.pendingDroneDestructions.delete(id)
                this.startDroneExplosion(drone)
                this.addEvent(`Drone ${shortId(id)} détruit à la fin du tir`)
            }
        }
        const currentOwners = new Map(this.gestionMonde.usines().map(usine => [usine.id, usine.etat?.joueur.id]))
        for (const usine of this.gestionMonde.usines()) {
            const oldOwner = this.memory.usineOwners.get(usine.id)
            const newOwner = currentOwners.get(usine.id)
            if (oldOwner !== newOwner && newOwner) {
                this.addEvent(`Joueur ${this.playerName(usine.etat!.joueur)} prend l’usine ${shortId(usine.id)}`)
            }
        }
        this.memory = { drones: currentDrones, usineOwners: currentOwners }
    }

    private droneIsUnderAttackCooldown(target: Drone) {
        return this.gestionMonde.drones().some(drone =>
            (drone.cible?.fireTime ?? 0) > 0
            && drone.cible?.cible === target
        )
    }

    private startDroneLaunch(drone: Drone) {
        this.launches.push({
            position: { x: drone.usine.position.x, y: drone.usine.position.y },
            color: this.playerColor(drone.joueur),
            startedAt: performance.now(),
            duration: 850
        })
    }

    private startDroneExplosion(drone: RememberedDrone) {
        const colors = [drone.color, "#ffffff", "#ffd166", "#ff713d"]
        const particles: ExplosionParticle[] = Array.from({ length: 26 }, (_, index) => {
            const kind: ExplosionParticle["kind"] = index < 15
                ? "spark"
                : index < 21
                    ? "fragment"
                    : "smoke"
            return {
                angle: Math.random() * Math.PI * 2,
                speed: kind === "smoke" ? 22 + Math.random() * 28 : 45 + Math.random() * 75,
                size: kind === "smoke" ? 3 + Math.random() * 3 : 1.5 + Math.random() * 2.5,
                delay: Math.random() * .12,
                rotation: Math.random() * Math.PI * 2,
                rotationSpeed: (Math.random() - .5) * Math.PI * 7,
                color: kind === "smoke" ? "#596176" : colors[index % colors.length],
                kind
            }
        })

        this.explosions.push({
            position: { ...drone.position },
            startedAt: performance.now(),
            duration: 950,
            particles
        })
    }

    private classifyDroneAction(drone: Drone): ActiveDroneAction | undefined {
        const target = drone.cible?.cible
        if (target instanceof Drone) return { type: "attack-drone", target }
        if (target instanceof Energie) return { type: "collect-energy", target }
        if (target instanceof Vie) return { type: "collect-life", target }
        if (!(target instanceof Usine)) return undefined

        const previousOwnerId = this.memory.usineOwners.get(target.id)
        if (previousOwnerId && previousOwnerId !== drone.joueur.id) {
            return { type: "attack-factory", target }
        }
        if (!previousOwnerId) return { type: "capture-factory", target }
        return { type: "repair-factory", target }
    }

    private logDroneAction(drone: Drone, droneAction: ActiveDroneAction) {
        const action = droneAction.type === "attack-drone" || droneAction.type === "attack-factory"
            ? "attaque au laser"
            : droneAction.type === "repair-factory"
                ? "répare"
                : droneAction.type === "capture-factory"
                    ? "prend le contrôle de"
                    : "récupère"
        this.addEvent(
            `Drone ${this.playerName(drone.joueur)} #${shortId(drone.id)} ${action} ${this.shotTargetName(droneAction.target)}`
        )
    }

    private shotTargetName(target: Drone | Usine | Energie | Vie | Position) {
        if (target instanceof Drone) return `le drone ${this.playerName(target.joueur)} #${shortId(target.id)}`
        if (target instanceof Usine) return `l’usine #${shortId(target.id)}`
        if (target instanceof Energie) return `l’énergie #${shortId(target.id)}`
        if (target instanceof Vie) return `la vie #${shortId(target.id)}`
        return "une position"
    }

    private finishMatch(result: CombatResult) {
        this.running = false
        this.manualTurnPaused = false
        this.continueButton.hidden = true
        this.accumulator = 0
        this.clearManualSelection()
        this.stopWorkers()
        this.updateManualHelp()

        const score = `${result.droneCountA} drone${result.droneCountA > 1 ? "s" : ""} pour A, ${result.droneCountB} drone${result.droneCountB > 1 ? "s" : ""} pour B`
        const reason = result.reason === "time"
            ? `durée maximale atteinte au tick ${result.tick}`
            : result.winner
                ? "adversaire sans usine"
                : "les deux joueurs n’ont plus d’usine"

        if (!result.winner) {
            const message = `Match nul : ${score} (${reason}).`
            this.setWorkerState("A", "match nul", "draw")
            this.setWorkerState("B", "match nul", "draw")
            this.setStatus(message)
            this.addEvent(message)
            void this.finishCampaignRound(false)
            return
        }

        const winner = this.playerName(result.winner) as PlayerKey
        const loser: PlayerKey = winner === "A" ? "B" : "A"
        const message = `Victoire du joueur ${winner} : ${score} (${reason}).`
        this.setWorkerState(winner, "vainqueur", "winner")
        this.setWorkerState(loser, "perdant", "loser")
        this.setStatus(message)
        this.addEvent(message)
        void this.finishCampaignRound(winner === "A")
    }

    private async finishCampaignRound(won: boolean) {
        if (!this.campaignActive || !this.campaignIsCompatible(this.campaign)) return
        const save = this.campaign
        if (!won) {
            this.restartButton.textContent = "Réessayer"
            this.updateCampaignHud(`Défaite au ${this.campaignLevelLabel(save)} : progression inchangée · cliquez sur Réessayer`)
            return
        }

        const previous = {
            levelIndex: save.levelIndex,
            opponentIndex: save.opponentIndex,
            completed: save.completed
        }
        const completedLevel = save.levels[save.levelIndex]
        save.opponentIndex++
        if (save.opponentIndex >= completedLevel.ranking.length) {
            save.levelIndex++
            save.opponentIndex = 0
        }
        if (save.levelIndex >= save.levels.length) {
            save.completed = true
            save.levelIndex = save.levels.length - 1
            save.opponentIndex = save.levels.at(-1)?.ranking.length ?? 0
        }
        this.campaignSaving = true
        this.restartButton.disabled = true
        try {
            await this.persistCampaign(save)
        } catch (error) {
            save.levelIndex = previous.levelIndex
            save.opponentIndex = previous.opponentIndex
            save.completed = previous.completed
            this.restartButton.textContent = "Rejouer le combat"
            this.updateCampaignHud("Victoire non enregistrée · vérifiez l’accès au fichier JSON")
            this.setStatus(`Impossible d’enregistrer la progression : ${this.errorMessage(error)}`, true)
            return
        } finally {
            this.campaignSaving = false
            this.restartButton.disabled = false
        }

        if (save.completed) {
            this.restartButton.textContent = "Retour au menu"
            this.updateCampaignHud("Campagne terminée · tous les bots et tous les niveaux sont vaincus !")
            this.setStatus("Campagne terminée : tous les adversaires ont été battus sur tous les niveaux.")
            return
        }

        const nextLevel = save.levels[save.levelIndex]
        const nextOpponent = nextLevel.ranking[save.opponentIndex]
        this.restartButton.textContent = save.opponentIndex === 0 ? "Niveau suivant" : "Adversaire suivant"
        this.updateCampaignHud(
            `Victoire enregistrée · prochain ${this.campaignLevelLabel(save)} : ${scriptName(nextOpponent)} · ${nextLevel.powerCount} pouvoir${nextLevel.powerCount > 1 ? "s" : ""}`
        )
    }

    private markPendingRestart(message = "Les contrôles ont changé. Cliquez sur « Lancer le combat ».") {
        this.setWorkerState("A", "à relancer", "pending")
        this.setWorkerState("B", "à relancer", "pending")
        this.setStatus(message)
    }

    private enterArena() {
        if (this.previousBodyOverflow === undefined) {
            this.previousBodyOverflow = document.body.style.overflow
        }
        document.body.style.overflow = "hidden"
        this.root.dataset.mode = "playing"
    }

    private showLobby() {
        this.root.dataset.mode = "lobby"
        if (this.previousBodyOverflow !== undefined) {
            document.body.style.overflow = this.previousBodyOverflow
            this.previousBodyOverflow = undefined
        }
    }

    private showTournament() {
        this.root.dataset.mode = "tournament"
        if (this.previousBodyOverflow !== undefined) {
            document.body.style.overflow = this.previousBodyOverflow
            this.previousBodyOverflow = undefined
        }
    }

    private exitTournament() {
        if (this.tournamentRunning) {
            this.tournamentRunId++
            this.tournamentRunning = false
            const wasCampaignEvaluation = this.campaignEvaluating
            this.campaignEvaluating = false
            this.stopWorkers()
            this.tournamentCurrentElement.textContent = wasCampaignEvaluation
                ? "Évaluation arrêtée. Aucune progression incomplète n’a été enregistrée."
                : "Tournoi arrêté. Le classement partiel est conservé."
            this.tournamentExitButton.textContent = "Retour au menu"
            return
        }

        this.tournamentRunId++
        this.stopWorkers()
        this.campaignEvaluating = false
        this.showLobby()
        this.tournamentButton.disabled = this.botScripts.length < 2
        this.updateCampaignButtons()
        this.setWorkerState("A", "prêt", "pending")
        this.setWorkerState("B", "prêt", "pending")
        this.setStatus("Choisissez une partie manuelle libre ou reprenez la progression.")
        this.refreshUi()
    }

    private returnToLobby() {
        this.stopWorkers()
        this.campaignActive = false
        this.manualPlayer = undefined
        this.clearManualSelection()
        this.running = false
        this.manualTurnPaused = false
        this.continueButton.hidden = true
        this.selectedDroneInfoElement.hidden = true
        this.accumulator = 0
        this.campaignHudElement.hidden = true
        this.restartButton.textContent = "Redémarrer"
        this.showLobby()
        this.setWorkerState("A", "prêt", "pending")
        this.setWorkerState("B", "prêt", "pending")
        this.updateCampaignButtons()
        this.setStatus("Choisissez une partie manuelle libre ou reprenez la progression.")
        this.refreshUi()
    }

    private setWorkerState(player: PlayerKey, text: string, state: WorkerState) {
        const element = player === "A" ? this.botAState : this.botBState
        element.textContent = text
        element.dataset.state = state
    }

    private setStatus(text: string, error = false) {
        this.statusElement.textContent = text
        this.statusElement.style.color = error ? "#b4233c" : "#536178"
    }

    private addEvent(text: string) {
        this.events.push(`${this.tick}|${text}`)
        if (this.events.length > 200) this.events.shift()
    }

    private playerColor(player: Joueur) {
        return player === this.gestionMonde.joueurA ? PLAYER_A_COLOR : PLAYER_B_COLOR
    }

    private droneSpriteFor(player: Joueur) {
        const playerKey: PlayerKey = player === this.gestionMonde.joueurA ? "A" : "B"
        return this.playerDroneSprites.get(playerKey) ?? this.droneSprite
    }

    private playerName(player: Joueur) {
        if (player === this.gestionMonde.joueurA) return "A"
        if (player === this.gestionMonde.joueurB) return "B"
        return shortId(player.id)
    }

    private errorMessage(error: unknown) {
        return error instanceof Error ? error.message : String(error)
    }

    private stopWorkers() {
        this.workerGeneration++
        this.workerA?.terminate()
        this.workerB?.terminate()
        this.workerA = undefined
        this.workerB = undefined
    }

    destroy() {
        this.tournamentRunId++
        this.tournamentRunning = false
        this.campaignEvaluating = false
        this.campaignActive = false
        this.stopWorkers()
        this.manualPlayer = undefined
        this.clearManualSelection()
        this.showLobby()
        if (this.requestId !== undefined) cancelAnimationFrame(this.requestId)
        this.requestId = undefined
        this.running = false
        this.manualTurnPaused = false
    }
}

let currentGame: AlgoFightManualGame | undefined

export function installManualGame(container: HTMLElement = document.body) {
    currentGame?.destroy()
    const game = new AlgoFightManualGame()
    container.replaceChildren(game.createInterface())
    game.init()
    currentGame = game
    return game
}

function installInBody() {
    installManualGame(document.body)
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
