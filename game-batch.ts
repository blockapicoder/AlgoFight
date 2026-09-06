import {
    DEFAULT_CONFIG,
    Energie,
    Usine,
    Vie,
    type Config,
    type Position
} from "./algofight-entity-model"
import { isGeneratedBotSourcePath, listBotSources, readSource, writeSource, type BotSourceNode } from "./bots-script-tools"
import { entityToJsonData, type JsonData } from "./node_modules/tauri-kargo-tools/src/entity-model"
import { GestionMonde } from "./gestion-algofight-entity-model"

export const GAME_LEVELS_SOURCE = "algofight-levels.json"
export const GAME_PROGRESS_SOURCE = "algofight-progression.json"
export const GAME_POWER_LEVELS = [0, 1, 2, 3, 4, 5] as const

export interface GameLevelData {
    powerCount: number
    world: JsonData
    /** Bots classés du plus faible au plus fort pour ce niveau. */
    ranking: string[]
}

export interface GameLevelsData {
    version: 2
    botSignature: string
    width: number
    height: number
    levels: GameLevelData[]
}

/** (nombre de pouvoirs + 1) × nombre de bots réellement affrontés. */
export function gameProgressionLevelCount(
    data: Pick<GameLevelsData, "levels">,
    excludedBotScript?: string
) {
    const botCount = data.levels[0]?.ranking.filter(script => script !== excludedBotScript).length ?? 0
    return data.levels.length * botCount
}

export interface GameProgressData {
    version: 1
    botSignature: string
    levelIndex: number
    opponentIndex: number
    completed: boolean
    /** Progression du mode programmation, conservée séparément pour chaque bot utilisateur. */
    programming?: Record<string, ProgrammingBotProgressData>
    /** Dernier bot utilisé dans le mode programmation. */
    selectedProgrammingBot?: string
}

export interface ProgrammingBotProgressData {
    /** Prochain niveau à jouer, ou dernier niveau lorsque le jeu est terminé. */
    levelIndex: number
    completed: boolean
}

export interface BatchMatchOutcome {
    winner: "A" | "B" | "draw"
    tick: number
    droneCountA: number
    droneCountB: number
    reason: "elimination" | "time" | "worker-error"
}

export interface BatchFailure {
    botScript: string
    opponentScript: string
    /** Index linéaire du combat dans toute la progression. */
    levelIndex: number
    levelCount: number
    powerCount: number
    opponentIndex: number
    opponentCount: number
    width: number
    height: number
    world: JsonData
    outcome: BatchMatchOutcome
}

/** Résultat complet d'un combat, y compris lorsqu'il est gagné. */
export interface BatchMatchCompleted extends BatchFailure {}

export interface BatchProgress {
    levelIndex: number
    levelCount: number
    powerCount: number
    opponentIndex: number
    opponentCount: number
    opponentScript: string
    tick: number
}

export interface RunBotBatchOptions {
    levels?: GameLevelsData
    signal?: AbortSignal
    onProgress?: (progress: BatchProgress) => void
    stepBatch?: number
    /** Premier niveau linéaire à exécuter, utile après la modification d’un bot. */
    startLevelIndex?: number
    /** Niveaux linéaires précis à exécuter. Sans cette option, tous les niveaux sont joués. */
    levelIndexes?: readonly number[]
    /** Appelé après chaque combat afin de conserver aussi les résultats gagnants. */
    onMatchComplete?: (match: BatchMatchCompleted) => void | Promise<void>
}

export interface GameLevelsGenerationProgress {
    phase: "world" | "match" | "save"
    levelIndex: number
    levelCount: number
    powerCount: number
    matchIndex: number
    matchCount: number
    scriptA?: string
    scriptB?: string
    tick?: number
}

export interface GenerateGameLevelsOptions {
    width?: number
    height?: number
    signal?: AbortSignal
    stepBatch?: number
    onProgress?: (progress: GameLevelsGenerationProgress) => void
}

