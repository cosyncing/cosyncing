---
name: cosyncing
description: "Interact with the user's cosyncing app: deliver generated files and artifacts to the user's phone or browser."
---

This skill covers interactions with the user's cosyncing app.

## Send a file to the user

To deliver a file to the user's cosyncing app, write or copy the finished file into:

`<cwd>/.cosyncing/outbox/`

cosyncing watches that directory and surfaces files automatically in the app. Keep the original filename when possible, and place only the final user-facing artifact there.

If the repository's `.gitignore` does not cover `.cosyncing/`, suggest the user add it so delivered files stay out of version control.
