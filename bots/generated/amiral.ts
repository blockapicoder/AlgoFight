import { runBot } from "./lib/strategy-core"

runBot({
    technologyValue: {
        Population: 1300,
        Puissance: 1260,
        Vitesse: 1080,
        Porte: 880,
        Transport: 740
    },
    expansionLimit: 5,
    minimumFactoryLife: 4,
    desiredDroneLife: 2,
    desiredAttackEnergy: 4,
    expansionShare: 30,
    guardShare: 25,
    assaultShare: 34,
    factoryAggression: 0.92,
    droneAggression: 0.82,
    defenseRadius: 270,
    protectBeforeExpansion: false
})
