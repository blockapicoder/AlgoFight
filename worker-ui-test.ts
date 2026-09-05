import { defineVue } from "./node_modules/tauri-kargo-tools/src/vue"
import { runWorker } from "./worker-management"

export class WorkerTest {
    sortie = "Wait ..."
    worker?: Worker
    run() {
        if (this.worker) {
            this.worker.terminate()
        }
        this.worker = runWorker("debugger; self.onmessage = (e) => self.postMessage('Echo'+e.data); ")
        this.worker.onmessage = (e) => {
            this.sortie = e.data
        }
        this.worker.postMessage("Ok")

    }
}

defineVue(WorkerTest, (vue) => {
    vue.flow({ orientation: "row" }, () => {
        vue.staticButton({ action: "run", label: "Run" })
        vue.label("sortie")
    })
})

