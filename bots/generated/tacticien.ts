import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1240,
        Puissance: 1100,
        Vitesse: 1020,
        Porte: 760,
        Transport: 600
    },
    expansionLimit: 4,
    minimumFactoryLife: 3,
    desiredDroneLife: 1,
    desiredAttackEnergy: 3,
    expansionShare: 32,
    guardShare: 23,
    assaultShare: 32,
    factoryAggression: 0.8,
    droneAggression: 0.65,
    defenseRadius: 235,
    protectBeforeExpansion: false
})
