import {
    DEFAULT_CONFIG,
    type Config,
    Drone,
    Energie,
    Element as GameElement,
    Joueur,
    Position,
    type SetTargetRef,
    Technologie,
    Usine,
    Vie
} from "./algofight-entity-model"
import {
    isGeneratedBotSourcePath,
    listBotsScript,
    readSource,
    writeSource
} from "./bots-script-tools"
import { entityToJsonData, type JsonData } from "./node_modules/tauri-kargo-tools/src/entity-model"
import { GestionMonde, type CombatResult } from "./gestion-algofight-entity-model"

type PlayerKey = "A" | "B"
export type GameMode = "programming" | "manual"
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

interface CampaignLevel {
    powerCount: number
    world: JsonData
    ranking: string[]
}

interface CampaignSave {
    version: 1
    botSignature: string
    width: number
    height: number
    levels: CampaignLevel[]
    levelIndex: number
    opponentIndex: number
    completed: boolean
}

interface CampaignLevelsFile {
    version: 1
    botSignature: string
    width: number
    height: number
    levels: CampaignLevel[]
}

interface CampaignProgressFile {
    version: 1
    botSignature: string
    levelIndex: number
    opponentIndex: number
    completed: boolean
}

const PLAYER_A_COLOR = "#37e686"
const PLAYER_B_COLOR = "#4f86ff"
const NEUTRAL_COLOR = "#8691aa"
const TOURNAMENT_STEP_BATCH = 50
const MANUAL_CONTROLLER = "__manual__"
export const CAMPAIGN_LEVELS_SOURCE = "algofight-levels.json"
export const CAMPAIGN_PROGRESS_SOURCE = "algofight-progression.json"
const CAMPAIGN_POWER_LEVELS = [0, 1, 2, 3, 4, 5] as const
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

function droneAppearanceOptions(selected: DroneAppearance) {
    return (Object.entries(DRONE_APPEARANCES) as [DroneAppearance, typeof DRONE_APPEARANCES[DroneAppearance]][])
        .map(([key, appearance]) => `
            <option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(appearance.label)}</option>
        `)
        .join("")
}

function technologyLegendHtml() {
    return TECHNOLOGIES.map(technology => {
        const visual = TECHNOLOGY_VISUALS[technology]
        return `
            <div class="game-legend-tech" title="${escapeHtml(visual.effect)}">
                <img src="${visual.url}" alt="">
                <span><strong>${escapeHtml(visual.label)}</strong><small>${escapeHtml(visual.effect)}</small></span>
            </div>
        `
    }).join("")
}

export class AlgoFightGame {
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
    private legendDroneA!: HTMLImageElement
    private legendDroneB!: HTMLImageElement
    private legendDroneLabelA!: HTMLElement
    private legendDroneLabelB!: HTMLElement
    private botAState!: HTMLElement
    private botBState!: HTMLElement
    private statusElement!: HTMLElement
    private scoreElement!: HTMLElement
    private statsElement!: HTMLElement
    private inspectorElement!: HTMLElement
    private eventsElement!: HTMLElement
    private hudAElement!: HTMLElement
    private hudBElement!: HTMLElement
    private hudUpgradesAElement!: HTMLElement
    private hudUpgradesBElement!: HTMLElement
    private hudTimeElement!: HTMLElement
    private hudTimeLabelElement!: HTMLElement
    private startButton!: HTMLButtonElement
    private tournamentButton!: HTMLButtonElement
    private campaignButton!: HTMLButtonElement
    private campaignResetButton!: HTMLButtonElement
    private restartButton!: HTMLButtonElement
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
    private requestId?: number
    private lastFrame = 0
    private accumulator = 0
    private stepInFlight = false
    private lastUiUpdate = 0
    private view: CanvasView = { scale: 1, offsetX: 0, offsetY: 0 }
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

    constructor(private readonly gameMode: GameMode) {}

