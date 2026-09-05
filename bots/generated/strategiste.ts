import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1120,
        Puissance: 1040,
        Vitesse: 900,
        Porte: 980,
        Transport: 660
    },
    expansionLimit: 5,
    minimumFactoryLife: 5,
    desiredDroneLife: 2,
    desiredAttackEnergy: 2,
    expansionShare: 30,
    guardShare: 34,
    assaultShare: 21,
    factoryAggression: 0.62,
    droneAggression: 0.72,
    defenseRadius: 300,
    protectBeforeExpansion: true
})