function isGameLevel(value: unknown): value is GameLevelData {
    if (!value || typeof value !== "object") return false
    const level = value as Partial<GameLevelData>
    return typeof level.powerCount === "number"
        && Array.isArray(level.ranking)
        && level.ranking.every(script => typeof script === "string")
        && typeof level.world?.root === "string"
        && Boolean(level.world.entities)
}

export function isGameLevelsData(value: unknown): value is GameLevelsData {
    if (!value || typeof value !== "object") return false
    const data = value as Partial<GameLevelsData>
    return data.version === 2
        && typeof data.botSignature === "string"
        && typeof data.width === "number"
        && typeof data.height === "number"
        && Array.isArray(data.levels)
        && data.levels.every(isGameLevel)
}

export function isGameProgressData(value: unknown): value is GameProgressData {
    if (!value || typeof value !== "object") return false
    const data = value as Partial<GameProgressData>
    const programmingIsValid = data.programming === undefined || (
        Boolean(data.programming)
        && typeof data.programming === "object"
        && !Array.isArray(data.programming)
        && Object.values(data.programming).every(progress =>
            Boolean(progress)
            && typeof progress === "object"
            && Number.isInteger(progress.levelIndex)
            && typeof progress.completed === "boolean"
        )
    )
    const selectedBotIsValid = data.selectedProgrammingBot === undefined
        || typeof data.selectedProgrammingBot === "string"
    return data.version === 1
        && typeof data.botSignature === "string"
        && Number.isInteger(data.levelIndex)
        && Number.isInteger(data.opponentIndex)
        && typeof data.completed === "boolean"
        && programmingIsValid
        && selectedBotIsValid
}

export async function readGameLevels() {
    const value = JSON.parse(await readSource(GAME_LEVELS_SOURCE)) as unknown
    if (!isGameLevelsData(value)) throw new Error(`${GAME_LEVELS_SOURCE} est invalide`)
    return value
}

export async function writeGameLevels(value: GameLevelsData) {
    await writeSource(GAME_LEVELS_SOURCE, JSON.stringify(value, null, 2) + "\n")
}

export async function readGameProgress() {
    const value = JSON.parse(await readSource(GAME_PROGRESS_SOURCE)) as unknown
    if (!isGameProgressData(value)) throw new Error(`${GAME_PROGRESS_SOURCE} est invalide`)
    return value
}

export async function writeGameProgress(value: GameProgressData) {
    let nextValue = value
    // Le mode manuel écrit les champs historiques. Il ne doit pas effacer les
    // progressions des bots du mode programmation enregistrées dans le même JSON.
    if (value.programming === undefined) {
        try {
            const saved = await readGameProgress()
            if (saved.botSignature === value.botSignature) {
                nextValue = {
                    ...value,
                    ...(saved.programming ? { programming: saved.programming } : {}),
                    ...(value.selectedProgrammingBot === undefined && saved.selectedProgrammingBot
                        ? { selectedProgrammingBot: saved.selectedProgrammingBot }
                        : {})
                }
            }
        } catch {
            // Le fichier n'existe pas encore ou sera remplacé par une valeur valide.
        }
    }
    await writeSource(GAME_PROGRESS_SOURCE, JSON.stringify(nextValue, null, 2) + "\n")
}

export async function readProgrammingBotProgress(
    botScript: string,
    botSignature: string
) {
    const progress = await readGameProgress()
    if (progress.botSignature !== botSignature) return undefined
    return progress.programming?.[botScript]
}

export async function readSelectedProgrammingBot(botSignature: string) {
    const progress = await readGameProgress()
    if (progress.botSignature !== botSignature) return undefined
    return progress.selectedProgrammingBot
}

