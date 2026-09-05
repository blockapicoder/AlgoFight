import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1450,
        Puissance: 1020,
        Vitesse: 1380,
        Porte: 820,
        Transport: 620
    },
    expansionLimit: 7,
    minimumFactoryLife: 3,
    desiredDroneLife: 1,
    desiredAttackEnergy: 3,
    expansionShare: 45,
    guardShare: 16,
    assaultShare: 27,
    factoryAggression: 0.72,
    droneAggression: 0.4,
    defenseRadius: 220,
    protectBeforeExpansion: false
})
