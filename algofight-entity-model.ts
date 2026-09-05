import { Entity, JsonDatatoEntity } from "./entity-model"

export const USINE_COUNT = 20
export const VIE_COUNT = 100
export const ENERGIE_COUNT = 100
export const USINE_DISTANCE_MIN = 100
export const RESSOURCE_DISTANCE_MIN = 35
export const FIRE_TIME = 100
export const BUILD_TIME = 250
export const BUILD_FACTOR = 25
export const TRANSPORT_COUNT = 10
export const DRONE_RANGE = 50
export const DRONE_FACTOR = 10
export const COMBAT_TIME = 18_000
export const DRONE_SPEED = 2
export const DRONE_SPEED_FACTOR = 1
export const POUVOIR_COUNT = 5
export const POPULATION_FACTOR = 2

export interface Config {
    USINE_COUNT: number
    VIE_COUNT: number
    ENERGIE_COUNT: number
    USINE_DISTANCE_MIN: number
    RESSOURCE_DISTANCE_MIN: number
    FIRE_TIME: number
    BUILD_TIME: number
    TRANSPORT_COUNT: number
    DRONE_RANGE: number
    DRONE_SPEED: number
    DRONE_SPEED_FACTOR: number
    DRONE_RANGE_FACTOR: number
    COMBAT_TIME: number
    /** Nombre de technologies actives, dans l’ordre Population → Puissance. */
    POUVOIR_COUNT: number,
    POPULATION_FACTOR:number,
    BUILD_FACTOR:number
}

export const DEFAULT_CONFIG: Config = {
    USINE_COUNT,
    VIE_COUNT,
    ENERGIE_COUNT,
    USINE_DISTANCE_MIN,
    RESSOURCE_DISTANCE_MIN,
    FIRE_TIME,
    BUILD_TIME,
    TRANSPORT_COUNT,
    DRONE_RANGE,
    COMBAT_TIME,
    DRONE_RANGE_FACTOR: DRONE_FACTOR,
    DRONE_SPEED,
    DRONE_SPEED_FACTOR,
    POUVOIR_COUNT,
    POPULATION_FACTOR,
    BUILD_FACTOR
}

export interface Position {
    x: number
    y: number
}
export abstract class Element extends Entity {
    position!: Position
}
export abstract class Ressource extends Element {

}

export class Energie extends Ressource {
    proprietaire?: Drone
}

export class Vie extends Ressource {
    proprietaire?: Drone | Usine
}

export class Joueur extends Entity {
}

export class Drone extends Element {

    usine!: Usine
    cible?: Target
    joueur!: Joueur
    energieCount!: number
    vieCount!: number
}

export type Technologie =
    | "Population"
    | "Vitesse"
    | "Porte"
    | "Transport"
    | "Puissance"

export class Usine extends Element {

    etat?: UsineEtat
    technologie!: Technologie
}

export interface Target {
    cible: Drone | Usine | Ressource | Position
    fireTime: number
}

export interface UsineEtat {
    joueur: Joueur
    time: number
    vieCount: number
    newDrone?: Drone
    populationCount: number
}

export interface SetTargetRef {
    type:"setTargetRef"
    mobileRef: string
    targetRef: string
}

/** Accusé envoyé après tous les ordres produits par le bot pour ce tour. */
export interface BotTurnComplete {
    type: "botTurnComplete"
}

export interface Log {
    type: "botState",
    values: { [name: string]: string|number }
} 

export class Monde extends Entity {
    entities: Element[] = []
    joueur!: Joueur
    /** Règles actives de la partie, utilisables par les scripts de bots. */
    config!: Config
}
export class Sauvegarde extends Entity {
    entities: Element[] = []
    joueurA!: Joueur
    joueurB!: Joueur
}

export function setTarget(mobile: Drone, target: Drone | Usine | Ressource) {
    const setTargetRef: SetTargetRef = {
        type:"setTargetRef",
        mobileRef: mobile.id,
        targetRef: target.id
    }
    self.postMessage(setTargetRef)
}
export function setLog( log:Log) {
      self.postMessage(log)
}

export function start(callback: (monde: Monde) => void) {
    self.onmessage = (event: MessageEvent) => {
        const monde: Monde = JsonDatatoEntity(
            event.data,
            [Vie, Energie, Drone, Usine, Joueur, Monde]
        )
        try {
            callback(monde)
        } finally {
            const completed: BotTurnComplete = { type: "botTurnComplete" }
            self.postMessage(completed)
        }

    }
}
