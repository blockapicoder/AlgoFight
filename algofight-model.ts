import * as schema from "./node_modules/tauri-kargo-tools/src/schema/base"
export const model = schema.createModel({
    Energie: {
        type: { union: ["Energie"] },
        position: { struct: "Position" },
        proprietaire: { optional: { ref: ["Drone", "Usine"] } }
    },
    Vie: {
        type: { union: ["Vie"] },
        position: { struct: "Position" },
        proprietaire: { optional: { ref: ["Drone"] } }
    },
    Drone: {
        type: { union: ["Drone"] },
        position: { struct: "Position" },
        usine: { ref: ["Usine"] },
        cible: { optional: { struct: "Target" } },
        joueur: { ref: ["Joueur"] },
        energieCount: "number",
        vieCount: "number"
    },
    Usine: {
        type: { union: ["Usine"] },
        position: { struct: "Position" },
        etat: { optional: { struct: "UsineEtat" } },
        technologie: { union: ["Population", "Vitesse", "Porte", "Transport", "Puissance"] }
    },
    Target: {
        cible: { ref: ["Drone", "Usine", "Energie", "Position", "Vie"] },
        fireTime: "number"
    },
    UsineEtat: {
        joueur: { ref: ["Joueur"] },
        time: "number",
        energieCount: "number",
        newDrone: { optional: { ref: ["Drone"] } },
        populationCount: "number"

    },
    Position: {

        x: "number",
        y: "number"
    },
    Joueur: {
        type: { union: ["Joueur"] },
    }

} as const, {
    setTarget: {
        mobile: { ref: ["Drone"] },
        target: { ref: ["Drone", "Energie", "Usine", "Vie"] }
    }
} as const);