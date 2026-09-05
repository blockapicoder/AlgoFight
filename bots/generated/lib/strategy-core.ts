import {
    Drone,
    Energie,
    Element,
    Monde,
    setTarget,
    start,
    Technologie,
    Usine,
    Vie
} from "../../../algofight-entity-model"

type Role = "expansion" | "garde" | "assaut" | "logistique"
type BotTarget = Drone | Energie | Usine | Vie

export interface StrategyProfile {
    technologyValue: Record<Technologie, number>
    expansionLimit: number
    minimumFactoryLife: number
    desiredDroneLife: number
    desiredAttackEnergy: number
    expansionShare: number
    guardShare: number
    assaultShare: number
    factoryAggression: number
    droneAggression: number
    defenseRadius: number
    protectBeforeExpansion: boolean
}

const BASE_TRANSPORT = 10
const TECHNOLOGY_ORDER: readonly Technologie[] = [
    "Population",
    "Vitesse",
    "Porte",
    "Transport",
    "Puissance"
]

function technologyEnabled(world: Monde, technology: Technologie) {
    const configuredCount = world.config?.POUVOIR_COUNT
    if (!Number.isFinite(configuredCount)) return true
    const enabledCount = Math.max(0, Math.min(
        TECHNOLOGY_ORDER.length,
        Math.trunc(configuredCount)
    ))
    return TECHNOLOGY_ORDER.indexOf(technology) < enabledCount
}

function distance(a: Element, b: Element) {
    return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
}

function stableNumber(id: string) {
    let value = 2166136261
    for (let index = 0; index < id.length; index++) {
        value ^= id.charCodeAt(index)
        value = Math.imul(value, 16777619)
    }
    return value >>> 0
}

function roleOf(drone: Drone, profile: StrategyProfile): Role {
    const value = stableNumber(drone.id) % 100
    if (value < profile.expansionShare) return "expansion"
    if (value < profile.expansionShare + profile.guardShare) return "garde"
    if (value < profile.expansionShare + profile.guardShare + profile.assaultShare) return "assaut"
    return "logistique"
}

function technologyCounts(factories: Usine[]) {
    const counts = new Map<Technologie, number>()
    for (const factory of factories) {
        counts.set(factory.technologie, (counts.get(factory.technologie) ?? 0) + 1)
    }
    return counts
}

function nearest<T extends Element>(drone: Drone, values: T[], reserved: Set<string>) {
    let target: T | undefined
    let bestDistance = Infinity
    for (const value of values) {
        if (reserved.has(value.id)) continue
        const currentDistance = distance(drone, value)
        if (currentDistance < bestDistance) {
            target = value
            bestDistance = currentDistance
        }
    }
    if (target) reserved.add(target.id)
    return target
}

function strategicNeutral(
    drone: Drone,
    factories: Usine[],
    reserved: Set<string>,
    counts: Map<Technologie, number>,
    profile: StrategyProfile,
    world: Monde,
    ownFactoryCount: number
) {
    let target: Usine | undefined
    let bestScore = -Infinity
    for (const factory of factories) {
        if (reserved.has(factory.id)) continue
        const enabled = technologyEnabled(world, factory.technologie)
        const technologyCount = counts.get(factory.technologie) ?? 0
        const scarcityBonus = enabled ? 260 / (technologyCount + 1) : 0
        const populationProductionBonus = enabled && factory.technologie === "Population"
            ? (world.config?.POPULATION_FACTOR ?? 2) * 160
                + (world.config?.BUILD_FACTOR ?? 25) * (8 + ownFactoryCount * 5)
            : 0
        const score = (enabled ? profile.technologyValue[factory.technologie] : 0)
            + scarcityBonus
            + populationProductionBonus
            - distance(drone, factory) * 1.35
        if (score > bestScore) {
            target = factory
            bestScore = score
        }
    }
    if (target) reserved.add(target.id)
    return target
}

function weakestOwnFactory(
    drone: Drone,
    factories: Usine[],
    plannedLife: Map<string, number>,
    maximumLife: number
) {
    let target: Usine | undefined
    let bestScore = Infinity
    for (const factory of factories) {
        const projectedLife = (factory.etat?.vieCount ?? 0) + (plannedLife.get(factory.id) ?? 0)
        if (projectedLife >= maximumLife) continue
        const score = projectedLife * 500 + distance(drone, factory)
        if (score < bestScore) {
            target = factory
            bestScore = score
        }
    }
    return target
}

