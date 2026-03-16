# Plan: @ for Context, / for Commands

Quick reference for using Cursor effectively.

---

## @ for context

Use **@** in the chat/composer to attach context so the AI knows what to use.

| Mention | Purpose |
|--------|--------|
| `@filename` | Attach a specific file (e.g. `@src/App.tsx`) |
| `@folder/` | Attach a folder so the AI can search/read inside it |
| `@Codebase` | Search and reference the whole codebase |
| `@Docs` | Use official docs (when available) |
| `@Web` | Search the web for up-to-date info |
| `@Git` | Reference git state (branches, diff, etc.) |

**Tips:**
- Add @ before typing to get suggestions.
- Combine: e.g. `@utils/ @src/App.tsx` to focus on utils + one file.
- For “plan with context”: start with `@project/` or `@README.md` then ask for the plan.

---

## / for commands

Use **/** in the chat to run built-in or custom commands.

| Command | Purpose |
|---------|--------|
| `/edit` | Apply edits in the editor (inline or multi-file) |
| `/fix` | Fix errors/lints in current file or selection |
| `/doc` | Add or improve documentation |
| `/test` | Generate or run tests |
| `/commit` | Generate a commit message from staged changes |
| Custom rules | Project-specific `/` commands from `.cursor/rules` |

**Tips:**
- Type `/` in chat to see the list of available commands.
- Commands can be extended via Cursor rules (e.g. `/plan`, `/refactor`).

---

## Suggested workflow

1. **Plan with context**  
   `@<repo-or-folder> Plan the feature X` or `@README.md @docs/ Plan next steps`.

2. **Implement with scope**  
   `@src/ @tests/ Add feature Y` then use `/edit` or natural language.

3. **Fix and polish**  
   Select code or file → `/fix` or “fix the linter errors in @this file”.

4. **Document and ship**  
   `/doc` for docs, `/commit` for commit message.

---

## Next steps (optional)

- [ ] Add a `.cursor/rules` file with project-specific @ and / conventions.
- [ ] Create a custom `/plan` command that always pulls in `@README.md` and `@docs/`.
- [ ] Document your preferred @ combos (e.g. “always @utils/ when changing API”).