export async function writeProgrammingBotProgress(
    botScript: string,
    botSignature: string,
    value: ProgrammingBotProgressData
) {
    let progress: GameProgressData = {
        version: 1,
        botSignature,
        levelIndex: 0,
        opponentIndex: 0,
        completed: false,
        programming: {}
    }
    try {
        const saved = await readGameProgress()
        if (saved.botSignature === botSignature) progress = saved
    } catch {
        // Premier enregistrement : la structure vide ci-dessus est utilisée.
    }
    await writeGameProgress({
        ...progress,
        botSignature,
        selectedProgrammingBot: botScript,
        programming: {
            ...progress.programming,
            [botScript]: {
                levelIndex: Math.max(0, Math.trunc(value.levelIndex)),
                completed: value.completed
            }
        }
    })
}

export function levelConfig(powerCount: number): Config {
    return {
        ...DEFAULT_CONFIG,
        POUVOIR_COUNT: Math.max(0, Math.min(GAME_POWER_LEVELS.length - 1, Math.trunc(powerCount)))
    }
}

const SYMMETRIC_PLACEMENT_ATTEMPTS = 100_000

function positionDistance(a: Position, b: Position) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.sqrt(dx * dx + dy * dy)
}

function createSymmetricPositions(
    count: number,
    width: number,
    height: number,
    minimumDistance: number,
    fixedPositions: readonly Position[] = []
) {
    if (count % 2 !== 0) {
        throw new Error(`La génération symétrique nécessite un nombre pair d'éléments (${count} reçu)`)
    }

    const positions: Position[] = []
    let failedAttempts = 0
    while (positions.length < count) {
        const first = {
            x: Math.random() * width,
            y: Math.random() * height
        }
        const opposite = {
            x: width - first.x,
            y: height - first.y
        }
        const occupied = [...fixedPositions, ...positions]
        const valid = positionDistance(first, opposite) >= minimumDistance
            && occupied.every(value => positionDistance(first, value) >= minimumDistance)
            && occupied.every(value => positionDistance(opposite, value) >= minimumDistance)

        if (valid) {
            positions.push(first, opposite)
            failedAttempts = 0
        } else {
            failedAttempts++
            if (failedAttempts >= SYMMETRIC_PLACEMENT_ATTEMPTS) {
                throw new Error(
                    `Impossible de placer ${count} éléments symétriques dans un monde de ${width} x ${height}`
                )
            }
        }
    }
    return positions
}

function assignSymmetricPositions<T extends { position: Position }>(
    entities: readonly T[],
    width: number,
    height: number,
    minimumDistance: number,
    fixedPositions: readonly Position[] = []
) {
    const positions = createSymmetricPositions(
        entities.length,
        width,
        height,
        minimumDistance,
        fixedPositions
    )
    entities.forEach((entity, index) => entity.position = positions[index])
    return positions
}

/**
 * Crée le monde d'un niveau sous forme de paires opposées par rapport au centre.
 * Les usines d'une paire donnent toujours la même technologie.
 */
export function createSymmetricLevelWorld(width: number, height: number, config: Config) {
    const world = new GestionMonde([], config)
    world.createWorld(width, height)

    const factories = world.usines()
    const factoryA = factories.find(factory => factory.etat?.joueur === world.joueurA)
    const factoryB = factories.find(factory => factory.etat?.joueur === world.joueurB)
    if (!factoryA || !factoryB) throw new Error("Les usines initiales des joueurs sont introuvables")

    // La première paire est réservée aux deux joueurs afin que leurs points de
    // départ, ainsi que le pouvoir de leur usine, soient strictement équivalents.
    const orderedFactories: Usine[] = [
        factoryA,
        factoryB,
        ...factories.filter(factory => factory !== factoryA && factory !== factoryB)
    ]
    const factoryPositions = assignSymmetricPositions(
        orderedFactories,
        width,
        height,
        config.USINE_DISTANCE_MIN
    )
    for (let index = 0; index < orderedFactories.length; index += 2) {
        orderedFactories[index + 1].technologie = orderedFactories[index].technologie
    }

    const energies = world.energies() as Energie[]
    const energyPositions = assignSymmetricPositions(
        energies,
        width,
        height,
        config.RESSOURCE_DISTANCE_MIN,
        factoryPositions
    )
    const lives = world.vies() as Vie[]
    assignSymmetricPositions(
        lives,
        width,
        height,
        config.RESSOURCE_DISTANCE_MIN,
        [...factoryPositions, ...energyPositions]
    )
    return world
}

