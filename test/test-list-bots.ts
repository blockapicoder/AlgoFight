
import { deleteSource, listBotsScript, readSource, writeSource } from "../bots-script-tools"

import { assertEquals, log } from "../node_modules/tauri-kargo-tools/src/test"


const l = await listBotsScript()
log(JSON.stringify(l))
let src = await readSource("algofight-entity-model.ts")
log(src)
src = await readSource("bots/toto.ts")
await writeSource("bots/test.ts","\n /*commentaire*/")
await deleteSource("bots/test.ts")