function isThreat(enemy: Drone, ownFactories: Usine[], radius: number) {
    const orderedTarget = enemy.cible?.cible
    if (
        orderedTarget instanceof Usine
        && ownFactories.some(factory => factory.id === orderedTarget.id)
    ) {
        return true
    }
    return ownFactories.some(factory => distance(enemy, factory) <= radius)
}

function claimEnemyDrone(
    drone: Drone,
    enemies: Drone[],
    attacksRemaining: Map<string, number>,
    ownFactories: Usine[],
    profile: StrategyProfile,
    threatsOnly: boolean
) {
    let target: Drone | undefined
    let bestScore = -Infinity
    for (const enemy of enemies) {
        if ((attacksRemaining.get(enemy.id) ?? 0) <= 0) continue
        const threat = isThreat(enemy, ownFactories, profile.defenseRadius)
        if (threatsOnly && !threat) continue
        const targetFactory = enemy.cible?.cible instanceof Usine ? 1500 : 0
        const threatBonus = threat ? 3000 : 0
        const score = threatBonus + targetFactory + enemy.energieCount * 55
            - enemy.vieCount * 30 - distance(drone, enemy) * 1.5
        if (score > bestScore) {
            target = enemy
            bestScore = score
        }
    }
    if (target) {
        attacksRemaining.set(target.id, (attacksRemaining.get(target.id) ?? 1) - 1)
    }
    return target
}

function claimEnemyFactory(
    drone: Drone,
    factories: Usine[],
    committedDamage: Map<string, number>,
    power: number,
    profile: StrategyProfile,
    world: Monde
) {
    let target: Usine | undefined
    let bestScore = -Infinity
    for (const factory of factories) {
        const life = factory.etat?.vieCount ?? 0
        if (life > 0 && drone.energieCount === 0) continue
        const requiredDamage = Math.max(1, life)
        if ((committedDamage.get(factory.id) ?? 0) >= requiredDamage) continue

        const lastFactoryBonus = factories.length === 1 ? 6000 : 0
        const vulnerabilityBonus = life === 0 ? 5000 : 2600 / (life + 1)
        const enabled = technologyEnabled(world, factory.technologie)
        const technologyBonus = enabled ? profile.technologyValue[factory.technologie] * .35 : 0
        const populationProductionDenial = enabled && factory.technologie === "Population"
            ? (world.config?.BUILD_FACTOR ?? 25) * (6 + factories.length * 3)
            : 0
        const score = lastFactoryBonus + vulnerabilityBonus + technologyBonus
            + populationProductionDenial
            + profile.factoryAggression * 500 - distance(drone, factory) * 1.6
        if (score > bestScore) {
            target = factory
            bestScore = score
        }
    }
    if (target) {
        const life = target.etat?.vieCount ?? 0
        const contribution = life === 0 ? 1 : Math.min(power, drone.energieCount)
        committedDamage.set(
            target.id,
            (committedDamage.get(target.id) ?? 0) + Math.max(1, contribution)
        )
    }
    return target
}

