import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1250,
        Puissance: 1180,
        Vitesse: 880,
        Porte: 680,
        Transport: 520
    },
    expansionLimit: 3,
    minimumFactoryLife: 2,
    desiredDroneLife: 1,
    desiredAttackEnergy: 4,
    expansionShare: 24,
    guardShare: 12,
    assaultShare: 54,
    factoryAggression: 1,
    droneAggression: 0.55,
    defenseRadius: 190,
    protectBeforeExpansion: false
})
