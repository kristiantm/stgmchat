# Adventure Director for SillyTavern

A private left-hand GM/director console for role-play sessions.

## Features

- Collapsible, resizable **left-side panel**.
- Uses SillyTavern's **currently selected API/model and current generation settings** via `generateQuietPrompt()`.
- GM / Director mode, Narrator mode, or private consultation as any available character.
- Private GM history stored **per SillyTavern chat** in chat metadata.
- One-click **Clear GM history**. This does not touch the adventure transcript or other RP data.
- Separate editable GM system prompt.
- `Edit setup` tab for AI-assisted rewriting of:
  - Author's Note
  - Persona description
  - Character Description
  - Personality
  - Scenario
  - Character system prompt
  - Post-history instructions
  - First message
  - Example dialogue
- All rewrites use a **preview -> confirm -> apply** workflow. Nothing is silently overwritten.

## Install

### Easy / Git installation

SillyTavern normally installs third-party extensions from a Git repository URL. Put these files in a Git repository, then in SillyTavern go to:

**Extensions -> Install Extension -> paste the repository URL**

### Manual installation

Copy the `ST-Adventure-Director` folder to:

```text
SillyTavern/public/scripts/extensions/third-party/ST-Adventure-Director/
```

Then reload SillyTavern and enable **Adventure Director** in Extensions.

## Usage

Click the 🎬 button on the left side of the screen.

The GM console's messages are private and do not become adventure messages. The console does, however, use `generateQuietPrompt()`, which means the generation sees SillyTavern's current role-play context and uses the same currently active model/API configuration.

### Character mode

Use the Mode dropdown to select a character. This adds that character's card fields to the private consultation instruction and asks the model to reason from the character's established perspective and knowledge.

### Rewrite a prompt or character field

1. Open **Edit setup**.
2. Select a target and field.
3. Describe your desired change (Enter sends, Shift+Enter adds a new line).
4. Click **Ask Director to rewrite**.
5. Review the proposal: tweak it in **Edit**, or switch to **Diff** to see what changed.
6. Click **Apply**, **Copy**, or **Discard**.

Character writes are intentionally limited to the character currently selected in the main SillyTavern UI. This avoids accidentally modifying another card. Open the selected character's editor before applying; the extension uses SillyTavern's native editor controls so normal save/change handling remains in charge.

## Design notes

The extension deliberately avoids a second model configuration. `generateQuietPrompt()` uses SillyTavern's active model/backend/settings, and also generates in the current chat context. The extra GM system instruction is supplied only to the private request.

Third-party SillyTavern extensions run with browser-level access. Review code before installing extensions from sources you do not trust.

## Version

0.1.0 — initial functional prototype for modern SillyTavern releases (tested against the documented 2026 extension API shape).
