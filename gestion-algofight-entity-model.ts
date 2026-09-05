import {
    Config,
    DEFAULT_CONFIG,
    Drone,
    Energie,
    Element,
    Joueur,
    Position,
    Target as DroneTarget,
    Technologie,
    Usine,
    UsineEtat,
    Vie,
    SetTargetRef,
    Monde,
    Sauvegarde,
    Log as BotState,
    BotTurnComplete
} from "./algofight-entity-model"
import { entityToJsonData, JsonData, JsonDatatoEntity } from "./entity-model"


export const POUVOIRS: readonly Technologie[] = [
    "Population",
    "Vitesse",
    "Porte",
    "Transport",
    "Puissance"
]


const MAX_PLACEMENT_ATTEMPTS = 100_000
const INTERACTION_DISTANCE_EPSILON = 1e-6

export type Target = Drone | Usine | Energie | Vie

export interface DroneMoveState {
    type: "move"
    ref: Drone
    refTarget: Target
    target: Position
    distance: number
    sx: number
    sy: number
    dep: number
}

export interface DroneWaitState {
    type: "wait"
    ref: Drone
}

export type DroneState = DroneMoveState | DroneWaitState

export interface UsineState {
    ref: Usine
}

export interface RessourceState {
    ref: Energie | Vie
}

export type CombatEndReason = "elimination" | "time"

export interface CombatResult {
    reason: CombatEndReason
    winner?: Joueur
    loser?: Joueur
    draw: boolean
    tick: number
    droneCountA: number
    droneCountB: number
}

export function dist(p: Position, q: Position) {
    const dx = p.x - q.x
    const dy = p.y - q.y
    return Math.sqrt(dx * dx + dy * dy)
}

function position(x: number, y: number) {
    const result: Position = {
        x: x,
        y: y
    }
    return result
}

function copyPosition(value: Position) {
    return position(value.x, value.y)
}

function usineEtat(
    joueur: Joueur,
    time: number,
    vieCount = 0,
    populationCount = 0
) {
    const result: UsineEtat = {
        joueur: joueur,
        time: time,
        vieCount,
        populationCount: populationCount
    }
    return result
}

/**
 * Version de GestionMonde qui travaille directement avec les classes de
 * algofight-entity-model, sans DataModelServer ni Ref.
 */
export class GestionMonde {
    entities: Element[]
    config: Config
    droneStates: DroneState[] = []
    usineStates: UsineState[] = []
    ressourceStates: RessourceState[] = []
    joueurA: Joueur
    joueurB: Joueur
    dataLogA?: BotState
    dataLogB?: BotState
    workerA!: Worker
    workerB!: Worker
    combatTick = 0
    combatResult?: CombatResult
    totalUsinePopulation?: number

    constructor(entities: Element[] = [], config: Config = DEFAULT_CONFIG) {
        this.entities = entities
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.joueurA = new Joueur()
        this.joueurB = new Joueur()
        this.rebuildStates()
    }
    getTotalUsinePopulation(): number {
        if (this.totalUsinePopulation === undefined) {
            this.totalUsinePopulation = this.usines().filter((u) => u.technologie === "Population").length
        }
        return this.totalUsinePopulation
    }
    load(data: JsonData) {
        const sauvegarde: Sauvegarde = JsonDatatoEntity(data, [Energie, Vie, Drone, Joueur, Sauvegarde, Usine])
        this.entities = sauvegarde.entities
        this.joueurA = sauvegarde.joueurA
        this.joueurB = sauvegarde.joueurB
        this.dataLogA = undefined
        this.dataLogB = undefined
        this.totalUsinePopulation = undefined
        this.resetCombat()
        this.rebuildStates()
    }
    save(): Sauvegarde {
        const r = new Sauvegarde()
        r.entities = this.entities
        r.joueurA = this.joueurA
        r.joueurB = this.joueurB
        return r
    }


    private rebuildStates() {
        this.droneStates = this.drones().map(ref => ({ type: "wait", ref }))
        this.usineStates = this.usines().map(ref => ({ ref }))
        this.ressourceStates = this.ressources().map(ref => ({ ref }))
    }