export function runBot(profile: StrategyProfile) {
    start((world: Monde) => {
        const drones = world.entities.filter((entity): entity is Drone => entity instanceof Drone)
        const factories = world.entities.filter((entity): entity is Usine => entity instanceof Usine)
        const freeEnergy = world.entities.filter(
            (entity): entity is Energie => entity instanceof Energie && !entity.proprietaire
        )
        const freeLife = world.entities.filter(
            (entity): entity is Vie => entity instanceof Vie && !entity.proprietaire
        )
        const ownDrones = drones.filter(drone => drone.joueur === world.joueur)
        const readyDrones = ownDrones
            .filter(drone => !drone.cible)
            .sort((a, b) => stableNumber(a.id) - stableNumber(b.id))
        const enemyDrones = drones.filter(drone => drone.joueur !== world.joueur)
        const ownFactories = factories.filter(factory => factory.etat?.joueur === world.joueur)
        const neutralFactories = factories.filter(factory => !factory.etat)
        const enemyFactories = factories.filter(
            factory => Boolean(factory.etat && factory.etat.joueur !== world.joueur)
        )

        // Un pouvoir verrouillé ne doit modifier ni les capacités estimées du
        // bot ni son choix d’usine dans les niveaux à zéro ou peu de pouvoirs.
        const counts = technologyCounts(ownFactories.filter(factory =>
            technologyEnabled(world, factory.technologie)
        ))
        const power = 1 + (counts.get("Puissance") ?? 0)
        const capacity = (world.config?.TRANSPORT_COUNT ?? BASE_TRANSPORT)
            + (counts.get("Transport") ?? 0)
        const reservedResources = new Set<string>()
        const reservedNeutralFactories = new Set<string>()
        const plannedFactoryLife = new Map<string, number>()
        const committedFactoryDamage = new Map<string, number>()
        const attacksRemaining = new Map(
            enemyDrones.map(enemy => [enemy.id, Math.max(1, Math.ceil(Math.max(1, enemy.vieCount) / power))])
        )

        // Les ordres en cours font partie du plan. Un bot ne réserve donc pas deux
        // drones pour une ressource ou une usine déjà couverte par un autre ordre.
        for (const drone of ownDrones) {
            const target = drone.cible?.cible
            if (target instanceof Energie || target instanceof Vie) {
                reservedResources.add(target.id)
                continue
            }
            if (target instanceof Drone && target.joueur !== world.joueur) {
                attacksRemaining.set(target.id, Math.max(0, (attacksRemaining.get(target.id) ?? 1) - 1))
                continue
            }
            if (!(target instanceof Usine)) continue
            if (!target.etat) {
                reservedNeutralFactories.add(target.id)
            } else if (target.etat.joueur === world.joueur && drone.vieCount > 0) {
                plannedFactoryLife.set(
                    target.id,
                    (plannedFactoryLife.get(target.id) ?? 0) + Math.min(power, drone.vieCount)
                )
            } else if (target.etat.joueur !== world.joueur) {
                const life = target.etat.vieCount
                const contribution = life === 0 ? 1 : Math.min(power, drone.energieCount)
                committedFactoryDamage.set(
                    target.id,
                    (committedFactoryDamage.get(target.id) ?? 0) + Math.max(1, contribution)
                )
            }
        }

        const needsSecondFactory = ownFactories.length < 2 && neutralFactories.length > 0
        const threatened = enemyDrones.some(enemy => isThreat(enemy, ownFactories, profile.defenseRadius))
        const expansionWanted = neutralFactories.length > 0
            && ownFactories.length < profile.expansionLimit
        const attacksUnlocked = ownFactories.length >= 2 || neutralFactories.length === 0

        for (const drone of readyDrones) {
            const role = roleOf(drone, profile)
            const cargo = drone.energieCount + drone.vieCount
            const hasEnergy = drone.energieCount > 0
            const hasLife = drone.vieCount > 0
            let target: BotTarget | undefined

            // L'énergie sert exclusivement au combat. La garde intercepte d'abord
            // les drones qui menacent directement les usines du joueur.
            if (hasEnergy && threatened && (role === "garde" || ownFactories.length <= 1)) {
                target = claimEnemyDrone(
                    drone,
                    enemyDrones,
                    attacksRemaining,
                    ownFactories,
                    profile,
                    true
                )
            }

            const weakFactory = weakestOwnFactory(
                drone,
                ownFactories,
                plannedFactoryLife,
                profile.minimumFactoryLife
            )

            // La vie est la seule ressource capable de prendre une usine neutre.
            // La deuxième usine reste prioritaire, sauf pour les profils qui
            // protègent explicitement leur base vide avant de s'étendre.
            if (!target && needsSecondFactory) {
                if (
                    profile.protectBeforeExpansion
                    && hasLife
                    && weakFactory
                    && (weakFactory.etat?.vieCount ?? 0) === 0
                ) {
                    target = weakFactory
                    plannedFactoryLife.set(
                        weakFactory.id,
                        (plannedFactoryLife.get(weakFactory.id) ?? 0) + Math.min(power, drone.vieCount)
                    )
                } else {
                    target = hasLife
                        ? strategicNeutral(
                            drone,
                            neutralFactories,
                            reservedNeutralFactories,
                            counts,
                            profile,
                            world,
                            ownFactories.length
                        )
                        : nearest(drone, freeLife, reservedResources)
                }
            }

            // Une usine alliée est renforcée avec de la vie, jamais avec de
            // l'énergie. Les supports privilégient toujours l'usine la plus faible.
            if (!target && hasLife && weakFactory
                && (role === "logistique" || threatened || !expansionWanted)) {
                target = weakFactory
                plannedFactoryLife.set(
                    weakFactory.id,
                    (plannedFactoryLife.get(weakFactory.id) ?? 0) + Math.min(power, drone.vieCount)
                )
            }

            // Les unités d'expansion emportent une vie vers les meilleures
            // technologies encore neutres.
            if (!target && expansionWanted && (role === "expansion" || ownFactories.length <= 2)) {
                target = hasLife
                    ? strategicNeutral(
                        drone,
                        neutralFactories,
                        reservedNeutralFactories,
                        counts,
                        profile,
                        world,
                        ownFactories.length
                    )
                    : nearest(drone, freeLife, reservedResources)
            }

            // Une usine ennemie perd une vie par énergie consommée, dans la
            // limite de la puissance. Les attaques sont concentrées jusqu'à
            // atteindre exactement la vie actuellement visible de la cible.
            const prefersFactoryAttack = role === "assaut"
                || profile.factoryAggression >= profile.droneAggression
                || enemyFactories.length === 1
            if (!target && attacksUnlocked && prefersFactoryAttack
                && (hasEnergy || enemyFactories.some(factory => (factory.etat?.vieCount ?? 0) === 0))) {
                target = claimEnemyFactory(
                    drone,
                    enemyFactories,
                    committedFactoryDamage,
                    power,
                    profile,
                    world
                )
            }

            // Un drone d'assaut conserve un peu de vie pour ne pas être détruit
            // au premier tir avant d'aller chercher son énergie offensive.
            if (!target && drone.vieCount < profile.desiredDroneLife && cargo < capacity) {
                target = nearest(drone, freeLife, reservedResources)
            }

            if (!target && attacksUnlocked && hasEnergy && role !== "logistique"
                && profile.droneAggression > 0) {
                target = claimEnemyDrone(
                    drone,
                    enemyDrones,
                    attacksRemaining,
                    ownFactories,
                    profile,
                    false
                )
            }

            const desiredEnergy = Math.min(capacity, Math.max(1, profile.desiredAttackEnergy, power))
            if (!target && attacksUnlocked && drone.energieCount < desiredEnergy && cargo < capacity) {
                target = nearest(drone, freeEnergy, reservedResources)
            }

            if (!target && attacksUnlocked) {
                target = claimEnemyFactory(
                    drone,
                    enemyFactories,
                    committedFactoryDamage,
                    power,
                    profile,
                    world
                )
            }

            if (!target && hasLife && weakFactory) {
                target = weakFactory
                plannedFactoryLife.set(
                    weakFactory.id,
                    (plannedFactoryLife.get(weakFactory.id) ?? 0) + Math.min(power, drone.vieCount)
                )
            }

            // Quand toutes les missions sont couvertes, le stock libre est
            // réparti entre vie (défense/conquête) et énergie (offensive).
            if (!target && cargo < capacity) {
                const needsLife = drone.vieCount < profile.desiredDroneLife
                    || ownFactories.some(factory =>
                        (factory.etat?.vieCount ?? 0) < profile.minimumFactoryLife
                    )
                target = needsLife
                    ? nearest(drone, freeLife, reservedResources)
                        ?? nearest(drone, freeEnergy, reservedResources)
                    : nearest(drone, freeEnergy, reservedResources)
                        ?? nearest(drone, freeLife, reservedResources)
            }

            if (!target && hasEnergy) {
                target = claimEnemyDrone(
                    drone,
                    enemyDrones,
                    attacksRemaining,
                    ownFactories,
                    profile,
                    false
                )
            }

            if (target) setTarget(drone, target)
        }
    })
}
