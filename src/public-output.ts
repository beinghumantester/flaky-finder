import type { Diagnostic, PublicDiagnostic } from "./types.js";

// The boundary between the internal extraction model and what the CLI prints. A
// Diagnostic's `text` is text extraction rejected, which nobody checked: it can hold
// an Authorization header, a connection string, anything. So a public diagnostic is
// built field by field here, and the CLI never serializes an internal Diagnostic.
// Adding an output path later means going through this function, not around it.

export function toPublicDiagnostic(d: Diagnostic): PublicDiagnostic {
  return { code: d.code, message: d.message, ...(d.line !== undefined ? { line: d.line } : {}) };
}

export function toPublicDiagnostics(diagnostics: Diagnostic[]): PublicDiagnostic[] {
  return diagnostics.map(toPublicDiagnostic);
}