    private resetCombat() {
        this.stepCallback?.(undefined)
        this.stepCallback = undefined
        this.pendingStep = undefined
        this.stepJoueurCount = 0
        this.combatTick = 0
        this.combatResult = undefined
    }
    drones() {
        return this.entities.filter((entity): entity is Drone => entity instanceof Drone)
    }

    usines() {
        return this.entities.filter((entity): entity is Usine => entity instanceof Usine)
    }

    energies() {
        return this.entities.filter((entity): entity is Energie => entity instanceof Energie)
    }

    vies() {
        return this.entities.filter((entity): entity is Vie => entity instanceof Vie)
    }

    ressources() {
        return this.entities.filter((entity): entity is Energie | Vie =>
            entity instanceof Energie || entity instanceof Vie
        )
    }

    private addUsine(pos: Position, technologie: Technologie) {
        const usine = new Usine()
        usine.position = pos
        usine.technologie = technologie
        this.entities.push(usine)
        this.usineStates.push({ ref: usine })
        return usine
    }

    private addRessource(ressource: Energie | Vie) {
        this.entities.push(ressource)
        this.ressourceStates.push({ ref: ressource })
        return ressource
    }

    private addDrone(usine: Usine, joueur: Joueur) {
        const drone = new Drone()
        drone.position = copyPosition(usine.position)
        drone.usine = usine
        drone.joueur = joueur
        drone.energieCount = 0
        drone.vieCount = 0
        this.entities.push(drone)
        this.droneStates.push({ type: "wait", ref: drone })
        return drone
    }

    populationCount(joueur: Joueur, usine: Usine) {
        return this.drones().filter(drone =>
            drone.joueur === joueur && drone.usine === usine
        ).length
    }

    createRessources(
        w: number,
        h: number,
        createFunction: (pos: Position, energieCount: number, vieCount: number) => boolean
    ) {
        let shouldContinue = true
        let failedAttempts = 0

        while (shouldContinue) {
            const energies = this.energies()
            const vies = this.vies()
            const usines = this.usines()
            const pos = position(Math.random() * w, Math.random() * h)
            const hasEnoughSpace = vies.every(value =>
                dist(pos, value.position) >= this.config.RESSOURCE_DISTANCE_MIN
            ) && energies.every(value =>
                dist(pos, value.position) >= this.config.RESSOURCE_DISTANCE_MIN
            ) && usines.every(value =>
                dist(pos, value.position) >= this.config.RESSOURCE_DISTANCE_MIN
            )

            if (hasEnoughSpace) {
                shouldContinue = createFunction(pos, energies.length, vies.length)
                failedAttempts = 0
            } else {
                failedAttempts++
                if (failedAttempts >= MAX_PLACEMENT_ATTEMPTS) {
                    throw new Error(
                        `Impossible de placer les ressources dans un monde de ${w} x ${h}`
                    )
                }
            }
        }
    }

    createWorld(w: number, h: number) {
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
            throw new RangeError("La largeur et la hauteur du monde doivent être positives")
        }

        this.entities.length = 0
        this.totalUsinePopulation = undefined
        this.droneStates = []
        this.usineStates = []
        this.ressourceStates = []
        this.joueurA = new Joueur()
        this.joueurB = new Joueur()
        this.dataLogA = undefined
        this.dataLogB = undefined
        this.resetCombat()

        let failedAttempts = 0
        while (this.usineStates.length < this.config.USINE_COUNT) {
            const pos = position(Math.random() * w, Math.random() * h)
            const hasEnoughSpace = this.usines().every(usine =>
                dist(pos, usine.position) >= this.config.USINE_DISTANCE_MIN
            )

            if (hasEnoughSpace) {
                const technologie = POUVOIRS[Math.trunc(Math.random() * POUVOIRS.length)]
                this.addUsine(pos, technologie)
                failedAttempts = 0
            } else {
                failedAttempts++
                if (failedAttempts >= MAX_PLACEMENT_ATTEMPTS) {
                    throw new Error(
                        `Impossible de placer ${this.config.USINE_COUNT} usines dans un monde de ${w} x ${h}`
                    )
                }
            }
        }

