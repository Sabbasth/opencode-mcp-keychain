import { lookup } from "./keychain.ts"
import { createPlugin } from "./plugin.ts"

// Only type imports from @opencode/plugin: the plugin has no runtime dependency,
// so it loads from a local directory without installing anything.
export default createPlugin({ lookup })