export async function gameBotSignature(scripts: string[]) {
    const sourcePaths = new Set(scripts)
    const generatedOnly = scripts.length > 0 && scripts.every(isGeneratedBotSourcePath)
    try {
        const tree = await listBotSources()
        const visit = (nodes: BotSourceNode[]) => {
            for (const node of nodes) {
                if (node.type === "directory") visit(node.content)
                else if (
                    /\.ts$/i.test(node.name)
                    && (!generatedOnly || isGeneratedBotSourcePath(node.path))
                ) sourcePaths.add(`/${node.path}`)
            }
        }
        visit(tree.content)
    } catch {
        // La liste fournie reste suffisante si l’explorateur des utilitaires est indisponible.
    }
    const sourceEntries = await Promise.all([...sourcePaths].sort().map(async path => {
        const source = await readSource(path.replace(/^\/+/, ""))
        return `${path}\n${source}`
    }))
    sourceEntries.unshift(JSON.stringify({ config: DEFAULT_CONFIG, levels: GAME_POWER_LEVELS }))
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

function scriptName(path: string) {
    return (path.split("/").filter(Boolean).at(-1) ?? path).replace(/\.ts$/i, "")
}

function scriptWorkerUrl(path: string, player: "A" | "B") {
    const javascriptPath = path.replace(/\.ts$/i, ".js")
    const separator = javascriptPath.includes("?") ? "&" : "?"
    return `${javascriptPath}${separator}player=${player}&batch=${Date.now()}`
}

function yieldToWorkers(delay = 0) {
    return new Promise<void>(resolve => setTimeout(resolve, delay))
}

function assertNotAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Exécution batch arrêtée")
}

