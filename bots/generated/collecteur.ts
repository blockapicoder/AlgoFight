import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1050,
        Puissance: 760,
        Vitesse: 900,
        Porte: 720,
        Transport: 980
    },
    expansionLimit: 8,
    minimumFactoryLife: 5,
    desiredDroneLife: 2,
    desiredAttackEnergy: 1,
    expansionShare: 55,
    guardShare: 15,
    assaultShare: 10,
    factoryAggression: 0.35,
    droneAggression: 0.2,
    defenseRadius: 260,
    protectBeforeExpansion: false
})