        this.createRessources(w, h, (pos, energieCount) => {
            const energie = new Energie()
            energie.position = pos
            this.addRessource(energie)
            return energieCount + 1 < this.config.ENERGIE_COUNT
        })

        this.createRessources(w, h, (pos, _energieCount, vieCount) => {
            const vie = new Vie()
            vie.position = pos
            this.addRessource(vie)
            return vieCount + 1 < this.config.VIE_COUNT
        })

        const usines = this.usines()
        let usineJoueurA = usines[0]
        let usineJoueurB = usines[1]
        let distanceMax = dist(usineJoueurA.position, usineJoueurB.position)

        for (let i = 0; i < usines.length; i++) {
            for (let j = i + 1; j < usines.length; j++) {
                const distance = dist(usines[i].position, usines[j].position)
                if (distance > distanceMax) {
                    distanceMax = distance
                    usineJoueurA = usines[i]
                    usineJoueurB = usines[j]
                }
            }
        }

        usineJoueurA.etat = usineEtat(this.joueurA, this.buildTime(this.joueurA))
        usineJoueurB.etat = usineEtat(this.joueurB, this.buildTime(this.joueurB))
        return this.entities
    }

    isTechnologyEnabled(technologie: Technologie) {
        const technologyIndex = POUVOIRS.indexOf(technologie)
        const enabledCount = Math.max(0, Math.min(
            POUVOIRS.length,
            Math.trunc(this.config.POUVOIR_COUNT)
        ))
        return technologyIndex >= 0 && technologyIndex < enabledCount
    }

    private ownedTechnologyCount(joueur: Joueur, technologie: Technologie) {
        if (!this.isTechnologyEnabled(technologie)) return 0
        return this.usines().filter(usine =>
            usine.technologie === technologie && usine.etat?.joueur === joueur
        ).length
    }

    getDronePopulation(joueur: Joueur) {
        return this.ownedTechnologyCount(joueur, "Population") * this.config.POPULATION_FACTOR + 5
    }
    buildTime(joueur: Joueur) {
        return (this.getTotalUsinePopulation() - this.ownedTechnologyCount(joueur, "Population") + 1) * this.config.BUILD_FACTOR
    }

    getDroneSpeed(joueur: Joueur) {
        return (this.ownedTechnologyCount(joueur, "Vitesse")) * this.config.DRONE_SPEED_FACTOR + this.config.DRONE_SPEED
    }

    getDroneRange(joueur: Joueur) {
        return (this.ownedTechnologyCount(joueur, "Porte")) * this.config.DRONE_RANGE_FACTOR + this.config.DRONE_RANGE
    }

    getDronePower(joueur: Joueur) {
        return this.ownedTechnologyCount(joueur, "Puissance") + 1
    }

    getDroneTransport(joueur: Joueur) {
        return this.ownedTechnologyCount(joueur, "Transport") + this.config.TRANSPORT_COUNT
    }


    initDroneState(
        joueur: Joueur,
        droneRef: string,
        targetRef: string,
        replaceCurrentOrder = false
    ) {
        if (this.combatResult) {
            return false
        }
        const drone = this.drones().find((d) => d.id === droneRef)
        if (!drone) {
            return false
        }
        const target = this.entities.find((e) => e.id === targetRef)
        if (!target) {
            return false
        }
        const idx = this.droneStates.findIndex(state => state.ref === drone)
        if (idx === -1 || !this.entities.includes(target)) {
            return false
        }
        const currentState = this.droneStates[idx]
        if (drone.joueur !== joueur || (target instanceof Drone && target.joueur === joueur)) {
            return false
        }
        const actionInProgress = (drone.cible?.fireTime ?? 0) > 0
        const canReplaceMovement = replaceCurrentOrder
            && currentState.type === "move"
            && !actionInProgress
        if ((currentState.type !== "wait" && !canReplaceMovement) || actionInProgress) {
            return false
        }

        const p = target.position
        const q = drone.position
        const dx = p.x - q.x
        const dy = p.y - q.y
        const centreDistance = Math.sqrt(dx * dx + dy * dy)
        const distance = Math.max(0, centreDistance - this.getDroneRange(joueur))
        const speed = this.getDroneSpeed(joueur)
        const ratio = centreDistance === 0 ? 0 : speed / centreDistance

        const cible: DroneTarget = {
            cible: target,
            fireTime: 0

        }
        drone.cible = cible
        if (drone.usine.etat?.newDrone === drone) {
            drone.usine.etat.newDrone = undefined
        }

        const destinationRatio = centreDistance === 0 ? 0 : distance / centreDistance
        this.droneStates[idx] = {
            type: "move",
            ref: drone,
            refTarget: target,
            distance,
            sx: ratio * dx,
            sy: ratio * dy,
            dep: speed,
            target: position(q.x + destinationRatio * dx, q.y + destinationRatio * dy)
        }
        return true
    }

    private startCooldown(drone: Drone, target: Target) {
        const cible: DroneTarget = {
            cible: target,
            fireTime: this.config.FIRE_TIME
        }
        drone.cible = cible
    }

    private releaseOwnedResources(owner: Drone | Usine) {
        for (const state of this.ressourceStates) {
            if (state.ref.proprietaire === owner) {
                state.ref.proprietaire = undefined
            }
        }
    }

    private removeDrone(drone: Drone) {
        this.releaseOwnedResources(drone)
        const entityIndex = this.entities.indexOf(drone)
        if (entityIndex !== -1) {
            this.entities.splice(entityIndex, 1)
        }
        this.droneStates = this.droneStates.filter(state => state.ref !== drone)

        if (drone.usine.etat?.joueur === drone.joueur) {
            drone.usine.etat.populationCount = Math.max(
                0,
                drone.usine.etat.populationCount - 1
            )
        }
    }

    private fireRessource(ds: DroneMoveState, target: Energie | Vie): DroneState {
        const drone = ds.ref
        if (drone.energieCount + drone.vieCount >= this.getDroneTransport(drone.joueur)) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }
        if (target.proprietaire) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        target.proprietaire = drone
        if (target instanceof Energie) {
            drone.energieCount++
        } else {
            drone.vieCount++
        }
        this.startCooldown(drone, target)
        return ds
    }

    private fireDrone(ds: DroneMoveState, target: Drone): DroneState {
        const drone = ds.ref
        if (target.joueur === drone.joueur) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        const energie = this.energies().find(value => value.proprietaire === drone)
        if (!energie) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        energie.proprietaire = undefined
        drone.energieCount = Math.max(0, drone.energieCount - 1)

        let puissance = this.getDronePower(drone.joueur)
        for (const vie of this.vies()) {
            if (puissance === 0) break
            if (vie.proprietaire === target) {
                vie.proprietaire = undefined
                target.vieCount = Math.max(0, target.vieCount - 1)
                puissance--
            }
        }

        this.startCooldown(drone, target)
        if (target.vieCount <= 0) {
            this.removeDrone(target)
        }
        return ds
    }


    private transferLifeToUsine(drone: Drone, usine: Usine, limit: number) {
        let transferred = 0
        for (const vie of this.vies()) {
            if (transferred === limit) break
            if (vie.proprietaire === drone) {
                vie.proprietaire = usine
                drone.vieCount = Math.max(0, drone.vieCount - 1)
                transferred++
            }
        }
        return transferred
    }
    private fireUsine(ds: DroneMoveState, target: Usine): DroneState {
        const drone = ds.ref
        const puissance = this.getDronePower(drone.joueur)

        if (!target.etat || target.etat.joueur === drone.joueur) {
            const lifeCount = this.transferLifeToUsine(drone, target, puissance)
            if (lifeCount > 0) {
                if (target.etat) {
                    target.etat.vieCount += lifeCount
                } else {
                    target.etat = usineEtat(
                        drone.joueur,
                        this.buildTime(drone.joueur),
                        lifeCount,
                        this.populationCount(drone.joueur, target)
                    )
                }
                this.startCooldown(drone, target)
                return ds
            }

            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        let removed = 0
        const droneEnergies = this.energies().filter((e) => e.proprietaire === drone)
        for (const vie of this.vies()) {
            if (droneEnergies.length === 0 || removed === puissance) break

            if (vie.proprietaire === target) {
                const de = droneEnergies.pop()
                if (de) {
                    de.proprietaire = undefined
                    drone.energieCount = Math.max(0, drone.energieCount - 1)
                }
                vie.proprietaire = undefined
                removed++
            }
        }

        const remaining = this.vies().filter(value => value.proprietaire === target).length

        if (remaining === 0) {
            target.etat = usineEtat(
                drone.joueur,
                this.buildTime(drone.joueur),
                0,
                this.populationCount(drone.joueur, target)
            )
        } else {
            target.etat.vieCount = remaining
        }

        if (removed > 0 || remaining === 0) {
            this.startCooldown(drone, target)
            return ds
        }

        drone.cible = undefined
        return { type: "wait", ref: drone }
    }

    fire(ds: DroneMoveState): DroneState {
        const drone = ds.ref
        const target = ds.refTarget
        if (!this.entities.includes(target)) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        // Le point d'arrivée est calculé exactement sur la limite de portée.
        // Les arrondis flottants peuvent toutefois produire 10.0000000000001
        // pour une portée de 10 et faire abandonner une collecte valide.
        if (
            dist(target.position, drone.position) >
            this.getDroneRange(drone.joueur) + INTERACTION_DISTANCE_EPSILON
        ) {
            drone.cible = undefined
            return { type: "wait", ref: drone }
        }

        if (target instanceof Energie || target instanceof Vie) {
            return this.fireRessource(ds, target)
        }
        if (target instanceof Drone) {
            return this.fireDrone(ds, target)
        }
        return this.fireUsine(ds, target)
    }

    processUsine(usineState: UsineState) {
        const usine = usineState.ref
        if (!usine.etat || usine.etat.newDrone) {
            return
        }

        if (usine.etat.time <= 0) {
            if (usine.etat.populationCount < this.getDronePopulation(usine.etat.joueur)) {
                usine.etat.newDrone = this.addDrone(usine, usine.etat.joueur)
                usine.etat.populationCount++
            }
            usine.etat.time = this.buildTime(usine.etat.joueur)
            return
        }

        usine.etat.time--
    }

    processUsines() {
        for (const state of this.usineStates) {
            this.processUsine(state)
        }
    }

    processDrone(droneState: DroneState): DroneState {
        const drone = droneState.ref
        if (droneState.type === "wait") {
            return droneState
        }

        if (drone.cible && drone.cible.fireTime > 0) {
            drone.cible.fireTime--
            if (drone.cible.fireTime <= 0) {
                drone.cible = undefined
                return { type: "wait", ref: drone }
            }
            return droneState
        }

        droneState.distance -= droneState.dep
        if (droneState.distance <= 0) {
            drone.position = copyPosition(droneState.target)
            return this.fire(droneState)
        }

        drone.position.x += droneState.sx
        drone.position.y += droneState.sy
        if (droneState.refTarget instanceof Drone) {
            if (dist(droneState.target, droneState.refTarget.position) > this.getDroneRange(drone.joueur)) {
                if (this.initDroneState(drone.joueur, droneState.ref.id, droneState.refTarget.id, true)) {
                    const idx = this.droneStates.findIndex(state => state.ref === drone)
                    if (idx === -1 || !this.entities.includes(droneState.refTarget)) {
                        return droneState
                    }
                    console.log("reinit target")
                    return this.droneStates[idx]
                }
            }
        }
        return droneState
    }

    processDrones() {
        const drones = new Set(this.drones())
        const currentStates = this.droneStates.filter(state => drones.has(state.ref))
        const nextStates: DroneState[] = []

        for (const state of currentStates) {
            const nextState = this.processDrone(state)
            if (this.entities.includes(nextState.ref)) {
                nextStates.push(nextState)
            }
        }

        this.droneStates = nextStates.filter(state =>
            this.entities.includes(state.ref)
        )
    }

    private finishCombat(
        reason: CombatEndReason,
        winner: Joueur | undefined,
        loser: Joueur | undefined,
        droneCountA: number,
        droneCountB: number
    ) {
        this.combatResult = {
            reason,
            winner,
            loser,
            draw: !winner,
            tick: this.combatTick,
            droneCountA,
            droneCountB
        }
        return this.combatResult
    }

    private evaluateCombat() {
        const drones = this.drones()
        const usines = this.usines()
        const droneCountA = drones.filter(drone => drone.joueur === this.joueurA).length
        const droneCountB = drones.filter(drone => drone.joueur === this.joueurB).length
        const usineCountA = usines.filter(usine => usine.etat?.joueur === this.joueurA).length
        const usineCountB = usines.filter(usine => usine.etat?.joueur === this.joueurB).length
        const eliminatedA = usineCountA === 0 //&& droneCountA ===0
        const eliminatedB = usineCountB === 0 //&& droneCountB ===0

        if (eliminatedA || eliminatedB) {
            if (eliminatedA && eliminatedB) {
                return this.finishCombat("elimination", undefined, undefined, droneCountA, droneCountB)
            }
            return this.finishCombat(
                "elimination",
                eliminatedA ? this.joueurB : this.joueurA,
                eliminatedA ? this.joueurA : this.joueurB,
                droneCountA,
                droneCountB
            )
        }

        if (this.combatTick >= this.config.COMBAT_TIME) {
            if (droneCountA === droneCountB) {
                return this.finishCombat("time", undefined, undefined, droneCountA, droneCountB)
            }
            return this.finishCombat(
                "time",
                droneCountA > droneCountB ? this.joueurA : this.joueurB,
                droneCountA > droneCountB ? this.joueurB : this.joueurA,
                droneCountA,
                droneCountB
            )
        }

        return undefined
    }
    private stepCallback?: (result: CombatResult | undefined) => void
    private stepJoueurCount = 0
    private pendingStep?: Promise<CombatResult | undefined>

    async step(): Promise<CombatResult | undefined> {
        if (this.combatResult) {
            return this.combatResult
        }
        if (this.pendingStep) {
            return this.pendingStep
        }

        this.processDrones()
        this.processUsines()
        this.combatTick++

        const result = this.evaluateCombat()
        if (result) {
            return result
        }

        this.stepJoueurCount = Number(Boolean(this.workerA)) + Number(Boolean(this.workerB))
        if (this.stepJoueurCount === 0) {
            return undefined
        }

        const stepPromise = new Promise<CombatResult | undefined>(resolve => {
            this.stepCallback = resolve
        })
        this.pendingStep = stepPromise

        if (this.workerA) {

            const monde: Monde = new Monde()
            monde.joueur = this.joueurA
            monde.entities = this.entities
            monde.config = this.config

            this.workerA.postMessage(entityToJsonData(monde))
        }

        if (this.workerB) {
            const mondeB: Monde = new Monde()
            mondeB.entities = this.entities
            mondeB.joueur = this.joueurB
            mondeB.config = this.config

            this.workerB.postMessage(entityToJsonData(mondeB))

        }
        try {
            return await stepPromise
        } finally {
            if (this.pendingStep === stepPromise) {
                this.pendingStep = undefined
                this.stepCallback = undefined
            }
        }
    }

    async stepTimes(n: number) {
        while (n > 0 && !this.combatResult) {
            n--;
            await this.step()
        }
        return this.combatResult
    }
    setWorkerA(workerA: Worker) {
        this.dataLogA = undefined
        this.workerA = workerA
        this.setWorker(workerA, this.joueurA)

    }
    setWorker(worker: Worker, joueur: Joueur) {
        worker.addEventListener("message", (event: MessageEvent<SetTargetRef | BotState | BotTurnComplete>) => {
            const setTargetRef = event.data
            if (setTargetRef.type === "botTurnComplete") {
                if (this.stepJoueurCount <= 0) return
                this.stepJoueurCount--
                if (this.stepJoueurCount === 0) {
                    this.stepCallback?.(undefined)
                }
                return
            }
            if (setTargetRef.type === "botState") {
                if (this.joueurA === joueur) {
                    this.dataLogA = setTargetRef
                }
                if (this.joueurB === joueur) {
                    this.dataLogB = setTargetRef
                }
                return
            }
            this.initDroneState(joueur, setTargetRef.mobileRef, setTargetRef.targetRef)
        })
    }
    setWorkerB(workerB: Worker) {
        this.dataLogB = undefined
        this.workerB = workerB
        this.setWorker(workerB, this.joueurB)
    }
}