async function runBatchMatch(
    botScript: string,
    opponentScript: string,
    level: GameLevelData,
    levelIndex: number,
    levelCount: number,
    opponentIndex: number,
    opponentCount: number,
    options: RunBotBatchOptions
): Promise<BatchMatchOutcome> {
    const game = new GestionMonde([], levelConfig(level.powerCount))
    game.load(level.world)
    let failedA = false
    let failedB = false
    let reportWorkerFailure!: () => void
    const workerFailure = new Promise<"worker-error">(resolve => {
        reportWorkerFailure = () => resolve("worker-error")
    })
    const markWorkerFailed = (player: "A" | "B") => {
        if (player === "A") failedA = true
        else failedB = true
        reportWorkerFailure()
    }
    const workerFailureOutcome = (): BatchMatchOutcome => {
        const droneCountA = game.drones().filter(drone => drone.joueur === game.joueurA).length
        const droneCountB = game.drones().filter(drone => drone.joueur === game.joueurB).length
        return {
            winner: failedA === failedB ? "draw" : failedA ? "B" : "A",
            tick: game.combatTick,
            droneCountA,
            droneCountB,
            reason: "worker-error"
        }
    }
    const workerA = new Worker(scriptWorkerUrl(botScript, "A"), {
        type: "module",
        name: `Batch A · ${scriptName(botScript)}`
    })
    const workerB = new Worker(scriptWorkerUrl(opponentScript, "B"), {
        type: "module",
        name: `Batch B · ${scriptName(opponentScript)}`
    })
    workerA.addEventListener("error", event => {
        event.preventDefault()
        markWorkerFailed("A")
    })
    workerA.addEventListener("messageerror", () => markWorkerFailed("A"))
    workerB.addEventListener("error", event => {
        event.preventDefault()
        markWorkerFailed("B")
    })
    workerB.addEventListener("messageerror", () => markWorkerFailed("B"))

    try {
        game.setWorkerA(workerA)
        game.setWorkerB(workerB)
        await yieldToWorkers(16)
        const stepBatch = Math.max(1, Math.trunc(options.stepBatch ?? 50))
        let progressStepCount = 0
        while (!game.combatResult) {
            assertNotAborted(options.signal)
            if (failedA || failedB) {
                return workerFailureOutcome()
            }

            const stepStatus = await Promise.race([
                game.step().then(() => "step-complete" as const),
                workerFailure
            ])
            if (stepStatus === "worker-error") {
                return workerFailureOutcome()
            }

            progressStepCount++
            if (progressStepCount >= stepBatch || game.combatResult) {
                progressStepCount = 0
                options.onProgress?.({
                    levelIndex,
                    levelCount,
                    powerCount: level.powerCount,
                    opponentIndex,
                    opponentCount,
                    opponentScript,
                    tick: game.combatTick
                })
            }
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
        workerA.terminate()
        workerB.terminate()
    }
}

interface BatchStanding {
    script: string
    wins: number
    draws: number
    losses: number
    points: number
    dronesFor: number
    dronesAgainst: number
}

function recordOutcome(
    standings: Map<string, BatchStanding>,
    scriptA: string,
    scriptB: string,
    outcome: BatchMatchOutcome
) {
    const a = standings.get(scriptA)!
    const b = standings.get(scriptB)!
    a.dronesFor += outcome.droneCountA
    a.dronesAgainst += outcome.droneCountB
    b.dronesFor += outcome.droneCountB
    b.dronesAgainst += outcome.droneCountA
    if (outcome.winner === "A") {
        a.wins++
        a.points += 3
        b.losses++
    } else if (outcome.winner === "B") {
        b.wins++
        b.points += 3
        a.losses++
    } else {
        a.draws++
        b.draws++
        a.points++
        b.points++
    }
}

/** Génère les mondes et le classement faible → fort de chaque niveau. */
export async function generateGameLevels(
    botScripts: string[],
    options: GenerateGameLevelsOptions = {}
): Promise<GameLevelsData> {
    if (botScripts.length === 0) throw new Error("Aucun bot disponible pour générer les niveaux")
    const width = Math.max(300, Math.trunc(options.width ?? 1200))
    const height = Math.max(300, Math.trunc(options.height ?? 720))
    const matchesPerLevel = botScripts.length * (botScripts.length - 1)
    const matchCount = matchesPerLevel * GAME_POWER_LEVELS.length
    const levels: GameLevelData[] = []
    let matchIndex = 0

    for (let levelIndex = 0; levelIndex < GAME_POWER_LEVELS.length; levelIndex++) {
        assertNotAborted(options.signal)
        const powerCount = GAME_POWER_LEVELS[levelIndex]
        options.onProgress?.({
            phase: "world", levelIndex, levelCount: GAME_POWER_LEVELS.length,
            powerCount, matchIndex, matchCount
        })
        const initialWorld = createSymmetricLevelWorld(width, height, levelConfig(powerCount))
        const world = entityToJsonData(initialWorld.save())
        const level: GameLevelData = { powerCount, world, ranking: [] }
        const standings = new Map<string, BatchStanding>(botScripts.map(script => [script, {
            script,
            wins: 0,
            draws: 0,
            losses: 0,
            points: 0,
            dronesFor: 0,
            dronesAgainst: 0
        }]))

        for (let first = 0; first < botScripts.length; first++) {
            for (let second = first + 1; second < botScripts.length; second++) {
                const matches = [
                    [botScripts[first], botScripts[second]],
                    [botScripts[second], botScripts[first]]
                ] as const
                for (const [scriptA, scriptB] of matches) {
                    assertNotAborted(options.signal)
                    const currentMatch = matchIndex
                    const outcome = await runBatchMatch(
                        scriptA,
                        scriptB,
                        level,
                        levelIndex,
                        GAME_POWER_LEVELS.length,
                        currentMatch,
                        matchCount,
                        {
                            signal: options.signal,
                            stepBatch: options.stepBatch,
                            onProgress: progress => options.onProgress?.({
                                phase: "match",
                                levelIndex,
                                levelCount: GAME_POWER_LEVELS.length,
                                powerCount,
                                matchIndex: currentMatch,
                                matchCount,
                                scriptA,
                                scriptB,
                                tick: progress.tick
                            })
                        }
                    )
                    recordOutcome(standings, scriptA, scriptB, outcome)
                    matchIndex++
                }
            }
        }

        level.ranking = [...standings.values()]
            .sort((a, b) =>
                b.points - a.points
                || b.wins - a.wins
                || (b.dronesFor - b.dronesAgainst) - (a.dronesFor - a.dronesAgainst)
                || a.script.localeCompare(b.script, "fr")
            )
            .reverse()
            .map(standing => standing.script)
        levels.push(level)
    }

    const data: GameLevelsData = {
        version: 2,
        botSignature: await gameBotSignature(botScripts),
        width,
        height,
        levels
    }
    options.onProgress?.({
        phase: "save",
        levelIndex: GAME_POWER_LEVELS.length - 1,
        levelCount: GAME_POWER_LEVELS.length,
        powerCount: GAME_POWER_LEVELS[GAME_POWER_LEVELS.length - 1],
        matchIndex: matchCount,
        matchCount
    })
    await writeGameLevels(data)
    await writeGameProgress({
        version: 1,
        botSignature: data.botSignature,
        levelIndex: 0,
        opponentIndex: 0,
        completed: false,
        programming: {}
    })
    return data
}

/**
 * Exécute le bot sur les niveaux dans l’ordre. Chaque niveau est validé
 * uniquement si le bot bat tous ses adversaires. Retourne le premier échec,
 * ou undefined lorsque tout le jeu est gagné.
 */
export async function runBotBatch(
    botScript: string,
    options: RunBotBatchOptions = {}
): Promise<BatchFailure | undefined> {
    if (!botScript) throw new Error("Sélectionnez un bot")
    const levels = options.levels ?? await readGameLevels()
    const opponentsByPower = levels.levels.map(level =>
        level.ranking.filter(script => script !== botScript)
    )
    const levelCount = gameProgressionLevelCount(levels, botScript)
    const startLevelIndex = Math.max(0, Math.min(
        levelCount,
        Math.trunc(options.startLevelIndex ?? 0)
    ))
    const selectedLevelIndexes = options.levelIndexes
        ? new Set(options.levelIndexes
            .map(index => Math.trunc(index))
            .filter(index => index >= startLevelIndex && index < levelCount))
        : undefined
    let progressionLevelIndex = 0
    for (let powerLevelIndex = 0; powerLevelIndex < levels.levels.length; powerLevelIndex++) {
        assertNotAborted(options.signal)
        const level = levels.levels[powerLevelIndex]
        const opponents = opponentsByPower[powerLevelIndex]
        for (let opponentIndex = 0; opponentIndex < opponents.length; opponentIndex++) {
            if (
                progressionLevelIndex < startLevelIndex
                || (selectedLevelIndexes && !selectedLevelIndexes.has(progressionLevelIndex))
            ) {
                progressionLevelIndex++
                continue
            }
            const opponentScript = opponents[opponentIndex]
            const outcome = await runBatchMatch(
                botScript,
                opponentScript,
                level,
                progressionLevelIndex,
                levelCount,
                opponentIndex,
                opponents.length,
                options
            )
            const completedMatch: BatchMatchCompleted = {
                botScript,
                opponentScript,
                levelIndex: progressionLevelIndex,
                levelCount,
                powerCount: level.powerCount,
                opponentIndex,
                opponentCount: opponents.length,
                width: levels.width,
                height: levels.height,
                world: level.world,
                outcome
            }
            await options.onMatchComplete?.(completedMatch)
            if (outcome.winner !== "A") {
                return completedMatch
            }
            progressionLevelIndex++
        }
    }
    return undefined
}