    createInterface() {
        const manualMode = this.gameMode === "manual"
        this.root = document.createElement("div")
        this.root.className = "algofight-game"
        this.root.dataset.mode = "lobby"
        this.root.dataset.gameMode = this.gameMode
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
                .game-legend-player img,
                .game-legend-tech img,
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
                    padding: 8px 12px;
                    border: 1px solid var(--border);
                    border-radius: 9px;
                    color: var(--text);
                    background: linear-gradient(180deg, #ffffff, #e4e8ee);
                    font-family: inherit;
                    font-size: 15px;
                    font-weight: 800;
                    cursor: pointer;
                }
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
                .game-canvas { display: block; width: 100%; height: 650px; }
                .game-canvas[data-manual=true] { cursor: pointer; }
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
                    grid-template-columns: minmax(150px, 1fr) auto minmax(150px, 1fr) auto;
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
                .game-legend {
                    z-index: 4;
                    min-width: 0;
                    min-height: 0;
                    padding: 13px 11px;
                    overflow-y: auto;
                    border-left: 1px solid rgba(143, 164, 211, .3);
                    color: var(--text);
                    background: #f1f3f6;
                    pointer-events: none;
                }
                .game-legend-title { margin-bottom: 10px; color: #26334a; font-size: 12px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
                .game-legend-players { display: flex; flex-direction: column; gap: 7px; margin-bottom: 11px; }
                .game-legend-player {
                    display: flex;
                    flex: 1 1 0;
                    align-items: center;
                    gap: 7px;
                    min-width: 0;
                    padding: 4px 7px;
                    border: 1px solid var(--border);
                    border-radius: 7px;
                    background: rgba(255, 255, 255, .82);
                    font-size: 13px;
                    font-weight: 800;
                }
                .game-legend-player.a { border-left: 3px solid var(--a); }
                .game-legend-player.b { border-left: 3px solid var(--b); }
                .game-legend-player img { flex: 0 0 auto; width: 27px; height: 27px; object-fit: contain; }
                .game-legend-player img { filter: drop-shadow(0 0 4px rgba(220, 232, 255, .3)); }
                .game-legend-technologies { display: grid; grid-template-columns: 1fr; gap: 6px; }
                .game-legend-tech {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    min-width: 0;
                    padding: 4px 5px;
                    border-radius: 6px;
                    background: rgba(58, 72, 94, .08);
                }
                .game-legend-tech img { flex: 0 0 auto; width: 24px; height: 24px; object-fit: contain; }
                .game-legend-tech span { min-width: 0; }
                .game-legend-tech strong, .game-legend-tech small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .game-legend-tech strong { color: #26334a; font-size: 12px; }
                .game-legend-tech small { color: var(--muted); font-size: 10px; }
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
                .game-inspector { min-height: 72px; color: var(--muted); font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; }
                .game-inspector strong { color: var(--text); }
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
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) 230px;
                    grid-template-rows: auto minmax(0, 1fr);
                    width: 100%;
                    height: 100%;
                    min-height: 0;
                    border: 0;
                    border-radius: 0;
                }
                .algofight-game[data-mode=playing] .game-canvas {
                    grid-row: 2;
                    grid-column: 1;
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
                .algofight-game[data-mode=playing] .game-legend {
                    position: static;
                    grid-row: 2;
                    grid-column: 2;
                    width: auto;
                    border-radius: 0;
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
                    .algofight-game[data-mode=playing] .game-arena { grid-template-columns: minmax(0, 1fr) 152px; }
                    .game-manual-help { right: 168px; font-size: 14px; }
                    .game-legend-player { align-items: flex-start; flex-direction: column; }
                    .game-legend-player img { width: 34px; height: 34px; }
                    .game-legend-tech small { display: none; }
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
                        ? "Jouez à la souris contre les bots et progressez dans les niveaux sauvegardés"
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
                            ? '<div class="game-fixed-controller">Manuel · commandes à la souris</div><select data-role="bot-a" hidden aria-label="Joueur A manuel"></select>'
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
                    <button class="game-button game-start" data-role="switch-mode">${manualMode ? "Passer au mode programmation" : "Passer au mode manuel"}</button>
                    <button class="game-button game-start" data-role="bots-dev">Éditer les bots</button>
                    <div class="game-status" data-role="status">Chargement des bots…</div>
                    <div class="game-inspector" data-role="inspector" hidden></div>
                </aside>

                <section class="game-arena">
                    <canvas class="game-canvas" data-role="canvas"></canvas>
                    <div class="game-manual-help" data-role="manual-help" hidden></div>
                    <div class="game-hud">
                        <div class="game-hud-card a">
                            <span>Joueur A</span>
                            <strong data-role="hud-a">0 usine · 0 drone</strong>
                            <div class="game-hud-upgrades" data-role="hud-upgrades-a"></div>
                        </div>
                        <div class="game-hud-time"><span data-role="hud-time-label">Temps restant</span><strong data-role="hud-time">10:00</strong><small class="game-campaign-hud" data-role="campaign-hud" hidden></small></div>
                        <div class="game-hud-card b">
                            <span>Joueur B</span>
                            <strong data-role="hud-b">0 usine · 0 drone</strong>
                            <div class="game-hud-upgrades" data-role="hud-upgrades-b"></div>
                        </div>
                        <button class="game-button" data-role="restart">Redémarrer</button>
                    </div>
                    <div class="game-legend">
                        <div class="game-legend-title">Légende · drones et pouvoirs des usines</div>
                        <div class="game-legend-players">
                            <div class="game-legend-player a"><img data-role="legend-drone-a" src="${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.A].url}" alt=""><span data-role="legend-drone-label-a">Joueur A · ${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.A].label}</span></div>
                            <div class="game-legend-player b"><img data-role="legend-drone-b" src="${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.B].url}" alt=""><span data-role="legend-drone-label-b">Joueur B · ${DRONE_APPEARANCES[DEFAULT_DRONE_APPEARANCE.B].label}</span></div>
                        </div>
                        <div class="game-legend-technologies">${technologyLegendHtml()}</div>
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
        this.legendDroneA = this.role<HTMLImageElement>("legend-drone-a")
        this.legendDroneB = this.role<HTMLImageElement>("legend-drone-b")
        this.legendDroneLabelA = this.role<HTMLElement>("legend-drone-label-a")
        this.legendDroneLabelB = this.role<HTMLElement>("legend-drone-label-b")
        this.botAState = this.role<HTMLElement>("bot-a-state")
        this.botBState = this.role<HTMLElement>("bot-b-state")
        this.statusElement = this.role<HTMLElement>("status")
        this.scoreElement = this.role<HTMLElement>("score")
        this.statsElement = this.role<HTMLElement>("stats")
        this.inspectorElement = this.role<HTMLElement>("inspector")
        this.eventsElement = this.role<HTMLElement>("events")
        this.hudAElement = this.role<HTMLElement>("hud-a")
        this.hudBElement = this.role<HTMLElement>("hud-b")
        this.hudUpgradesAElement = this.role<HTMLElement>("hud-upgrades-a")
        this.hudUpgradesBElement = this.role<HTMLElement>("hud-upgrades-b")
        this.hudTimeElement = this.role<HTMLElement>("hud-time")
        this.hudTimeLabelElement = this.role<HTMLElement>("hud-time-label")
        this.startButton = this.role<HTMLButtonElement>("start")
        this.tournamentButton = this.role<HTMLButtonElement>("tournament")
        this.campaignButton = this.role<HTMLButtonElement>("campaign")
        this.campaignResetButton = this.role<HTMLButtonElement>("campaign-reset")
        this.restartButton = this.role<HTMLButtonElement>("restart")
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
        this.role<HTMLButtonElement>("bots-dev").addEventListener("click", () => void this.openBotsDev())
        this.role<HTMLButtonElement>("switch-mode").addEventListener("click", () => this.switchGameMode())
        this.restartButton.addEventListener("click", () => this.handleRestart())
        this.speedInput.addEventListener("input", () => {
            this.speedValue.textContent = `${this.stepsPerSecond()}/s`
        })
        this.botASelect.addEventListener("change", () => this.changeController("A"))
        this.botBSelect.addEventListener("change", () => this.changeController("B"))
        this.droneAppearanceASelect.addEventListener("change", () => this.changeDroneAppearance("A"))
        this.droneAppearanceBSelect.addEventListener("change", () => this.changeDroneAppearance("B"))
        this.canvas.addEventListener("pointermove", event => this.inspectPointer(event))
        this.canvas.addEventListener("pointerdown", event => this.handleManualPointer(event))
        this.canvas.addEventListener("pointerleave", () => {
            this.hovered = undefined
            this.updateInspector()
        })

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

    private async loadBots() {
        this.setStatus("Recherche des scripts dans /bots…")
        try {
            const scriptsPromise = listBotsScript()
            await this.spriteLoadPromise
            const scripts = (await scriptsPromise).filter(path => /\.ts$/i.test(path))
            this.botScripts = scripts
            this.botSignature = await this.computeBotSignature(scripts)
            this.fillSelect(this.botASelect, scripts, this.gameMode === "manual" ? "manual" : "bot")
            this.fillSelect(this.botBSelect, scripts, "bot")
            if (scripts.length === 0) {
                this.setWorkerState("A", "aucun bot", "error")
                this.setWorkerState("B", "aucun bot", "error")
                this.setStatus("Aucun fichier TypeScript trouvé dans /bots.", true)
                return
            }

            this.botASelect.value = this.gameMode === "manual" ? MANUAL_CONTROLLER : scripts[0]
            this.botBSelect.value = scripts[1] ?? scripts[0]
            this.botsLoaded = true
            this.startButton.disabled = false
            this.campaign = this.gameMode === "manual" ? await this.loadCampaignSave() : undefined
            this.campaignButton.disabled = this.gameMode !== "manual"
            this.updateCampaignButtons()
            this.tournamentButton.disabled = this.gameMode !== "programming" || scripts.length < 2
            this.tournamentButton.textContent = scripts.length < 2
                ? "Battle royale · 2 bots minimum"
                : `Battle royale · ${scripts.length * (scripts.length - 1)} combats`
            this.setWorkerState("A", "prêt", "pending")
            this.setWorkerState("B", "prêt", "pending")
            this.setStatus(this.gameMode === "manual"
                ? this.campaignIsCompatible(this.campaign)
                    ? `Niveaux chargés depuis ${CAMPAIGN_LEVELS_SOURCE}. Choisissez une partie libre ou reprenez la progression.`
                    : "Première partie manuelle : lancement automatique de l’évaluation des bots."
                : "Choisissez les deux scripts puis lancez le combat.")
            if (this.gameMode === "manual" && !this.campaignIsCompatible(this.campaign)) {
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

    private async openBotsDev() {
        this.setStatus("Ouverture de l’éditeur de bots…")
        try {
            const { installBotsDev } = await import("./bots-dev")
            this.destroy()
            await installBotsDev(document.body, () => {
                installAlgoFightGame(document.body, this.gameMode)
            })
        } catch (error) {
            this.setStatus(`Impossible d’ouvrir l’éditeur : ${this.errorMessage(error)}`, true)
        }
    }

    private fillSelect(select: HTMLSelectElement, scripts: string[], controller: "bot" | "manual") {
        select.replaceChildren()
        if (controller === "manual") {
            select.add(new Option("Manuel — commandes à la souris", MANUAL_CONTROLLER))
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

    private switchGameMode() {
        const nextMode: GameMode = this.gameMode === "manual" ? "programming" : "manual"
        this.destroy()
        installAlgoFightGame(document.body, nextMode)
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
        this.events = []
        this.activeDroneActions.clear()
        this.pendingDroneDestructions.clear()
        this.explosions = []
        this.launches = []
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
        const sourceEntries = await Promise.all(scripts.map(async path => {
            const source = await readSource(path.replace(/^\/+/, ""))
            return `${path}\n${source}`
        }))
        sourceEntries.unshift(JSON.stringify({ config: DEFAULT_CONFIG, levels: CAMPAIGN_POWER_LEVELS }))
        const bytes = new TextEncoder().encode(sourceEntries.join("\n\u0000\n"))
        if (crypto.subtle) {
            const digest = await crypto.subtle.digest("SHA-256", bytes)
            return [...new Uint8Array(digest)]
                .map(value => value.toString(16).padStart(2, "0"))
                .join("")
        }

        let hash = 2166136261
        for (const value of bytes) {
            hash ^= value
            hash = Math.imul(hash, 16777619)
        }
        return `fnv1a-${(hash >>> 0).toString(16)}`
    }

    private campaignConfig(powerCount: number): Config {
        return {
            ...DEFAULT_CONFIG,
            POUVOIR_COUNT: Math.max(0, Math.min(TECHNOLOGIES.length, Math.trunc(powerCount)))
        }
    }

    private isCampaignLevelsFile(value: unknown): value is CampaignLevelsFile {
        if (!value || typeof value !== "object") return false
        const data = value as Partial<CampaignLevelsFile>
        return data.version === 1
            && typeof data.botSignature === "string"
            && typeof data.width === "number"
            && typeof data.height === "number"
            && Array.isArray(data.levels)
            && data.levels.every(level =>
                typeof level?.powerCount === "number"
                && Array.isArray(level.ranking)
                && typeof level.world?.root === "string"
                && Boolean(level.world.entities)
            )
    }

    private isCampaignProgressFile(value: unknown): value is CampaignProgressFile {
        if (!value || typeof value !== "object") return false
        const data = value as Partial<CampaignProgressFile>
        return data.version === 1
            && typeof data.botSignature === "string"
            && Number.isInteger(data.levelIndex)
            && Number.isInteger(data.opponentIndex)
            && typeof data.completed === "boolean"
    }

    private async loadCampaignSave(): Promise<CampaignSave | undefined> {
        try {
            const levels = JSON.parse(await readSource(CAMPAIGN_LEVELS_SOURCE)) as unknown
            if (!this.isCampaignLevelsFile(levels)) return undefined

            let progress: CampaignProgressFile | undefined
            try {
                const value = JSON.parse(await readSource(CAMPAIGN_PROGRESS_SOURCE)) as unknown
                if (this.isCampaignProgressFile(value) && value.botSignature === levels.botSignature) {
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

    private async writeCampaignProgress(save: CampaignSave) {
        const progress: CampaignProgressFile = {
            version: 1,
            botSignature: save.botSignature,
            levelIndex: save.levelIndex,
            opponentIndex: save.opponentIndex,
            completed: save.completed
        }
        await writeSource(CAMPAIGN_PROGRESS_SOURCE, JSON.stringify(progress, null, 2) + "\n")
    }

    private async persistCampaign(save: CampaignSave, includeLevels = false) {
        if (includeLevels) {
            const levels: CampaignLevelsFile = {
                version: 1,
                botSignature: save.botSignature,
                width: save.width,
                height: save.height,
                levels: save.levels
            }
            await writeSource(CAMPAIGN_LEVELS_SOURCE, JSON.stringify(levels, null, 2) + "\n")
        }
        await this.writeCampaignProgress(save)
        this.campaign = save
        this.updateCampaignButtons()
    }

    private updateCampaignButtons() {
        if (this.gameMode !== "manual") {
            this.campaignButton.hidden = true
            this.campaignResetButton.hidden = true
            return
        }
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
            ? `Reprendre · ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""} · ${scriptName(opponent)}`
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
        if (this.gameMode !== "manual") {
            this.setStatus("La progression est disponible dans le mode manuel.", true)
            return
        }
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
                const initialWorld = new GestionMonde([], config)
                initialWorld.createWorld(this.worldWidth, this.worldHeight)
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
                version: 1,
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
        this.resetWorldPresentation(`Campagne · niveau ${level.powerCount} · adversaire ${scriptName(opponent)}`)
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
            this.setStatus(`Campagne : joueur manuel contre ${scriptName(opponent)} au niveau ${level.powerCount}.`)
            this.addEvent(`Affrontement de campagne lancé contre ${scriptName(opponent)}`)
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
                ? `Campagne · ${level.powerCount} pouvoir${level.powerCount > 1 ? "s" : ""} · ${scriptName(opponent)} (${save.opponentIndex + 1}/${level.ranking.length})`
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
        if (this.gameMode !== "programming") {
            this.setStatus("La Battle royale interactive est disponible dans le mode programmation.", true)
            return
        }
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
                        if (!outcome || runId !== this.tournamentRunId) return

                        completedMatches++
                        this.recordTournamentOutcome(standings, scriptA, scriptB, outcome)
                        const winner = outcome.winner === "A" ? scriptName(scriptA)
                            : outcome.winner === "B" ? scriptName(scriptB)
                                : "Match nul"
                        const reason = outcome.reason === "worker-error" ? "erreur d’un worker"
                            : outcome.reason === "time" ? "temps écoulé"
                                : "élimination"
                        recentResults.unshift(
                            `${scriptName(scriptA)} (A) × ${scriptName(scriptB)} (B)|${winner} · T${outcome.tick} · ${reason}`
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
            if (result) this.finishMatch(result)
        } finally {
            this.stepInFlight = false
        }
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
        this.hudTimeElement.textContent = this.remainingTime()
        this.hudTimeLabelElement.textContent = result
            ? result.winner
                ? `Victoire joueur ${this.playerName(result.winner)}`
                : "Match nul"
            : "Temps restant"
        this.updateInspector()
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

    private hudUpgradesHtml(stats: ReturnType<AlgoFightGame["playerSummary"]>) {
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

    private statsHtml(a: ReturnType<AlgoFightGame["playerSummary"]>, b: ReturnType<AlgoFightGame["playerSummary"]>) {
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

    private playerStatsHtml(player: PlayerKey, stats: ReturnType<AlgoFightGame["playerSummary"]>) {
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

        const margin = 19
        const scale = Math.min((width - margin * 2) / this.worldWidth, (height - margin * 2) / this.worldHeight)
        const mapWidth = this.worldWidth * scale
        const mapHeight = this.worldHeight * scale
        const offsetX = (width - mapWidth) / 2
        const offsetY = (height - mapHeight) / 2
        this.view = { scale, offsetX, offsetY }

        this.ctx.save()
        this.ctx.translate(offsetX, offsetY)
        this.ctx.scale(scale, scale)
        this.drawGrid(scale)
        this.drawResources(scale)
        this.drawFactories(time, scale)
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
        if (!this.running || !this.manualPlayer || this.gestionMonde.combatResult) return
        const joueur = this.manualJoueur()
        if (!joueur) return
        const pulse = Math.sin(time / 180) * 1.5

        for (const usine of this.gestionMonde.usines()) {
            const newDrone = usine.etat?.joueur === joueur ? usine.etat.newDrone : undefined
            if (!newDrone || !this.droneIsReadyForManualOrder(newDrone)) continue
            this.drawManualBadge(usine.position, "D+", "#37e686", "#123e2b", 45 + pulse, scale)
        }

        for (const drone of this.gestionMonde.drones()) {
            if (drone.joueur !== joueur || !this.droneCanAttackManually(drone)) continue
            this.drawManualBadge(drone.position, "ATK", "#ff765f", "#511d22", 27 + pulse, scale)
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
        if (!this.gestionMonde.entities.includes(drone) || !this.droneIsReadyForManualOrder(drone)) {
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
        this.legendDroneA.src = previewA
        this.legendDroneB.src = previewB
        this.legendDroneLabelA.textContent = `Joueur A · ${DRONE_APPEARANCES[appearanceA].label}`
        this.legendDroneLabelB.textContent = `Joueur B · ${DRONE_APPEARANCES[appearanceB].label}`
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

    private entityAtPointer(event: PointerEvent) {
        const rect = this.canvas.getBoundingClientRect()
        const x = (event.clientX - rect.left - this.view.offsetX) / this.view.scale
        const y = (event.clientY - rect.top - this.view.offsetY) / this.view.scale
        let best: GameElement | undefined
        let bestDistance = Infinity
        for (const entity of this.gestionMonde.entities) {
            const radius = entity instanceof Usine ? 34 : entity instanceof Drone ? 20 : 15
            const distance = Math.hypot(entity.position.x - x, entity.position.y - y)
            if (distance <= radius && distance < bestDistance) {
                best = entity
                bestDistance = distance
            }
        }
        return best
    }

    private inspectPointer(event: PointerEvent) {
        const best = this.entityAtPointer(event)
        if (best !== this.hovered) {
            this.hovered = best
            this.updateInspector()
        }
    }

    private handleManualPointer(event: PointerEvent) {
        const player = this.manualPlayer
        if (!this.running || !player || this.gestionMonde.combatResult) return
        event.preventDefault()
        const entity = this.entityAtPointer(event)
        const joueur = this.manualJoueur()
        if (!joueur) return

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
            this.updateManualHelp("Aucune cible ici. Cliquez directement sur une usine, une ressource ou un drone adverse.", "error")
            return
        }
        if (entity === selectedDrone) {
            this.clearManualSelection()
            return
        }
        if (entity instanceof Drone && entity.joueur === joueur) {
            this.updateManualHelp("Un drone allié ne peut pas être ciblé. Cliquez sur une autre cible.", "error")
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
        const accepted = this.submitManualSetTargetRef(joueur, order)
        if (!accepted) {
            this.updateManualHelp("Ordre refusé : le drone est occupé ou la cible n’est plus disponible.", "error")
            return
        }

        const droneId = shortId(selectedDrone.id)
        const targetName = this.shotTargetName(entity)
        const count = player === "A" ? ++this.responseCountA : ++this.responseCountB
        this.setWorkerState(player, `manuel · ${count} ordre${count > 1 ? "s" : ""}`, "active")
        this.addEvent(`Ordre manuel ${player} : drone #${droneId} vers ${targetName}`)
        this.clearManualSelection(false)
        this.updateManualHelp(`Ordre envoyé au drone #${droneId} vers ${targetName}. Sélectionnez une nouvelle unité.`, "success")
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

        if (!this.droneIsReadyForManualOrder(drone)) {
            this.updateManualHelp("Ce drone est occupé : attendez qu’il termine son action.", "error")
            return
        }

        this.manualSelectedDrone = drone
        this.manualSelectedFactory = factory
        const source = factory ? `newDrone de l’usine #${shortId(factory.id)}` : `drone #${shortId(drone.id)}`
        this.updateManualHelp(`${source} sélectionné · cliquez maintenant sur sa cible.`, "selected")
    }

    private droneIsReadyForManualOrder(drone: Drone) {
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        return state?.type === "wait" && (drone.cible?.fireTime ?? 0) <= 0
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
        if (updateHelp) this.updateManualHelp()
    }

    private updateManualHelp(text?: string, state: "idle" | "selected" | "success" | "error" = "idle") {
        const active = Boolean(
            this.manualPlayer
            && this.running
            && !this.gestionMonde?.combatResult
            && this.root.dataset.mode === "playing"
        )
        this.canvas.dataset.manual = String(active)
        this.manualHelpElement.hidden = !active
        if (!active) return

        this.manualHelpElement.dataset.state = state
        this.manualHelpElement.textContent = text ?? (
            this.manualSelectedDrone
                ? `Drone #${shortId(this.manualSelectedDrone.id)} sélectionné · cliquez sur sa cible.`
                : `Joueur ${this.manualPlayer} manuel · D+ = newDrone prêt · ATK = drone libre avec énergie.`
        )
    }

    private updateInspector() {
        const entity = this.hovered
        if (!entity) {
            this.inspectorElement.textContent = "Survolez une entité sur la carte."
            return
        }
        if (entity instanceof Drone) {
            const state = this.gestionMonde.droneStates.find(value => value.ref === entity)
            this.inspectorElement.innerHTML = `
                <strong>Drone ${this.playerName(entity.joueur)} #${shortId(entity.id)}</strong><br>
                Position : ${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}<br>
                Énergie / Vie : ${entity.energieCount} / ${entity.vieCount}<br>
                État : ${state?.type ?? "absent"}<br>
                Cooldown : ${entity.cible?.fireTime ?? 0}
            `
            return
        }
        if (entity instanceof Usine) {
            const technology = TECHNOLOGY_VISUALS[entity.technologie]
            const technologyEnabled = this.gestionMonde.isTechnologyEnabled(entity.technologie)
            const buildDuration = entity.etat
                ? this.gestionMonde.buildTime(entity.etat.joueur)
                : 0
            const production = !entity.etat
                ? "inactive"
                : entity.etat.newDrone
                    ? "drone prêt"
                    : `${Math.max(0, entity.etat.time)} / ${buildDuration} ticks`
            this.inspectorElement.innerHTML = `
                <strong>Usine #${shortId(entity.id)} · ${technology.label}</strong><br>
                Pouvoir : ${technologyEnabled ? technology.effect : "verrouillé pour ce niveau"}<br>
                Propriétaire : ${entity.etat ? this.playerName(entity.etat.joueur) : "neutre"}<br>
                Production : ${production}<br>
                Vie de l’usine : ${entity.etat?.vieCount ?? 0}<br>
                Drone prêt : ${entity.etat?.newDrone ? "oui" : "non"}
            `
            return
        }
        this.inspectorElement.innerHTML = `
            <strong>${entity instanceof Energie ? "Énergie" : "Vie"} #${shortId(entity.id)}</strong><br>
            Position : ${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}<br>
            Disponible : ${(entity as Energie | Vie).proprietaire ? "non" : "oui"}
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
            this.updateCampaignHud("Défaite : progression inchangée · cliquez sur Réessayer")
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
            `Victoire enregistrée · prochain : ${scriptName(nextOpponent)} · ${nextLevel.powerCount} pouvoir${nextLevel.powerCount > 1 ? "s" : ""}`
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
        this.setStatus(this.gameMode === "manual"
            ? "Choisissez une partie manuelle libre ou reprenez la progression."
            : "Choisissez les scripts du duel ou relancez une Battle royale.")
        this.refreshUi()
    }

    private returnToLobby() {
        this.stopWorkers()
        this.campaignActive = false
        this.manualPlayer = undefined
        this.clearManualSelection()
        this.running = false
        this.accumulator = 0
        this.campaignHudElement.hidden = true
        this.restartButton.textContent = "Redémarrer"
        this.showLobby()
        this.setWorkerState("A", "prêt", "pending")
        this.setWorkerState("B", "prêt", "pending")
        this.updateCampaignButtons()
        this.setStatus(this.gameMode === "manual"
            ? "Choisissez une partie manuelle libre ou reprenez la progression."
            : "Choisissez un duel programmé ou une Battle royale.")
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
    }
}

let currentGame: AlgoFightGame | undefined

export function installAlgoFightGame(
    container: HTMLElement = document.body,
    mode: GameMode = "programming"
) {
    currentGame?.destroy()
    const game = new AlgoFightGame(mode)
    container.replaceChildren(game.createInterface())
    game.init()
    currentGame = game
    return game
}
