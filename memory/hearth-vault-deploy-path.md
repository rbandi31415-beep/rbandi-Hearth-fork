---
name: hearth-vault-deploy-path
description: Where to copy Hearth build output so the user's live Obsidian vault picks it up
metadata:
  type: project
---

The user runs this fork ("rbandi-hearth") in a real vault. To deploy a build, run `npm run build` then copy `main.js`, `manifest.json`, `styles.css` to:

`C:\Users\rohith.bandi\Documents\codingautomationsTCM-BRI\the-second-brain\the expanding\.obsidian\plugins\rbandi-hearth\`

That vault uses TaskNotes (tag `task`, default field mapping, `scheduled` carries a time component) and people notes tagged `person` under `People/Persons/`. After copying, the user must reload the plugin in Obsidian (toggle off/on, or Reload app). Do this only when the user asks to update the vault.
