# Unversioned BOT.md compatibility contract

Omitting `format` is supported authoring syntax, not an error or a migration request. The parser normalizes it to the current internal `format: 2`. Explicit unsupported values, including null and the string `"2"`, remain invalid. Other required metadata is unchanged.

## Static checks

- `bot-format-optional-guard`: `parseDefinition` must retain the absence-aware version guard. Replacing it with an unconditional `format !== 2` check fails.
- `bot-no-required-format-check`: rejects additional format-presence gates in parser `if` conditions, including property access, bracket access, `in` and `Object.hasOwn`. This catches a required-field gate even when the supported guard is still present.

These deliberately constrain the parser's validation shape. If refactoring it, update the rules and fixtures while preserving the behavior tests; do not disable checks to make a regression pass. AST rules cannot prove arbitrary program behavior. `test/unversioned.test.ts` independently covers parsing, explicit invalid values, SDK/CLI validation, Pi catalog listing/editing, execution, reload and durable reopen without a format field.

Run `npm run check:ast` from the runtime package with `ast-grep` on PATH (not Unix `sg`). It scans production source and runs positive/negative rule fixtures. Both normal `npm run check` and `npm test` include it; Nix supplies the tool to development and package checks. No global installation is required.
